import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.js';
import type { RoutingDecision } from '../src/types.js';

const registry = {
  version: 1,
  models: [
    {
      id: 'cheap-fast',
      features: { chat: true, streaming: true, coding: false, vision: false, tools: true, structuredOutput: true },
      contextWindow: 200000,
      latencyMs: 500,
      capabilities: { general: 0.55, coding: 0.1, reasoning: 0.35, writing: 0.6, math: 0.3, vision: 0, tools: 0.8, structuredOutput: 0.7 },
    },
    {
      id: 'code-pro',
      features: { chat: true, streaming: true, coding: true, vision: true, tools: true, structuredOutput: true },
      contextWindow: 200000,
      latencyMs: 2500,
      capabilities: { general: 0.9, coding: 0.98, reasoning: 0.93, writing: 0.85, math: 0.9, vision: 0.8, tools: 0.85, structuredOutput: 0.86 },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** jev answer fixture: tier, funds probability, domain. */
function jevBody(score: number, confidence: number, noul: number, domain: string) {
  return {
    model: 'jev-1.13.0',
    answers: {
      reasoning_tier: { type: 'score', score, confidence, legend: {}, probabilities: {} },
      funds_movement: { type: 'noul', noul },
      domain: { type: 'choice', choice: domain, probabilities: {}, confidence: 0.9 },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function makeFetch(jev: { body?: unknown; status?: number; hang?: boolean } = {}) {
  const calls: Array<{ url: string; body?: any }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit & { signal?: AbortSignal }) => {
    const url = String(input);
    let body: any;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, body });

    if (url.includes('typesafe') || url.endsWith('/systemone')) {
      if (jev.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return jsonResponse(jev.body ?? jevBody(1, 0.9, 0.01, 'general'), jev.status ?? 200);
    }
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'cheap-fast' }, { id: 'code-pro' }] });
    if (url.endsWith('/prices')) return jsonResponse({ models: [
      { model: 'cheap-fast', providers: [{ provider: 'test', pricing: { input: 0.1, output: 0.2 } }] },
      { model: 'code-pro', providers: [{ provider: 'test', pricing: { input: 3, output: 12 } }] },
    ] });
    if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    throw new Error(`Unexpected URL ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function makeApp(fetchImpl: typeof fetch, extraConfig: Record<string, unknown> = {}, registryDoc: unknown = registry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'smart-router-jev-'));
  const registryPath = path.join(dir, 'models.json');
  await writeFile(registryPath, JSON.stringify(registryDoc));
  const { app, services } = await buildApp({
    logger: false,
    fetchImpl,
    config: {
      surplusBaseUrl: 'https://mock.surplus/v1',
      surplusApiKey: 'test-key',
      capabilityRegistryPath: registryPath,
      sqlitePath: ':memory:',
      cacheTtlMs: 1000,
      requestTimeoutMs: 5000,
      routerModelIds: ['surplus-smart-router', 'auto'],
      utilityWeights: { capability: 0.45, cost: 0.25, latency: 0.10, history: 0.10, preferences: 0.10 },
      userPreferences: { preferModels: [], avoidModels: [], latencyBias: 'balanced' },
      jevBaseUrl: 'https://api.typesafe.ai/v1',
      jevApiKey: 'test-jev-key',
      jevModel: 'jev-latest',
      jevTimeoutMs: 50,
      jevMaxStateChars: 12000,
      ...extraConfig,
    },
  });
  return { app, services, cleanup: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** A prompt the keyword heuristic misreads: a trivial ask wrapped in OpenClaw's envelope. */
const TRIVIAL_ASK = {
  model: 'surplus-smart-router',
  messages: [
    { role: 'system', content: 'You are running inside OpenClaw. Code changes in code blocks. Never send a token or approve a transaction from the wallet without confirming. Run unit test and build before claiming success.' },
    { role: 'user', content: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"chat_id":"x"}\n```\n\nwhat time is it?' },
  ],
};

function storedDecision(services: any, requestId?: string): RoutingDecision {
  const rows = services.historyStore.list(10);
  const row = requestId ? rows.find((r: any) => r.request_id === requestId) : rows[0];
  return JSON.parse(row.decision_json) as RoutingDecision;
}

const apps: Array<() => Promise<void>> = [];
afterEach(async () => { while (apps.length) await apps.pop()?.(); });

describe('jev integration', () => {
  it('shadow mode records jev but does NOT change the decision', async () => {
    const { fetchImpl, calls } = makeFetch({ body: jevBody(0, 0.95, 0.01, 'general') });
    const ctx = await makeApp(fetchImpl, { jevMode: 'shadow' });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);

    expect(calls.some((call) => call.url.endsWith('/systemone'))).toBe(true);
    const decision = storedDecision(ctx.services);
    expect(decision.jev?.mode).toBe('shadow');
    expect(decision.jev?.applied).toBe(false);
    expect(decision.jev?.analysis?.reasoningTier).toBe(0);
    // The heuristic still drives: its false funds-risk flag is recorded, and complexity stays saturated.
    expect(decision.jev?.heuristic.fundsMovementRisk).toBe(true);
    expect(decision.analysis.fundsMovementRisk).toBe(true);
    expect(decision.analysis.complexity).toBeGreaterThan(0.99);
  });

  it('live mode applies jev and sends a trivial ask to the cheap model', async () => {
    const { fetchImpl } = makeFetch({ body: jevBody(0, 0.95, 0.01, 'general') });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);

    const decision = storedDecision(ctx.services);
    expect(decision.jev?.applied).toBe(true);
    // jev clears the keyword false positive, which un-blocks the sub-0.90-reasoning models.
    expect(decision.analysis.fundsMovementRisk).toBe(false);
    expect(decision.analysis.complexity).toBe(0);
    expect(decision.selectedModel).toBe('cheap-fast');
  });

  it('live mode keeps a hard-reasoning ask on the capable model', async () => {
    const { fetchImpl } = makeFetch({ body: jevBody(4, 0.95, 0.01, 'coding') });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' });
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    const decision = storedDecision(ctx.services);
    expect(decision.selectedModel).toBe('code-pro');
    expect(decision.analysis.reasoningFloor).toBe(0.90);
    // cheap-fast must be rejected for the tier, not for some incidental reason.
    const rejected = decision.rejectedModels.find((entry) => entry.id === 'cheap-fast');
    expect(rejected?.reasons.some((reason) => reason.includes('reasoning tier'))).toBe(true);
  });

  it('live mode still gates funds movement onto a reasoning-capable model', async () => {
    const { fetchImpl } = makeFetch({ body: jevBody(1, 0.95, 0.97, 'general') });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' });
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    const decision = storedDecision(ctx.services);
    expect(decision.analysis.fundsMovementRisk).toBe(true);
    // Low reasoning tier, but the funds gate must still exclude the weak model.
    expect(decision.selectedModel).toBe('code-pro');
  });

  it('fails open to the heuristic when jev times out, and the request still succeeds', async () => {
    const { fetchImpl } = makeFetch({ hang: true });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live', jevTimeoutMs: 20 });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);

    const decision = storedDecision(ctx.services);
    expect(decision.jev?.applied).toBe(false);
    expect(decision.jev?.failure?.kind).toBe('timeout');
    // Heuristic behaviour is unchanged on the fallback path.
    expect(decision.analysis.fundsMovementRisk).toBe(true);
  });

  it('fails open when jev returns 401, and the request still succeeds', async () => {
    const { fetchImpl } = makeFetch({ status: 401, body: { error: 'bad key' } });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);
    expect(storedDecision(ctx.services).jev?.failure?.kind).toBe('auth');
  });

  it('never calls jev when the mode is off', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl, { jevMode: 'off' });
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(calls.some((call) => call.url.endsWith('/systemone'))).toBe(false);
    expect(storedDecision(ctx.services).jev).toBeUndefined();
  });

  it('sends jev the scoped ask, not the OpenClaw envelope', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl, { jevMode: 'shadow' });
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    const jevCall = calls.find((call) => call.url.endsWith('/systemone'));
    expect(jevCall?.body.state).toBe('what time is it?');
    expect(jevCall?.body.state).not.toContain('wallet');
    expect(jevCall?.body.model).toBe('jev-latest');
  });
});

