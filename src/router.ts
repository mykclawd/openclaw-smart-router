import { analyzePrompt } from './analyzer.js';
import { OpenAIError } from './errors.js';
import type { ChatCompletionRequest, CandidateModel, LiveModel, LivePrice, PromptAnalysis, RoutingDecision, ScoreBreakdown, UserPreferences, UtilityWeights } from './types.js';
import type { RegistryStore } from './registry.js';
import type { HistoryStore, ModelStats } from './history.js';
import type { SurplusClient } from './surplusClient.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeWeights(weights: UtilityWeights): UtilityWeights {
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

function hasFeature(candidate: CandidateModel, feature: keyof CandidateModel['registry']['features']): boolean {
  return Boolean(candidate.registry.features[feature]);
}

const MIN_FUNDS_REASONING_CAPABILITY = 0.90;

function messageContextFits(candidate: CandidateModel, analysis: PromptAnalysis): boolean {
  // Leave room for generated tokens and tool schemas.
  return candidate.registry.contextWindow >= Math.ceil(analysis.estimatedContextTokens * 1.15 + 2048);
}

function capabilityScore(candidate: CandidateModel, analysis: PromptAnalysis): number {
  const caps = candidate.registry.capabilities;
  let score = caps.general;
  if (analysis.category === 'coding') score = (score + caps.coding * 1.8 + caps.reasoning) / 3.8;
  else if (analysis.category === 'analysis') score = (score + caps.reasoning * 1.8) / 2.8;
  else if (analysis.category === 'writing') score = (score + caps.writing * 1.8) / 2.8;
  else if (analysis.category === 'math') score = (score + caps.math * 1.5 + caps.reasoning * 1.2) / 3.7;
  else if (analysis.category === 'vision') score = (score + caps.vision * 2 + caps.reasoning * 0.5) / 3.5;
  else if (analysis.category === 'tool_use') score = (score + caps.tools * 2 + caps.reasoning * 0.5) / 3.5;
  else if (analysis.category === 'structured') score = (score + caps.structuredOutput * 1.6 + caps.reasoning * 0.4) / 3.0;
  score += (analysis.complexity - 0.5) * caps.reasoning * 0.2;
  return clamp01(score);
}

function costScore(candidate: CandidateModel, prices: LivePrice[]): number {
  const knownCosts = prices
    .map((price) => (price.inputCostPerMTok ?? 0) + (price.outputCostPerMTok ?? 0))
    .filter((value) => value > 0);
  const ownCost = (candidate.price?.inputCostPerMTok ?? 0) + (candidate.price?.outputCostPerMTok ?? 0);
  if (!ownCost || knownCosts.length === 0) return 0.5;
  const min = Math.min(...knownCosts);
  const max = Math.max(...knownCosts);
  if (max === min) return 1;
  return clamp01(1 - (ownCost - min) / (max - min));
}

function latencyScore(candidate: CandidateModel, allCandidates: CandidateModel[]): number {
  const latencies = allCandidates.map((candidateModel) => candidateModel.registry.latencyMs);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  if (max === min) return 1;
  return clamp01(1 - (candidate.registry.latencyMs - min) / (max - min));
}

function historyScore(candidate: CandidateModel, stats: ModelStats[]): number {
  const stat = stats.find((row) => row.selected_model === candidate.id);
  if (!stat || stat.requests === 0) return 0.5;
  const successRate = stat.successes / stat.requests;
  const latencyComponent = stat.avg_latency_ms == null ? 0.5 : clamp01(1 - stat.avg_latency_ms / 30000);
  // User feedback ratings are in [-1, 1]; map to [0, 1]. Neutral 0.5 when no feedback exists.
  const feedbackComponent = stat.avg_rating == null ? 0.5 : clamp01((stat.avg_rating + 1) / 2);
  return clamp01(successRate * 0.55 + latencyComponent * 0.2 + feedbackComponent * 0.25);
}

function preferenceScore(candidate: CandidateModel, preferences: UserPreferences): number {
  let score = 0.5;
  if (preferences.preferModels.includes(candidate.id)) score += 0.45;
  if (preferences.avoidModels.includes(candidate.id)) score -= 0.5;
  if (preferences.maxInputCostPerMTok != null && candidate.price?.inputCostPerMTok != null && candidate.price.inputCostPerMTok > preferences.maxInputCostPerMTok) score -= 0.35;
  if (preferences.maxOutputCostPerMTok != null && candidate.price?.outputCostPerMTok != null && candidate.price.outputCostPerMTok > preferences.maxOutputCostPerMTok) score -= 0.35;
  if (preferences.latencyBias === 'low-latency') score += clamp01(1 - candidate.registry.latencyMs / 8000) * 0.25;
  if (preferences.latencyBias === 'high-capability') score += candidate.registry.capabilities.general * 0.25;
  if (preferences.latencyBias === 'low-cost' && candidate.price) {
    const total = (candidate.price.inputCostPerMTok ?? 0) + (candidate.price.outputCostPerMTok ?? 0);
    score += total <= 2 ? 0.25 : -0.1;
  }
  return clamp01(score);
}

