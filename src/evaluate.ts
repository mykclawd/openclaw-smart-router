import type { ModelStats } from './history.js';
import type { HistoryRow, RoutingDecision, ScoreBreakdown, UtilityWeights } from './types.js';

export interface WeightProfile {
  name: string;
  weights: UtilityWeights;
}

export interface ProfileResult {
  name: string;
  weights: UtilityWeights;
  evaluatedRequests: number;
  avgOutcomeQuality: number;
  avgCostScore: number;
  selectionChanges: number;
}

export interface EvaluationReport {
  totalRows: number;
  evaluatedRequests: number;
  results: ProfileResult[];
  recommended: string | null;
}

export const DEFAULT_PROFILES: WeightProfile[] = [
  { name: 'balanced-default', weights: { capability: 0.45, cost: 0.25, latency: 0.10, history: 0.10, preferences: 0.10 } },
  { name: 'cost-heavy', weights: { capability: 0.30, cost: 0.45, latency: 0.10, history: 0.10, preferences: 0.05 } },
  { name: 'capability-heavy', weights: { capability: 0.65, cost: 0.10, latency: 0.10, history: 0.10, preferences: 0.05 } },
  { name: 'latency-heavy', weights: { capability: 0.35, cost: 0.20, latency: 0.30, history: 0.10, preferences: 0.05 } },
  { name: 'history-heavy', weights: { capability: 0.35, cost: 0.20, latency: 0.10, history: 0.30, preferences: 0.05 } },
];

function normalize(weights: UtilityWeights): UtilityWeights {
  const sum = weights.capability + weights.cost + weights.latency + weights.history + weights.preferences;
  if (sum <= 0) return { capability: 0.45, cost: 0.25, latency: 0.10, history: 0.10, preferences: 0.10 };
  return {
    capability: weights.capability / sum,
    cost: weights.cost / sum,
    latency: weights.latency / sum,
    history: weights.history / sum,
    preferences: weights.preferences / sum,
  };
}

function reweightedTotal(score: ScoreBreakdown, weights: UtilityWeights): number {
  return score.capability * weights.capability
    + score.cost * weights.cost
    + score.latency * weights.latency
    + score.history * weights.history
    + score.preferences * weights.preferences;
}

/**
 * Observed per-model outcome quality in [0, 1] from routing history:
 * success rate blended with average user feedback when it exists.
 */
export function modelQuality(stats: ModelStats[]): Map<string, number> {
  const quality = new Map<string, number>();
  for (const stat of stats) {
    if (stat.requests === 0) continue;
    const successRate = stat.successes / stat.requests;
    const feedback = stat.avg_rating == null ? null : (stat.avg_rating + 1) / 2;
    quality.set(stat.selected_model, feedback == null ? successRate : successRate * 0.7 + feedback * 0.3);
  }
  return quality;
}

/**
 * Replays routed decisions offline: for each weight profile, re-scores the
 * stored per-model component breakdowns and measures what the profile would
 * have selected, judged against observed model quality. No live traffic needed.
 */
export function evaluateProfiles(rows: HistoryRow[], stats: ModelStats[], profiles: WeightProfile[]): EvaluationReport {
  const quality = modelQuality(stats);
  const decisions: RoutingDecision[] = [];
  for (const row of rows) {
    if (!row.routed) continue;
    try {
      const decision = JSON.parse(row.decision_json) as RoutingDecision;
      if (decision.scores && Object.keys(decision.scores).length > 0) decisions.push(decision);
    } catch { /* skip malformed rows */ }
  }

  const results: ProfileResult[] = profiles.map((profile) => {
    const weights = normalize(profile.weights);
    let outcomeSum = 0;
    let outcomeCount = 0;
    let costSum = 0;
    let selectionChanges = 0;
    for (const decision of decisions) {
      const entries = Object.entries(decision.scores);
      const [pickedId, pickedScore] = entries.reduce((best, entry) =>
        reweightedTotal(entry[1], weights) > reweightedTotal(best[1], weights) ? entry : best);
      if (pickedId !== decision.selectedModel) selectionChanges += 1;
      costSum += pickedScore.cost;
      const observed = quality.get(pickedId);
      if (observed != null) {
        outcomeSum += observed;
        outcomeCount += 1;
      }
    }
    return {
      name: profile.name,
      weights,
      evaluatedRequests: decisions.length,
      avgOutcomeQuality: outcomeCount === 0 ? 0 : Number((outcomeSum / outcomeCount).toFixed(4)),
      avgCostScore: decisions.length === 0 ? 0 : Number((costSum / decisions.length).toFixed(4)),
      selectionChanges,
    };
  });

  const ranked = [...results].sort((a, b) => b.avgOutcomeQuality - a.avgOutcomeQuality || b.avgCostScore - a.avgCostScore);
  return {
    totalRows: rows.length,
    evaluatedRequests: decisions.length,
    results,
    recommended: decisions.length === 0 ? null : ranked[0].name,
  };
}
