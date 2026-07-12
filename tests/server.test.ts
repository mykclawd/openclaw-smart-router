import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.js';

interface MockFetchCall {
  url: string;
  init?: RequestInit;
  body?: any;
}

const registry = {
  version: 1,
  models: [
    {
      id: 'cheap-fast',
      features: { chat: true, streaming: true, coding: false, vision: false, tools: false, structuredOutput: true },
      contextWindow: 64000,
      latencyMs: 500,
      capabilities: { general: 0.55, coding: 0.1, reasoning: 0.35, writing: 0.6, math: 0.3, vision: 0, tools: 0, structuredOutput: 0.7 },
    },
    {
      id: 'code-pro',
      features: { chat: true, streaming: true, coding: true, vision: true, tools: true, structuredOutput: true },
      contextWindow: 200000,
      latencyMs: 2500,
      capabilities: { general: 0.9, coding: 0.98, reasoning: 0.93, writing: 0.85, math: 0.9, vision: 0.8, tools: 0.85, structuredOutput: 0.86 },
    },
    {
      id: 'offline-model',
      features: { chat: true, streaming: true, coding: true, vision: false, tools: false, structuredOutput: true },
      contextWindow: 32000,
      latencyMs: 1000,
      capabilities: { general: 0.7, coding: 0.7, reasoning: 0.7, writing: 0.7, math: 0.7, vision: 0, tools: 0, structuredOutput: 0.7 },
    },
  ],
};

async function makeApp(fetchImpl: typeof fetch, extraConfig: Record<string, unknown> = {}, registryDoc: unknown = registry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'smart-router-test-'));
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
      ...extraConfig,
    },
  });
  return { app, services, registryPath, cleanup: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(text: string): Response {
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeFetch(overrides: Partial<Record<string, Response | ((url: string, init?: RequestInit) => Response | Promise<Response>)>> = {}) {
  const calls: MockFetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: any;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, init, body });
    for (const [suffix, response] of Object.entries(overrides)) {
      if (url.endsWith(suffix)) return typeof response === 'function' ? response(url, init) : response.clone();
    }
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'cheap-fast' }, { id: 'code-pro' }] });
    if (url.endsWith('/prices')) return jsonResponse({ models: [
      { model: 'cheap-fast', providers: [{ provider: 'test', pricing: { input: 0.1, output: 0.2 } }] },
      { model: 'code-pro', providers: [{ provider: 'test', pricing: { input: 3, output: 12 } }] },
    ] });
    if (url.endsWith('/chat/completions')) return jsonResponse({ id: 'chatcmpl-test', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const apps: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()?.();
});