function roundScore(score: ScoreBreakdown): ScoreBreakdown {
  return {
    ...score,
    capability: Number(score.capability.toFixed(4)),
    cost: Number(score.cost.toFixed(4)),
    latency: Number(score.latency.toFixed(4)),
    history: Number(score.history.toFixed(4)),
    preferences: Number(score.preferences.toFixed(4)),
    total: Number(score.total.toFixed(4)),
  };
}

function clampOutputTokens(request: ChatCompletionRequest, candidate: CandidateModel): ChatCompletionRequest {
  const maxOutputTokens = candidate.registry.maxOutputTokens;
  return {
    ...request,
    model: candidate.id,
    max_tokens: request.max_tokens == null ? undefined : Math.min(request.max_tokens, maxOutputTokens),
    max_completion_tokens: request.max_completion_tokens == null ? undefined : Math.min(request.max_completion_tokens, maxOutputTokens),
  };
}

export interface SmartRouterOptions {
  routerModelIds: string[];
  utilityWeights: UtilityWeights;
  userPreferences: UserPreferences;
}

export class SmartRouter {
  constructor(
    private readonly registryStore: RegistryStore,
    private readonly surplusClient: SurplusClient,
    private readonly historyStore: HistoryStore,
    private readonly options: SmartRouterOptions,
  ) {}

  isRouterModel(model: string): boolean {
    return this.options.routerModelIds.includes(model);
  }

  getWeights(): UtilityWeights {
    return { ...this.options.utilityWeights };
  }

  setWeights(weights: UtilityWeights): UtilityWeights {
    this.options.utilityWeights = weights;
    return this.getWeights();
  }

  private buildCandidates(liveModels: LiveModel[], prices: LivePrice[]): { candidates: CandidateModel[]; rejected: Array<{ id: string; reasons: string[] }> } {
    const liveById = new Map(liveModels.map((model) => [model.id, model]));
    const priceById = new Map(prices.map((price) => [price.model, price]));
    const candidates: CandidateModel[] = [];
    const rejected: Array<{ id: string; reasons: string[] }> = [];
    for (const registry of this.registryStore.get().models) {
      const live = liveById.get(registry.id);
      const price = priceById.get(registry.id);
      const reasons: string[] = [];
      if (!live) reasons.push('not present in live Surplus model catalog');
      if (!price) reasons.push('no live Surplus pricing');
      if (!live || !price) rejected.push({ id: registry.id, reasons });
      else candidates.push({ id: registry.id, registry, live, price });
    }
    return { candidates, rejected };
  }

  private eligibleCandidates(candidates: CandidateModel[], analysis: PromptAnalysis, streaming: boolean): { eligible: CandidateModel[]; rejected: Array<{ id: string; reasons: string[] }> } {
    const eligible: CandidateModel[] = [];
    const rejected: Array<{ id: string; reasons: string[] }> = [];
    for (const candidate of candidates) {
      const reasons: string[] = [];
      if (!hasFeature(candidate, 'chat')) reasons.push('chat unsupported');
      if (streaming && !hasFeature(candidate, 'streaming')) reasons.push('streaming unsupported');
      // On a visible message_tool delivery turn the paramount requirement is delivering
      // the text reliably, not the answering capability of the turn. The prompt analyzer
      // scans the whole conversation, so a single historical image or code block can flag
      // the turn as vision/coding/structured and exclude an otherwise delivery-reliable
      // text model (e.g. claude-sonnet-5), forcing selection of a less-reliable model — or
      // an empty eligible set. For delivery turns we therefore skip these answering-capability
      // filters; vision/coding models still remain eligible and outscore text models whenever
      // the capability is genuinely needed, so this only widens (never narrows) the pool.
      const deliveryTurn = analysis.requiresMessageToolDelivery;
      if (analysis.coding && !deliveryTurn && !hasFeature(candidate, 'coding')) reasons.push('coding capability required');
      if (analysis.vision && !deliveryTurn && !hasFeature(candidate, 'vision')) reasons.push('vision capability required');
      if (analysis.tools && !hasFeature(candidate, 'tools')) reasons.push('tool calling required');
      if (analysis.structuredOutput && !deliveryTurn && !hasFeature(candidate, 'structuredOutput')) reasons.push('structured output required');
      if (analysis.requiresMessageToolDelivery && candidate.registry.delivery.messageToolReliable === false) reasons.push('message_tool delivery reliability required');
      if (analysis.fundsMovementRisk && candidate.registry.capabilities.reasoning < MIN_FUNDS_REASONING_CAPABILITY) reasons.push('funds movement requires reasoning-capable model');
      if (!messageContextFits(candidate, analysis)) reasons.push('context window too small');
      const preferences = this.options.userPreferences;
      if (preferences.maxInputCostPerMTok != null && candidate.price?.inputCostPerMTok != null && candidate.price.inputCostPerMTok > preferences.maxInputCostPerMTok) reasons.push('input price exceeds user maximum');
      if (preferences.maxOutputCostPerMTok != null && candidate.price?.outputCostPerMTok != null && candidate.price.outputCostPerMTok > preferences.maxOutputCostPerMTok) reasons.push('output price exceeds user maximum');
      if (reasons.length) rejected.push({ id: candidate.id, reasons });
      else eligible.push(candidate);
    }
    return { eligible, rejected };
  }

