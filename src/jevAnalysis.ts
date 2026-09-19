import { hasCodingKeywords } from './analyzer.js';
import type { JevAnswer, JevCallResult, JevClient, JevQuestion, JevScoreAnswer, JevNoulAnswer, JevChoiceAnswer } from './jevClient.js';
import { scopePromptForJev } from './promptScope.js';
import type { ChatCompletionRequest, PromptAnalysis, PromptCategory } from './types.js';

/**
 * jev-backed prompt classification.
 *
 * DIVISION OF LABOUR — jev only answers what code cannot compute exactly. Its docs are explicit:
 * "avoid asking the model something code can compute exactly". So these stay in code and are never
 * sent to jev:
 *   - `tools`                        -> request.tools / request.functions is structurally present
 *   - `vision`                       -> an image_url part is structurally present
 *   - `structuredOutput`             -> request.response_format is structurally present
 *   - `estimatedContextTokens`       -> arithmetic over message lengths
 *   - `requiresMessageToolDelivery`  -> string match on the OpenClaw envelope (see promptScope.ts)
 *
 * jev answers the three genuine judgments the keyword matcher was failing at:
 *   - how much reasoning the ask actually needs (Score)
 *   - whether the ask really moves funds (Noul)
 *   - what kind of work it is (Choice)
 */

/** Ordered reasoning levels. Index is the score value jev returns. */
export const REASONING_LEVELS = [
  'A greeting, acknowledgement, or a single fact lookup that needs no working out',
  'One straightforward step: reformat text, answer a direct factual question, or run one obvious command',
  'Several routine steps that a competent person would do without much thought',
  'Careful multi-step work: debugging, weighing trade-offs, designing something, or reasoning under constraints',
  'Deep original problem solving: novel design, subtle proofs, or research with no established method',
];

export const DOMAIN_OPTIONS: Record<string, string> = {
  coding: 'Writing, reading, debugging, or reviewing software, configuration, or queries',
  analysis: 'Investigating, comparing, planning, or explaining how or why something works',
  math: 'Calculation, statistics, probability, or symbolic mathematics',
  writing: 'Composing or editing prose for a human audience, where tone and wording matter',
  general: 'Conversation, simple lookups, or anything the other options do not describe',
};

export function buildQuestions(): Record<string, JevQuestion> {
  return {
    reasoning_tier: {
      type: 'score',
      instructions: 'Rate how much careful reasoning is needed to produce a correct, complete answer to the request in the state.',
      criteria: REASONING_LEVELS,
    },
    funds_movement: {
      type: 'noul',
      instructions: 'The request asks to move, send, swap, approve, or otherwise spend real money or crypto assets belonging to someone.',
      criteria: {
        true: 'The request would cause a real transfer, trade, token approval, or signed on-chain transaction',
        false: 'The request only reads, reports on, explains, or simulates. Discussing or analysing money without moving it is false.',
      },
    },
    domain: {
      type: 'choice',
      instructions: 'What kind of work does the request in the state mainly call for?',
      criteria: DOMAIN_OPTIONS,
    },
  };
}

export interface JevAnalysis {
  /** Continuous 0..4 expectation from jev. */
  reasoningScore: number;
  /** Integer tier after confidence-gated rounding. */
  reasoningTier: number;
  reasoningConfidence: number;
  fundsMovement: boolean;
  fundsMovementProbability: number;
  domain: string;
  domainConfidence: number;
  latencyMs: number;
  /** The scoped state jev actually saw — persisted in shadow mode to build a labelled set. */
  state: string;
  strippedChars: number;
  model: string;
}

/**
 * Confidence gates. Both fail toward the SAFE side, and safe means "spend more, not less":
 *
 *  - reasoning tier: when jev is unsure, round the expectation UP. A too-capable model costs money;
 *    a too-weak model produces a bad answer the user has to notice and redo.
 *  - funds movement: when jev is unsure, treat it as risky. A false negative here can let a weak
 *    model drive a real transaction; a false positive only narrows the candidate pool.
 */
export const LOW_CONFIDENCE = 0.55;
export const FUNDS_YES = 0.5;
export const FUNDS_UNSURE_FLOOR = 0.25;

function isScore(answer: JevAnswer | undefined): answer is JevScoreAnswer {
  return Boolean(answer && answer.type === 'score');
}
function isNoul(answer: JevAnswer | undefined): answer is JevNoulAnswer {
  return Boolean(answer && answer.type === 'noul');
}
function isChoice(answer: JevAnswer | undefined): answer is JevChoiceAnswer {
  return Boolean(answer && answer.type === 'choice');
}