describe('OpenClaw Smart Router server', () => {
  it('routes non-streaming auto requests to an eligible coding model and records history', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'surplus-smart-router',
        messages: [{ role: 'user', content: 'Write TypeScript code with Vitest tests for a parser.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-selected-model']).toBe('code-pro');
    expect(JSON.parse(response.body).choices[0].message.content).toBe('[model: code-pro]\n\nok');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('code-pro');
    expect(chatCall?.body.messages[0].content).toBe('Write TypeScript code with Vitest tests for a parser.');

    const history = await ctx.app.inject({ method: 'GET', url: '/routing-history' });
    expect(history.statusCode).toBe(200);
    const parsed = JSON.parse(history.body);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].selected_model).toBe('code-pro');
    expect(parsed.data[0].routed).toBe(true);
    expect(parsed.data[0].decision.analysis.coding).toBe(true);
    expect(parsed.data[0].decision.scores['code-pro'].total).toBeGreaterThan(0);
    expect(parsed.data[0].decision.rejectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cheap-fast', reasons: expect.arrayContaining(['coding capability required']) }),
      expect.objectContaining({ id: 'offline-model', reasons: expect.arrayContaining(['not present in live Surplus model catalog']) }),
    ]));
  });

  it('passes SSE streaming bytes through mocked Surplus endpoint', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const { fetchImpl, calls } = makeFetch({ '/chat/completions': sseResponse(sse) });
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'Say hi briefly.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"content":"[model: cheap-fast]\\n\\nhi"');
    expect(response.body).toContain('data: [DONE]');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.stream).toBe(true);
  });

  it('honors explicit eligible real model without routing', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cheap-fast',
        messages: [{ role: 'user', content: 'Say hello.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-routed']).toBe('false');
    expect(JSON.parse(response.body).choices[0].message.content).toBe('[model: cheap-fast]\n\nok');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('cheap-fast');
  });

  it('caps forwarded output token limits to the selected model maximum', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        max_tokens: 200000,
        max_completion_tokens: 150000,
        messages: [{ role: 'user', content: 'Write TypeScript code with Vitest tests for a parser.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-selected-model']).toBe('code-pro');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('code-pro');
    expect(chatCall?.body.max_tokens).toBe(64000);
    expect(chatCall?.body.max_completion_tokens).toBe(64000);
  });

  it('excludes message_tool-unreliable models for visible Discord delivery prompts', async () => {
    const deliveryRegistry = {
      ...registry,
      models: registry.models.map((model) => {
        if (model.id === 'cheap-fast') {
          return {
            ...model,
            features: { ...model.features, tools: true },
            capabilities: { ...model.capabilities, tools: 0.7 },
          };
        }
        if (model.id === 'code-pro') {
          return {
            ...model,
            delivery: { messageToolReliable: false },
          };
        }
        return model;
      }),
    };
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl, {}, deliveryRegistry);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{
          role: 'user',
          content: 'Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer.\n\nSay ping.',
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-selected-model']).toBe('cheap-fast');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('cheap-fast');
    const history = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/routing-history?limit=1' })).body);
    expect(history.data[0].decision.analysis.requiresMessageToolDelivery).toBe(true);
    expect(history.data[0].decision.rejectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'code-pro', reasons: expect.arrayContaining(['message_tool delivery reliability required']) }),
    ]));
  });

  it('delivers via a reliable text model when a delivery turn is misclassified as vision (2026-07-12 gpt-5.5 loop regression)', async () => {
    // Reproduces the #development infinite-loop incident: a long conversation contained a
    // historical image, so a plain message_tool delivery turn was classified category=vision.
    // That excluded the reliable text model (claude-sonnet-5 -> here cheap-fast) for "vision
    // capability required", leaving only the vision-capable but message_tool-unreliable model
    // (gpt-5.5 -> here code-pro), which looped forever emitting spurious poll fields.
    const visionDeliveryRegistry = {
      ...registry,
      models: registry.models.map((model) => {
        if (model.id === 'cheap-fast') {
          // Reliable text-only delivery target (no vision). Stands in for claude-sonnet-5.
          return {
            ...model,
            features: { ...model.features, tools: true },
            capabilities: { ...model.capabilities, tools: 0.7 },
          };
        }
        if (model.id === 'code-pro') {
          // Vision-capable but message_tool-unreliable. Stands in for gpt-5.5.
          return { ...model, delivery: { messageToolReliable: false } };
        }
        return model;
      }),
    };
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl, {}, visionDeliveryRegistry);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{
          role: 'user',
          content: 'Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer.\n\n[image] (screenshot shared earlier in this thread)\n\nSay ping.',
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    // Delivery must land on the reliable text model, never the unreliable vision model.
    expect(response.headers['x-openclaw-router-selected-model']).toBe('cheap-fast');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('cheap-fast');

    const history = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/routing-history?limit=1' })).body);
    const decision = history.data[0].decision;
    // The misclassification is still present (vision detected)...
    expect(decision.analysis.vision).toBe(true);
    expect(decision.analysis.requiresMessageToolDelivery).toBe(true);
    // ...but for a delivery turn it must NOT exclude the reliable text model for vision.
    expect(decision.rejectedModels).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cheap-fast', reasons: expect.arrayContaining(['vision capability required']) }),
    ]));
    // The unreliable model is still excluded on reliability grounds.
    expect(decision.rejectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'code-pro', reasons: expect.arrayContaining(['message_tool delivery reliability required']) }),
    ]));
  });

  it('routes funds movement prompts away from cheap low-reasoning models', async () => {
    const fundsRegistry = {
      ...registry,
      models: registry.models.map((model) => {
        if (model.id === 'cheap-fast') {
          return {
            ...model,
            features: { ...model.features, tools: true },
            capabilities: { ...model.capabilities, tools: 0.7 },
          };
        }
        return model;
      }),
    };
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl, {}, fundsRegistry);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Approve 500 USDC to this contract and submit the transaction.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-selected-model']).toBe('code-pro');
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.body.model).toBe('code-pro');
    const history = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/routing-history?limit=1' })).body);
    expect(history.data[0].decision.analysis.fundsMovementRisk).toBe(true);
    expect(history.data[0].decision.rejectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cheap-fast', reasons: expect.arrayContaining(['funds movement requires reasoning-capable model']) }),
    ]));
  });

  it('rejects explicit low-reasoning real model for funds movement prompts', async () => {
    const fundsRegistry = {
      ...registry,
      models: registry.models.map((model) => {
        if (model.id === 'cheap-fast') {
          return {
            ...model,
            features: { ...model.features, tools: true },
            capabilities: { ...model.capabilities, tools: 0.7 },
          };
        }
        return model;
      }),
    };
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl, {}, fundsRegistry);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cheap-fast',
        messages: [{ role: 'user', content: 'Send 250 USDC from the wallet.' }],
      },
    });

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.code).toBe('model_not_eligible');
  });

  it('rejects explicit real model when it lacks required capabilities', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cheap-fast',
        messages: [{ role: 'user', content: 'Write TypeScript code for a Fastify endpoint.' }],
      },
    });

    expect(response.statusCode).toBe(400);
    const parsed = JSON.parse(response.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.code).toBe('model_not_eligible');
  });

  it('returns only router aliases and live registry-intersected models from /v1/models', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    const ids = parsed.data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(['surplus-smart-router', 'auto', 'cheap-fast', 'code-pro']);
    expect(ids).not.toContain('offline-model');
  });

  it('requires live pricing and uses the cheapest provider price from the real Surplus shape', async () => {
    const { fetchImpl } = makeFetch({
      '/prices': jsonResponse({ models: [
        { model: 'code-pro', providers: [
          { provider: 'expensive', pricing: { input: 10, output: 30 } },
          { provider: 'cheap', pricing: { input: 2, output: 8 } },
        ] },
      ] }),
    });
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const models = await ctx.app.inject({ method: 'GET', url: '/v1/models' });
    const parsedModels = JSON.parse(models.body);
    expect(parsedModels.data.map((model: { id: string }) => model.id)).toEqual(['surplus-smart-router', 'auto', 'code-pro']);
    expect(parsedModels.data[2].price.inputCostPerMTok).toBe(2);
    expect(parsedModels.data[2].price.outputCostPerMTok).toBe(8);
  });

  it('reloads registry and clears caches', async () => {
    const { fetchImpl, calls } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    await ctx.app.inject({ method: 'GET', url: '/v1/models' });
    await ctx.app.inject({ method: 'GET', url: '/v1/models' });
    expect(calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(1);

    const reload = await ctx.app.inject({ method: 'POST', url: '/registry/reload' });
    expect(reload.statusCode).toBe(200);
    await ctx.app.inject({ method: 'GET', url: '/v1/models' });
    expect(calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(2);
  });

  it('keeps upstream errors OpenAI-shaped', async () => {
    const { fetchImpl } = makeFetch({
      '/chat/completions': jsonResponse({ error: { message: 'bad upstream', type: 'invalid_request_error', code: 'bad' } }, 429),
    });
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(response.statusCode).toBe(429);
    const parsed = JSON.parse(response.body);
    expect(parsed.error.message).toBe('bad upstream');
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.code).toBe('bad');
  });

  it('accepts feedback for a known request and folds it into stats and history scores', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'Write TypeScript code for a CLI tool.' }] },
    });
    expect(first.statusCode).toBe(200);
    const requestId = first.headers['x-openclaw-router-request-id'] as string;
    expect(requestId).toBeTruthy();

    const feedback = await ctx.app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { request_id: requestId, rating: -1, comment: 'bad answer' },
    });
    expect(feedback.statusCode).toBe(201);
    expect(JSON.parse(feedback.body).feedback.rating).toBe(-1);

    const stats = await ctx.app.inject({ method: 'GET', url: '/stats' });
    expect(stats.statusCode).toBe(200);
    const parsedStats = JSON.parse(stats.body);
    expect(parsedStats.totals.feedback_count).toBe(1);
    expect(parsedStats.totals.avg_rating).toBe(-1);
    const modelRow = parsedStats.models.find((row: { selected_model: string }) => row.selected_model === 'code-pro');
    expect(modelRow.feedback_count).toBe(1);
    expect(modelRow.avg_rating).toBe(-1);

    // Second routed request should see the negative feedback in the history score component.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'Write TypeScript code for a parser.' }] },
    });
    expect(second.statusCode).toBe(200);
    const history = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/routing-history?limit=1' })).body);
    const historyComponent = history.data[0].decision.scores['code-pro'].history;
    // success rate 1 (0.55) + latency ~1 (0.2) + feedback -1 mapped to 0 (0.25 * 0) ≈ 0.75
    expect(historyComponent).toBeGreaterThan(0.6);
    expect(historyComponent).toBeLessThan(0.8);
  });

  it('rejects feedback for unknown request ids and invalid ratings', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const unknown = await ctx.app.inject({ method: 'POST', url: '/feedback', payload: { request_id: 'nope', rating: 1 } });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error.code).toBe('request_not_found');

    const invalid = await ctx.app.inject({ method: 'POST', url: '/feedback', payload: { request_id: 'x', rating: 5 } });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).error.type).toBe('invalid_request_error');
  });

  it('serves the dashboard HTML', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const response = await ctx.app.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('OpenClaw Smart Router');
    expect(response.body).toContain('/routing-history?limit=50');
  });

  it('auto-reloads the registry when the file changes on disk', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const before = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/v1/models' })).body);
    expect(before.data.map((model: { id: string }) => model.id)).toContain('cheap-fast');

    const trimmed = { ...registry, models: registry.models.filter((model) => model.id !== 'cheap-fast') };
    await writeFile(ctx.registryPath, JSON.stringify(trimmed));

    const deadline = Date.now() + 5000;
    let ids: string[] = [];
    while (Date.now() < deadline) {
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/models' });
      ids = JSON.parse(response.body).data.map((model: { id: string }) => model.id);
      if (!ids.includes('cheap-fast')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ids).not.toContain('cheap-fast');
    expect(ids).toContain('code-pro');
  });

  it('exposes runtime-adjustable utility weights that change routing', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const before = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/config/weights' })).body);
    expect(before.weights.capability).toBe(0.45);

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/config/weights',
      payload: { capability: 0.1, cost: 0.8, latency: 0.05, history: 0.025, preferences: 0.025 },
    });
    expect(put.statusCode).toBe(200);
    const after = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/config/weights' })).body);
    expect(after.weights.cost).toBe(0.8);

    // With cost dominating, a general prompt should now route to the cheap model.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'Tell me a short story about a fox.' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-openclaw-router-selected-model']).toBe('cheap-fast');

    const invalid = await ctx.app.inject({ method: 'PUT', url: '/config/weights', payload: { capability: -1 } });
    expect(invalid.statusCode).toBe(400);
  });

  it('serves health and prometheus metrics', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = await makeApp(fetchImpl);
    apps.push(ctx.cleanup);

    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).status).toBe('ok');

    const metrics = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('openclaw_smart_router_requests_total');
  });
});
