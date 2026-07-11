import { OpenAIError } from './errors.js';
import type { ChatCompletionRequest, LiveModel, LivePrice } from './types.js';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

function normalizeModelList(raw: any): LiveModel[] {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  return items.map((item: any) => ({ id: String(item.id ?? item.name ?? item.model), raw: item })).filter((model: LiveModel) => model.id && model.id !== 'undefined');
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizePrices(raw: any): LivePrice[] {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.prices) ? raw.prices : Array.isArray(raw?.models) ? raw.models : [];
  return items.map((item: any) => {
    const model = String(item.model ?? item.id ?? item.name);
    const providerPrices = Array.isArray(item.providers)
      ? item.providers
        .map((provider: any) => ({
          input: pickNumber(provider?.pricing?.input),
          output: pickNumber(provider?.pricing?.output),
        }))
        .filter((price: { input?: number; output?: number }) => price.input != null || price.output != null)
        .sort((a: { input?: number; output?: number }, b: { input?: number; output?: number }) =>
          (a.input ?? 0) + 3 * (a.output ?? 0) - ((b.input ?? 0) + 3 * (b.output ?? 0)))
      : [];
    const cheapest = providerPrices[0];
    return {
      model,
      inputCostPerMTok: pickNumber(item.cheapest?.input, cheapest?.input, item.inputCostPerMTok, item.input_per_mtok, item.inputPricePerMillion, item.prompt, item.input, item.input_price),
      outputCostPerMTok: pickNumber(item.cheapest?.output, cheapest?.output, item.outputCostPerMTok, item.output_per_mtok, item.outputPricePerMillion, item.completion, item.output, item.output_price),
      raw: item,
    };
  }).filter((price: LivePrice) => price.model && price.model !== 'undefined' && price.inputCostPerMTok != null && price.outputCostPerMTok != null);
}

export class SurplusClient {
  private modelCache: CacheEntry<LiveModel[]> | null = null;
  private priceCache: CacheEntry<LivePrice[]> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly cacheTtlMs: number,
    private readonly requestTimeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async getJson<T>(pathname: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: any = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      if (!response.ok) {
        throw new OpenAIError(
          typeof body?.error?.message === 'string' ? body.error.message : `Surplus ${pathname} failed with HTTP ${response.status}`,
          response.status,
          body?.error?.type ?? 'upstream_error',
          body?.error?.code ?? null,
        );
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getModels(forceRefresh = false): Promise<LiveModel[]> {
    const now = Date.now();
    if (!forceRefresh && this.modelCache && this.modelCache.expiresAt > now) return this.modelCache.value;
    const models = normalizeModelList(await this.getJson('/models'));
    this.modelCache = { value: models, expiresAt: now + this.cacheTtlMs };
    return models;
  }

  async getPrices(forceRefresh = false): Promise<LivePrice[]> {
    const now = Date.now();
    if (!forceRefresh && this.priceCache && this.priceCache.expiresAt > now) return this.priceCache.value;
    const prices = normalizePrices(await this.getJson('/prices'));
    this.priceCache = { value: prices, expiresAt: now + this.cacheTtlMs };
    return prices;
  }

  clearCache(): void {
    this.modelCache = null;
    this.priceCache = null;
  }

  async chatCompletions(request: ChatCompletionRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        let body: any = null;
        if (text) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
        throw new OpenAIError(
          typeof body?.error?.message === 'string' ? body.error.message : `Surplus chat completion failed with HTTP ${response.status}`,
          response.status,
          body?.error?.type ?? 'upstream_error',
          body?.error?.code ?? null,
        );
      }
      return response;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new OpenAIError('Surplus request timed out', 504, 'timeout_error', 'upstream_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
