/**
 * Minimal client for TypeSafe's System One endpoint (jev).
 *
 * POST https://api.typesafe.ai/v1/systemone  — docs: https://docs.typesafe.ai/api
 *
 * This sits in front of every completion, so it is built to fail open and fail fast: any error,
 * timeout, or malformed body returns null and the caller keeps the existing keyword heuristic.
 * A routing classifier must never be able to take the router down.
 */

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevNoulAnswer { type: 'noul'; noul: number }
export interface JevChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface JevScoreAnswer { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type JevFailureKind =
  | 'disabled'
  | 'timeout'
  | 'rate_limited'
  | 'overloaded'
  | 'auth'
  | 'bad_request'
  | 'network'
  | 'malformed';

/**
 * Hash for cache keys. Not cryptographic — it only needs to spread similar prompts across buckets.
 * FNV-1a 32-bit over the string, hex-encoded.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

interface CacheEntry {
  expiresAt: number;
  result: JevCallResult;
}

export interface JevFailure {
  kind: JevFailureKind;
  status?: number;
  message: string;
}

export interface JevCallResult {
  response: JevResponse | null;
  failure: JevFailure | null;
  latencyMs: number;
}

export class JevClient {
  /**
   * Short-TTL cache of successful classifications, keyed on the exact scoped state.
   *
   * Why: jev sits on the critical path of every completion (~400 ms cold). In this deployment the
   * same scoped ask recurs constantly — cron prompts, identical health pings, client retries of a
   * timed-out request. Caching turns those into ~0 ms decisions. The TTL is deliberately short so a
   * prompt's classification can't go stale against a model or threshold change for long.
   *
   * Only successful, well-formed responses are cached; failures always fall through to the
   * heuristic and are never memoised, so a transient 529 can't pin the router to the heuristic.
   */
  private readonly cache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cacheTtlMs = 0,
    private readonly cacheMaxEntries = 500,
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  /** Cache observability for /metrics and tests. */
  get cacheStats(): { size: number; hits: number; misses: number } {
    return { size: this.cache.size, hits: this.cacheHits, misses: this.cacheMisses };
  }

  private cacheKey(state: string, questions: Record<string, JevQuestion>): string {
    return `${this.model}:${fnv1a(state)}:${fnv1a(JSON.stringify(questions))}`;
  }

  private readCache(key: string): JevCallResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  private writeCache(key: string, result: JevCallResult): void {
    if (this.cacheTtlMs <= 0) return;
    // Evict oldest-inserted entries when full. Map preserves insertion order, so the first key is
    // the oldest. Re-inserts of an existing key would refresh position; we only insert on miss.
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, result });
  }

  /**
   * Evaluates `state` against `questions`. Never throws.
   *
   * Retries are deliberately omitted: jev's own SDKs retry 429/529 with backoff, but this call is
   * synchronous in the request path and a backoff would add more latency than the classification is
   * worth. One attempt, then fall back to the heuristic.
   */
  async systemOne(state: string, questions: Record<string, JevQuestion>): Promise<JevCallResult> {
    const startedAt = Date.now();
    if (!this.apiKey) {
      return { response: null, failure: { kind: 'disabled', message: 'TYPESAFE_API_KEY not configured' }, latencyMs: 0 };
    }

    const key = this.cacheTtlMs > 0 ? this.cacheKey(state, questions) : null;
    if (key) {
      const cached = this.readCache(key);
      if (cached) {
        this.cacheHits += 1;
        return { ...cached, latencyMs: 0 };
      }
      this.cacheMisses += 1;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { response: null, failure: { kind: classifyStatus(response.status), status: response.status, message: text.slice(0, 300) || `HTTP ${response.status}` }, latencyMs };
      }

      const body = await response.json().catch(() => null) as JevResponse | null;
      if (!body || typeof body !== 'object' || !body.answers) {
        return { response: null, failure: { kind: 'malformed', message: 'response missing answers' }, latencyMs };
      }
      const success: JevCallResult = { response: body, failure: null, latencyMs };
      if (key) this.writeCache(key, success);
      return success;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const err = error as Error;
      const kind: JevFailureKind = err.name === 'AbortError' ? 'timeout' : 'network';
      return { response: null, failure: { kind, message: err.message.slice(0, 300) }, latencyMs };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function classifyStatus(status: number): JevFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 422) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status >= 500) return 'overloaded';
  return 'network';
}
