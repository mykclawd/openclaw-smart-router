import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILES, evaluateProfiles, modelQuality } from '../src/evaluate.js';
import type { ModelStats } from '../src/history.js';
import type { HistoryRow, ScoreBreakdown } from '../src/types.js';

function score(partial: Partial<ScoreBreakdown>): ScoreBreakdown {
  return { capability: 0.5, cost: 0.5, latency: 0.5, history: 0.5, preferences: 0.5, total: 0.5, reasons: [], ...partial };
}

function row(id: string, selectedModel: string, scores: Record<string, ScoreBreakdown>): HistoryRow {
  return {
    id: 1,
    request_id: id,
    created_at: new Date().toISOString(),
    requested_model: 'auto',
    selected_model: selectedModel,
    routed: 1,
    category: 'general',
    complexity: 0.5,
    streaming: 0,
    status: 'success',
    latency_ms: 800,
    error_message: null,
    decision_json: JSON.stringify({ selectedModel, scores }),
  };
}

const stats: ModelStats[] = [
  { selected_model: 'strong-model', requests: 10, successes: 10, avg_latency_ms: 900, avg_rating: 0.8, feedback_count: 4 },
  { selected_model: 'flaky-cheap', requests: 10, successes: 4, avg_latency_ms: 400, avg_rating: -0.6, feedback_count: 5 },
];

describe('offline weight evaluation', () => {
  it('computes model quality from success rate and feedback', () => {
    const quality = modelQuality(stats);
    expect(quality.get('strong-model')).toBeCloseTo(1 * 0.7 + 0.9 * 0.3, 5);
    expect(quality.get('flaky-cheap')).toBeCloseTo(0.4 * 0.7 + 0.2 * 0.3, 5);
  });

  it('prefers profiles whose picks land on high-quality models', () => {
    // strong-model wins on capability, flaky-cheap wins on cost.
    const scores = {
      'strong-model': score({ capability: 0.95, cost: 0.1 }),
      'flaky-cheap': score({ capability: 0.3, cost: 0.95 }),
    };
    const rows = [row('a', 'strong-model', scores), row('b', 'strong-model', scores), row('c', 'strong-model', scores)];

    const report = evaluateProfiles(rows, stats, DEFAULT_PROFILES);
    expect(report.evaluatedRequests).toBe(3);

    const capabilityHeavy = report.results.find((result) => result.name === 'capability-heavy')!;
    const costHeavy = report.results.find((result) => result.name === 'cost-heavy')!;
    expect(capabilityHeavy.avgOutcomeQuality).toBeGreaterThan(costHeavy.avgOutcomeQuality);
    expect(costHeavy.selectionChanges).toBe(3);
    // Multiple profiles tie by always picking strong-model; the recommendation
    // must be one of them, never the cost-heavy profile that picks flaky-cheap.
    const recommended = report.results.find((result) => result.name === report.recommended)!;
    expect(recommended.avgOutcomeQuality).toBe(capabilityHeavy.avgOutcomeQuality);
    expect(report.recommended).not.toBe('cost-heavy');
  });

  it('handles empty history without recommending anything', () => {
    const report = evaluateProfiles([], stats, DEFAULT_PROFILES);
    expect(report.evaluatedRequests).toBe(0);
    expect(report.recommended).toBeNull();
  });
});