  private scoreCandidates(candidates: CandidateModel[], prices: LivePrice[], analysis: PromptAnalysis): Record<string, ScoreBreakdown> {
    const weights = normalizeWeights(this.options.utilityWeights);
    const stats = this.historyStore.modelStats();
    const scores: Record<string, ScoreBreakdown> = {};
    for (const candidate of candidates) {
      const capability = capabilityScore(candidate, analysis);
      const cost = costScore(candidate, prices);
      const latency = latencyScore(candidate, candidates);
      const history = historyScore(candidate, stats);
      const preferences = preferenceScore(candidate, this.options.userPreferences);
      const total = capability * weights.capability + cost * weights.cost + latency * weights.latency + history * weights.history + preferences * weights.preferences;
      const reasons = [
        `capability=${capability.toFixed(3)} weight=${weights.capability.toFixed(2)}`,
        `cost=${cost.toFixed(3)} weight=${weights.cost.toFixed(2)}`,
        `latency=${latency.toFixed(3)} weight=${weights.latency.toFixed(2)}`,
        `history=${history.toFixed(3)} weight=${weights.history.toFixed(2)}`,
        `preferences=${preferences.toFixed(3)} weight=${weights.preferences.toFixed(2)}`,
      ];
      scores[candidate.id] = roundScore({ capability, cost, latency, history, preferences, total, reasons });
    }
    return scores;
  }

  async route(request: ChatCompletionRequest, requestId: string): Promise<{ decision: RoutingDecision; upstreamRequest: ChatCompletionRequest }> {
    const analysis = analyzePrompt(request);
    const [liveModels, prices] = await Promise.all([
      this.surplusClient.getModels(),
      this.surplusClient.getPrices(),
    ]);
    const built = this.buildCandidates(liveModels, prices);
    const candidates = built.candidates;
    const requestedModel = request.model;
    const streaming = Boolean(request.stream);

    if (!this.isRouterModel(requestedModel)) {
      const explicit = candidates.find((candidate) => candidate.id === requestedModel);
      if (!explicit) {
        throw new OpenAIError(`Model '${requestedModel}' is not available or not present in capability registry`, 404, 'invalid_request_error', 'model_not_found', 'model');
      }
      const eligibility = this.eligibleCandidates([explicit], analysis, streaming);
      if (eligibility.eligible.length === 0) {
        throw new OpenAIError(`Model '${requestedModel}' is not eligible for this request's required capabilities`, 400, 'invalid_request_error', 'model_not_eligible', 'model');
      }
      const scores = this.scoreCandidates([explicit], prices, analysis);
      const decision = this.makeDecision(requestId, requestedModel, explicit.id, false, [explicit.id], built.rejected, analysis, scores, 'explicit eligible model honored');
      decision.selectedModelPrice = explicit.price;
      return { decision, upstreamRequest: clampOutputTokens(request, explicit) };
    }

    const eligibility = this.eligibleCandidates(candidates, analysis, streaming);
    const eligible = eligibility.eligible;
    if (eligible.length === 0) {
      throw new OpenAIError('No eligible Surplus model found for this request and registry constraints', 400, 'invalid_request_error', 'no_eligible_model', 'model');
    }
    const scores = this.scoreCandidates(eligible, prices, analysis);
    const selected = [...eligible].sort((a, b) => scores[b.id].total - scores[a.id].total || a.id.localeCompare(b.id))[0];
    const decision = this.makeDecision(
      requestId,
      requestedModel,
      selected.id,
      true,
      eligible.map((candidate) => candidate.id),
      [...built.rejected, ...eligibility.rejected],
      analysis,
      scores,
      `selected highest utility model ${selected.id}`,
    );
    decision.selectedModelPrice = selected.price;
    return { decision, upstreamRequest: clampOutputTokens(request, selected) };
  }

  private makeDecision(
    requestId: string,
    requestedModel: string,
    selectedModel: string,
    routed: boolean,
    eligibleModels: string[],
    rejectedModels: Array<{ id: string; reasons: string[] }>,
    analysis: PromptAnalysis,
    scores: Record<string, ScoreBreakdown>,
    reason: string,
  ): RoutingDecision {
    return {
      requestId,
      requestedModel,
      selectedModel,
      routed,
      eligibleModels,
      rejectedModels,
      analysis,
      scores,
      reason,
      createdAt: new Date().toISOString(),
    };
  }
}