describe('just-in-time live capability gate', () => {
  function makeFetchWithFeatures(features: Record<string, string[]>) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      // domain 'analysis' so the coding-feature filter doesn't confound the reasoning gate.
      if (url.endsWith('/systemone')) return jsonResponse(jevBody(4, 0.95, 0.01, 'analysis'));
      if (url.endsWith('/models')) {
        return jsonResponse({ data: [
          { id: 'cheap-fast', supported_features: features['cheap-fast'] ?? [], context_length: 200000 },
          { id: 'code-pro', supported_features: features['code-pro'] ?? [], context_length: 200000 },
        ] });
      }
      if (url.endsWith('/prices')) return jsonResponse({ models: [
        { model: 'cheap-fast', providers: [{ provider: 't', pricing: { input: 0.1, output: 0.2 } }] },
        { model: 'code-pro', providers: [{ provider: 't', pricing: { input: 3, output: 12 } }] },
      ] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    return fetchImpl;
  }

  it('excludes a model the live listing says cannot reason, even if the registry claims it can', async () => {
    // Both models clear the registry tier floor, so the ONLY thing separating them is the live
    // listing. That keeps the floor-relaxation path out of the way and isolates the gate.
    const bothCapable = {
      version: 1,
      models: registry.models.map((model) => ({
        ...model,
        features: { ...model.features, coding: true },
        capabilities: { ...model.capabilities, reasoning: 0.95 },
      })),
    };
    const fetchImpl = makeFetchWithFeatures({ 'cheap-fast': ['tools', 'reasoning'], 'code-pro': ['tools'] });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' }, bothCapable);
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    const decision = storedDecision(ctx.services);
    const rejected = decision.rejectedModels.find((entry) => entry.id === 'code-pro');
    expect(rejected?.reasons).toContain('live Surplus listing does not advertise reasoning');
    // The survivor is the one the live catalog actually says can reason.
    expect(decision.selectedModel).toBe('cheap-fast');
  });

  it('relaxes the tier floor rather than failing when no model meets it', async () => {
    // Tier 4 demands reasoning >= 0.90; neither registry model qualifies. The request must still
    // succeed — the tier floor is an optimisation, not a safety gate.
    const weak = {
      version: 1,
      models: registry.models.map((model) => ({ ...model, capabilities: { ...model.capabilities, reasoning: 0.4 } })),
    };
    const fetchImpl = makeFetchWithFeatures({ 'cheap-fast': ['tools', 'reasoning'], 'code-pro': ['tools', 'reasoning'] });
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' }, weak);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);
    const decision = storedDecision(ctx.services);
    expect(decision.analysis.reasons).toContain('reasoning tier floor relaxed: no model met it');
  });

  it('widens the pool to a live-only model when JIT catalog is on, picking it when it wins on price', async () => {
    // 'bargain-new' exists only in the live Surplus catalog — no registry entry. It is cheap and
    // live-advertises reasoning. With JIT widening on, it must enter the pool and win on cost.
    const liveOnly = {
      id: 'bargain-new',
      context_length: 200000,
      architecture: { modality: 'text->text', input_modalities: ['text'] },
      top_provider: { context_length: 200000, max_completion_tokens: 8192 },
      supported_features: ['streaming', 'tools', 'reasoning'],
      supported_parameters: ['tools', 'response_format'],
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/systemone')) return jsonResponse(jevBody(1, 0.95, 0.01, 'general'));
      if (url.endsWith('/models')) return jsonResponse({ data: [
        { id: 'cheap-fast', supported_features: ['tools'], context_length: 200000, architecture: { modality: 'text->text', input_modalities: ['text'] } },
        { id: 'code-pro', supported_features: ['tools', 'reasoning'], context_length: 200000, architecture: { modality: 'text->text', input_modalities: ['text'] } },
        liveOnly,
      ] });
      if (url.endsWith('/prices')) return jsonResponse({ models: [
        { model: 'cheap-fast', providers: [{ provider: 't', pricing: { input: 2, output: 8 } }] },
        { model: 'code-pro', providers: [{ provider: 't', pricing: { input: 3, output: 12 } }] },
        { model: 'bargain-new', providers: [{ provider: 't', pricing: { input: 0.01, output: 0.02 } }] },
      ] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    // Cost-heavy weights: the operator tuning that makes dynamic pricing decisive. With default
    // capability-first weights the hand-scored models win on capability; with cost dominant, the
    // live-only model's price advantage is what surfaces it.
    const ctx = await makeApp(fetchImpl, {
      jevMode: 'live',
      jevJitCatalog: true,
      utilityWeights: { capability: 0.15, cost: 0.6, latency: 0.05, history: 0.1, preferences: 0.1 },
    });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);
    const decision = storedDecision(ctx.services);
    // The live-only model was eligible and won on price.
    expect(decision.eligibleModels).toContain('bargain-new');
    expect(decision.selectedModel).toBe('bargain-new');
    expect(decision.scores['bargain-new'].cost).toBe(1);
  });

  it('does NOT widen the pool in shadow mode even when JIT catalog is on', async () => {
    const liveOnly = {
      id: 'bargain-new',
      context_length: 200000,
      architecture: { modality: 'text->text', input_modalities: ['text'] },
      top_provider: { context_length: 200000, max_completion_tokens: 8192 },
      supported_features: ['streaming', 'tools', 'reasoning'],
      supported_parameters: ['tools'],
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/systemone')) return jsonResponse(jevBody(1, 0.95, 0.01, 'general'));
      if (url.endsWith('/models')) return jsonResponse({ data: [
        { id: 'cheap-fast', supported_features: ['tools'], context_length: 200000, architecture: { modality: 'text->text' } },
        { id: 'code-pro', supported_features: ['tools', 'reasoning'], context_length: 200000, architecture: { modality: 'text->text' } },
        liveOnly,
      ] });
      if (url.endsWith('/prices')) return jsonResponse({ models: [
        { model: 'cheap-fast', providers: [{ provider: 't', pricing: { input: 0.1, output: 0.2 } }] },
        { model: 'code-pro', providers: [{ provider: 't', pricing: { input: 3, output: 12 } }] },
        { model: 'bargain-new', providers: [{ provider: 't', pricing: { input: 0.01, output: 0.02 } }] },
      ] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const ctx = await makeApp(fetchImpl, { jevMode: 'shadow', jevJitCatalog: true });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);
    const decision = storedDecision(ctx.services);
    // Widening is gated to live mode: the live-only model must NOT appear in shadow mode.
    expect(decision.eligibleModels).not.toContain('bargain-new');
    // Sanity: in shadow mode the heuristic's funds false-positive gates cheap-fast out, leaving code-pro.
    expect(decision.selectedModel).toBe('code-pro');
  });

  it('does NOT widen the pool when JIT catalog is off, even in live mode', async () => {
    const liveOnly = {
      id: 'bargain-new',
      context_length: 200000,
      architecture: { modality: 'text->text', input_modalities: ['text'] },
      top_provider: { context_length: 200000, max_completion_tokens: 8192 },
      supported_features: ['streaming', 'tools', 'reasoning'],
      supported_parameters: ['tools'],
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/systemone')) return jsonResponse(jevBody(1, 0.95, 0.01, 'general'));
      if (url.endsWith('/models')) return jsonResponse({ data: [
        { id: 'cheap-fast', supported_features: ['tools'], context_length: 200000, architecture: { modality: 'text->text' } },
        liveOnly,
      ] });
      if (url.endsWith('/prices')) return jsonResponse({ models: [
        { model: 'cheap-fast', providers: [{ provider: 't', pricing: { input: 0.1, output: 0.2 } }] },
        { model: 'bargain-new', providers: [{ provider: 't', pricing: { input: 0.01, output: 0.02 } }] },
      ] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const ctx = await makeApp(fetchImpl, { jevMode: 'live', jevJitCatalog: false });
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    const decision = storedDecision(ctx.services);
    expect(decision.eligibleModels).not.toContain('bargain-new');
  });

  it('fails open when the live listing omits supported_features entirely', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/systemone')) return jsonResponse(jevBody(4, 0.95, 0.01, 'coding'));
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'cheap-fast' }, { id: 'code-pro' }] });
      if (url.endsWith('/prices')) return jsonResponse({ models: [
        { model: 'cheap-fast', providers: [{ provider: 't', pricing: { input: 0.1, output: 0.2 } }] },
        { model: 'code-pro', providers: [{ provider: 't', pricing: { input: 3, output: 12 } }] },
      ] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const ctx = await makeApp(fetchImpl, { jevMode: 'live' });
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: TRIVIAL_ASK });
    expect(response.statusCode).toBe(200);
    // Missing metadata must not empty the pool; the registry floor alone still applies.
    expect(storedDecision(ctx.services).selectedModel).toBe('code-pro');
  });
});