export function interpret(result: JevCallResult, state: string, strippedChars: number): JevAnalysis | null {
  if (!result.response) return null;
  const answers = result.response.answers;

  const scoreAnswer = answers.reasoning_tier;
  const noulAnswer = answers.funds_movement;
  const choiceAnswer = answers.domain;
  if (!isScore(scoreAnswer)) return null;

  const reasoningConfidence = scoreAnswer.confidence ?? 0;
  // Threshold the expectation only. jev's docs warn score levels are weakly calibrated numerically,
  // so the raw value is used for a tier decision and never interpolated into a magnitude.
  const reasoningTier = reasoningConfidence < LOW_CONFIDENCE
    ? Math.min(REASONING_LEVELS.length - 1, Math.ceil(scoreAnswer.score))
    : Math.min(REASONING_LEVELS.length - 1, Math.max(0, Math.round(scoreAnswer.score)));

  const fundsProbability = isNoul(noulAnswer) ? noulAnswer.noul : 0;
  // Above FUNDS_YES is a yes. Between the unsure floor and FUNDS_YES we still treat it as risky:
  // the gate it controls only restricts model choice, so the asymmetry is cheap.
  const fundsMovement = fundsProbability >= FUNDS_UNSURE_FLOOR;

  return {
    reasoningScore: scoreAnswer.score,
    reasoningTier,
    reasoningConfidence,
    fundsMovement,
    fundsMovementProbability: fundsProbability,
    domain: isChoice(choiceAnswer) ? choiceAnswer.choice : 'general',
    domainConfidence: isChoice(choiceAnswer) ? choiceAnswer.confidence ?? 0 : 0,
    latencyMs: result.latencyMs,
    state,
    strippedChars,
    model: result.response.model,
  };
}

export async function classifyWithJev(client: JevClient, request: ChatCompletionRequest, maxStateChars: number): Promise<{ analysis: JevAnalysis | null; failure: JevCallResult['failure'] | { kind: 'empty_state'; message: string } | null }> {
  if (!client.enabled) return { analysis: null, failure: { kind: 'disabled', message: 'TYPESAFE_API_KEY not configured' } };

  const scoped = scopePromptForJev(request, maxStateChars);
  if (scoped.empty) {
    // Nothing survived envelope stripping — there is no user ask to classify.
    return { analysis: null, failure: { kind: 'empty_state', message: 'no user content after envelope stripping' } };
  }

  const result = await client.systemOne(scoped.state, buildQuestions());
  if (!result.response) return { analysis: null, failure: result.failure };

  const analysis = interpret(result, scoped.state, scoped.strippedChars);
  if (!analysis) return { analysis: null, failure: { kind: 'malformed', message: 'missing or mistyped reasoning_tier answer' } };
  return { analysis, failure: null };
}

/** Maps a reasoning tier to the minimum registry `capabilities.reasoning` a model must have. */
export const TIER_REASONING_FLOOR = [0.0, 0.35, 0.55, 0.75, 0.90];

/** Maps a jev domain to the router's existing PromptCategory vocabulary. */
function domainToCategory(domain: string): PromptCategory | null {
  switch (domain) {
    case 'coding': return 'coding';
    case 'analysis': return 'analysis';
    case 'math': return 'math';
    case 'writing': return 'writing';
    case 'general': return 'general';
    default: return null;
  }
}

/**
 * Overlays jev's judgments onto the heuristic analysis.
 *
 * Structural facts from the request (vision, tools, structuredOutput, context size, delivery) always
 * win — jev never saw them and they are not judgments. Category precedence matches the heuristic's
 * own ordering, where vision and tool_use are capability requirements rather than topic labels.
 */
export function mergeJevIntoAnalysis(base: PromptAnalysis, jev: JevAnalysis): PromptAnalysis {
  const complexity = Math.max(0, Math.min(1, jev.reasoningTier / (REASONING_LEVELS.length - 1)));

  let category: PromptCategory = base.category;
  if (!base.vision && !base.tools && !base.structuredOutput) {
    category = domainToCategory(jev.domain) ?? base.category;
  }

  return {
    ...base,
    category,
    complexity,
    // Union, not replacement: see hasCodingKeywords. The keyword check runs against the SCOPED
    // state, so it no longer inherits the envelope false positives that broke the original signal.
    coding: jev.domain === 'coding' || hasCodingKeywords(jev.state),
    fundsMovementRisk: jev.fundsMovement,
    reasons: [
      ...base.reasons.filter((reason) => !reason.startsWith('complexity ')),
      `jev reasoning tier ${jev.reasoningTier} (score ${jev.reasoningScore.toFixed(2)}, confidence ${jev.reasoningConfidence.toFixed(2)})`,
      `jev domain ${jev.domain} (confidence ${jev.domainConfidence.toFixed(2)})`,
      `jev funds movement p=${jev.fundsMovementProbability.toFixed(3)} -> ${jev.fundsMovement}`,
      `complexity ${complexity.toFixed(2)}`,
    ],
  };
}
