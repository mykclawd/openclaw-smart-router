import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { ChatCompletionRequestSchema, FeedbackRequestSchema, UtilityWeightsSchema, type ChatCompletionRequest } from './types.js';
import { DASHBOARD_HTML } from './dashboard.js';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { RegistryStore } from './registry.js';
import { SurplusClient } from './surplusClient.js';
import { HistoryStore } from './history.js';
import { Metrics } from './metrics.js';
import { SmartRouter } from './router.js';
import { OpenAIError, sendOpenAIError } from './errors.js';

export interface AppServices {
  config: AppConfig;
  registryStore: RegistryStore;
  surplusClient: SurplusClient;
  historyStore: HistoryStore;
  metrics: Metrics;
  router: SmartRouter;
}

export interface BuildAppOptions {
  config?: Partial<AppConfig>;
  fetchImpl?: typeof fetch;
  logger?: boolean | Record<string, unknown>;
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(lower)) out[key] = value;
  });
  return out;
}

function isStreamingRequest(request: ChatCompletionRequest): boolean {
  return Boolean(request.stream);
}

function selectedModelLabel(selectedModel: string): string {
  return `[model: ${selectedModel}]\n\n`;
}

function prefixContentWithSelectedModel(content: unknown, selectedModel: string): unknown {
  const label = selectedModelLabel(selectedModel);
  if (typeof content === 'string') return `${label}${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: label }, ...content];
  return content;
}

function annotateChatCompletionJson(json: unknown, selectedModel: string): unknown {
  if (!json || typeof json !== 'object') return json;
  const body = json as { model?: string; choices?: Array<{ message?: { content?: unknown } }> };
  body.model = selectedModel;
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (choice.message && choice.message.content != null) {
        choice.message.content = prefixContentWithSelectedModel(choice.message.content, selectedModel);
      }
    }
  }
  return body;
}

function extractUsage(json: unknown): { promptTokens: number | null; completionTokens: number | null } {
  if (!json || typeof json !== 'object') return { promptTokens: null, completionTokens: null };
  const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  return {
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
  };
}

function estimateCostUsd(promptTokens: number | null, completionTokens: number | null, inputCostPerMTok: number | undefined, outputCostPerMTok: number | undefined): number | null {
  if (promptTokens == null && completionTokens == null) return null;
  if (inputCostPerMTok == null && outputCostPerMTok == null) return null;
  const inputCost = promptTokens != null && inputCostPerMTok != null ? (promptTokens / 1e6) * inputCostPerMTok : 0;
  const outputCost = completionTokens != null && outputCostPerMTok != null ? (completionTokens / 1e6) * outputCostPerMTok : 0;
  return inputCost + outputCost;
}

function annotateSseEvent(event: string, selectedModel: string, alreadyAnnotated: boolean): { event: string; annotated: boolean } {
  let annotated = alreadyAnnotated;
  const lines = event.split('\n').map((line) => {
    if (!line.startsWith('data:')) return line;
    const data = line.slice(5).trimStart();
    if (!data || data === '[DONE]') return line;
    try {
      const json = JSON.parse(data) as { model?: string; choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> };
      json.model = selectedModel;
      if (!annotated) {
        for (const choice of json.choices ?? []) {
          if (choice.delta && typeof choice.delta.content === 'string') {
            choice.delta.content = prefixContentWithSelectedModel(choice.delta.content, selectedModel);
            annotated = true;
            break;
          }
          if (choice.message && choice.message.content != null) {
            choice.message.content = prefixContentWithSelectedModel(choice.message.content, selectedModel);
            annotated = true;
            break;
          }
        }
      }
      return `data: ${JSON.stringify(json)}`;
    } catch {
      return line;
    }
  });
  return { event: lines.join('\n'), annotated };
}

async function pipeAnnotatedSseStream(reader: ReadableStreamDefaultReader<Uint8Array>, selectedModel: string, write: (chunk: string | Buffer) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let annotated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const event of events) {
      const result = annotateSseEvent(event, selectedModel, annotated);
      annotated = result.annotated;
      write(`${result.event}\n\n`);
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    const result = annotateSseEvent(buffer, selectedModel, annotated);
    write(result.event);
  }
}

function zodToOpenAIError(error: ZodError): OpenAIError {
  return new OpenAIError(`Invalid request body: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 400, 'invalid_request_error', 'invalid_request', null);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<{ app: FastifyInstance; services: AppServices }> {
  const config = loadConfig(options.config);
  const registryStore = new RegistryStore(config.capabilityRegistryPath);
  await registryStore.load();
  const surplusClient = new SurplusClient(config.surplusBaseUrl, config.surplusApiKey, config.cacheTtlMs, config.requestTimeoutMs, options.fetchImpl ?? fetch);
  const historyStore = new HistoryStore(config.sqlitePath);
  const metrics = new Metrics();
  const router = new SmartRouter(registryStore, surplusClient, historyStore, {
    routerModelIds: config.routerModelIds,
    utilityWeights: config.utilityWeights,
    userPreferences: config.userPreferences,
  });

  const app = Fastify({ logger: options.logger ?? { level: config.logLevel } });
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    status: 'ok',
    registryLoadedAt: registryStore.getLoadedAt(),
    time: new Date().toISOString(),
  }));

  app.get('/metrics', async (_request, reply) => {
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(metrics.snapshot());
  });

  app.get('/v1/models', async (_request, reply) => {
    try {
      const [liveModels, prices] = await Promise.all([surplusClient.getModels(), surplusClient.getPrices()]);
      const liveIds = new Set(liveModels.map((model) => model.id));
      const priceById = new Map(prices.map((price) => [price.model, price]));
      const registryModels = registryStore.get().models.filter((model) => liveIds.has(model.id) && priceById.has(model.id));
      const data = [
        ...config.routerModelIds.map((id) => ({
          id,
          object: 'model',
          owned_by: 'openclaw-smart-router',
          router: true,
        })),
        ...registryModels.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: 'surplus',
          router: false,
          features: model.features,
          context_window: model.contextWindow,
          price: priceById.get(model.id) ?? null,
        })),
      ];
      return reply.send({ object: 'list', data });
    } catch (error) {
      return sendOpenAIError(reply, error as Error);
    }
  });

  app.get('/routing-history', async (request, reply) => {
    const query = request.query as { limit?: string | number };
    const limit = query.limit == null ? 100 : Number(query.limit);
    if (!Number.isFinite(limit)) return sendOpenAIError(reply, new OpenAIError('limit must be a number', 400, 'invalid_request_error', 'invalid_limit', 'limit'));
    return {
      data: historyStore.list(limit).map((row) => ({
        ...row,
        routed: Boolean(row.routed),
        streaming: Boolean(row.streaming),
        decision: JSON.parse(row.decision_json),
        decision_json: undefined,
      })),
    };
  });

  app.post('/feedback', async (request, reply) => {
    let parsed;
    try {
      parsed = FeedbackRequestSchema.parse(request.body);
    } catch (error) {
      return sendOpenAIError(reply, error instanceof ZodError ? zodToOpenAIError(error) : error as Error, 400);
    }
    if (!historyStore.hasRequest(parsed.request_id)) {
      return sendOpenAIError(reply, new OpenAIError(`Unknown request_id '${parsed.request_id}'`, 404, 'invalid_request_error', 'request_not_found', 'request_id'));
    }
    const row = historyStore.insertFeedback(parsed.request_id, parsed.rating, parsed.comment ?? null);
    return reply.status(201).send({ ok: true, feedback: row });
  });

  app.get('/stats', async () => historyStore.statsSummary());

  app.get('/config/weights', async () => ({ weights: router.getWeights() }));

  app.put('/config/weights', async (request, reply) => {
    try {
      const weights = UtilityWeightsSchema.parse(request.body);
      const applied = router.setWeights(weights);
      app.log.info({ weights: applied }, 'utility weights updated at runtime');
      return reply.send({ ok: true, weights: applied, note: 'in-memory only; set UTILITY_WEIGHTS to persist across restarts' });
    } catch (error) {
      return sendOpenAIError(reply, error instanceof ZodError ? zodToOpenAIError(error) : error as Error, 400);
    }
  });

  app.get('/dashboard', async (_request, reply) => {
    return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
  });

  app.post('/registry/reload', async (_request, reply) => {
    try {
      const result = await registryStore.reload();
      surplusClient.clearCache();
      return reply.send({ ok: true, loadedAt: result.loadedAt, models: result.registry.models.length });
    } catch (error) {
      return sendOpenAIError(reply, error as Error, 400);
    }
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const started = Date.now();
    const requestId = randomUUID();
    let parsed: ChatCompletionRequest;
    try {
      parsed = ChatCompletionRequestSchema.parse(request.body);
    } catch (error) {
      return sendOpenAIError(reply, error instanceof ZodError ? zodToOpenAIError(error) : error as Error, 400);
    }

    try {
      const { decision, upstreamRequest } = await router.route(parsed, requestId);
      metrics.recordRequest(decision.routed, decision.selectedModel);
      historyStore.insertStart({
        requestId,
        requestedModel: decision.requestedModel,
        selectedModel: decision.selectedModel,
        routed: decision.routed,
        category: decision.analysis.category,
        complexity: decision.analysis.complexity,
        streaming: isStreamingRequest(parsed),
        decision,
      });

      const upstreamResponse = await surplusClient.chatCompletions(upstreamRequest);

      reply.header('x-openclaw-router-request-id', requestId);
      reply.header('x-openclaw-router-selected-model', decision.selectedModel);
      reply.header('x-openclaw-router-routed', String(decision.routed));

      if (isStreamingRequest(parsed)) {
        reply.raw.writeHead(upstreamResponse.status, {
          ...responseHeadersToObject(upstreamResponse.headers),
          'content-type': upstreamResponse.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
          'x-openclaw-router-request-id': requestId,
          'x-openclaw-router-selected-model': decision.selectedModel,
          'x-openclaw-router-routed': String(decision.routed),
        });
        if (!upstreamResponse.body) {
          reply.raw.end();
          return reply;
        }
        const reader = upstreamResponse.body.getReader();
        try {
          await pipeAnnotatedSseStream(reader, decision.selectedModel, (chunk) => reply.raw.write(chunk));
        } finally {
          reply.raw.end();
          reader.releaseLock();
        }
        const latencyMs = Date.now() - started;
        historyStore.finish(requestId, {
          status: 'success',
          latencyMs,
        });
        metrics.recordLatency(latencyMs);
        return reply;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8';
      reply.headers(responseHeadersToObject(upstreamResponse.headers));
      reply.header('content-type', contentType);
      const text = await upstreamResponse.text();
      let body = text;
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      try {
        const json = JSON.parse(text);
        body = JSON.stringify(annotateChatCompletionJson(json, decision.selectedModel));
        const usage = extractUsage(json);
        promptTokens = usage.promptTokens;
        completionTokens = usage.completionTokens;
      } catch {
        // upstream returned non-JSON; forward as-is
      }
      const latencyMs = Date.now() - started;
      const estimatedCostUsd = estimateCostUsd(
        promptTokens,
        completionTokens,
        decision.selectedModelPrice?.inputCostPerMTok,
        decision.selectedModelPrice?.outputCostPerMTok,
      );
      historyStore.finish(requestId, {
        status: 'success',
        latencyMs,
        promptTokens,
        completionTokens,
        estimatedCostUsd,
      });
      metrics.recordLatency(latencyMs);
      return reply.status(upstreamResponse.status).send(body);
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (error instanceof OpenAIError && error.type === 'upstream_error') metrics.recordUpstreamError();
      try { historyStore.finish(requestId, { status: 'error', latencyMs, errorMessage: (error as Error).message }); } catch { /* history row may not exist */ }
      return sendOpenAIError(reply, error as Error);
    }
  });

  let registryWatcher: FSWatcher | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  if (config.registryWatch) {
    const registryFile = path.resolve(config.capabilityRegistryPath);
    try {
      registryWatcher = watch(registryFile, () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          registryStore.reload()
            .then((result) => {
              surplusClient.clearCache();
              app.log.info({ loadedAt: result.loadedAt, models: result.registry.models.length }, 'capability registry auto-reloaded');
            })
            .catch((error: Error) => {
              app.log.error({ err: error }, 'capability registry auto-reload failed; keeping previous registry');
            });
        }, 300);
      });
      registryWatcher.on('error', (error) => {
        app.log.error({ err: error }, 'registry watcher error');
      });
    } catch (error) {
      app.log.warn({ err: error as Error }, 'could not watch capability registry file');
    }
  }

  app.addHook('onClose', async () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    registryWatcher?.close();
    historyStore.close();
  });

  return { app, services: { config, registryStore, surplusClient, historyStore, metrics, router } };
}
