# OpenClaw Smart Router v1

OpenClaw Smart Router is a small OpenAI-compatible TypeScript service that chooses an eligible Surplus Intelligence model when the inbound model is `surplus-smart-router` or `auto`.

## Quickstart

```bash
git clone https://github.com/mykcryptodev/openclaw-smart-router.git
cd openclaw-smart-router
npm install
cp .env.example .env
```

1. Get a Surplus Intelligence API key at [surplusintelligence.ai](https://www.surplusintelligence.ai) and set `SURPLUS_API_KEY` in `.env`.
2. Build and start the service:

   ```bash
   npm run build
   npm start
   # or for local dev with auto-reload:
   npm run dev
   ```

3. Point your OpenClaw config's OpenAI-compatible provider at `http://127.0.0.1:8787/v1` (see [OpenClaw setup](#openclaw-setup) below for the exact config block), then restart your gateway.
4. Verify it's alive: `curl http://127.0.0.1:8787/health`

That's it — the router now handles any request sent to model `surplus-smart-router` or `auto`.

It is intentionally simple for v1:

- Fastify HTTP server
- Zod request/config validation
- SQLite routing history via `better-sqlite3`
- In-process TTL cache for Surplus `/models` and `/prices`
- Prometheus text metrics
- Transparent OpenAI-compatible `/v1/chat/completions` proxy, including SSE streaming passthrough
- JSON hot-reloadable static capability registry (manual `POST /registry/reload` plus automatic file watching)
- Feedback collection (`POST /feedback`) that feeds back into routing history scores
- Zero-dependency HTML dashboard at `GET /dashboard`
- Runtime-adjustable utility weights (`GET`/`PUT /config/weights`)
- Offline weight evaluation (`npm run evaluate`) that replays routing history against alternative weight profiles

## API

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint.

- `model: "surplus-smart-router"` or `"auto"` triggers smart routing.
- An explicit real model is honored when it is live, present in the registry, and eligible for required capabilities.
- Request messages are not rewritten.
- The router only changes the upstream `model` field when routing is triggered.
- Non-streaming responses are proxied back as OpenAI-shaped JSON.
- Streaming responses are passed through as `text/event-stream` SSE bytes.
- Errors are returned with OpenAI-style `{ "error": { message, type, param, code } }` bodies.

Router metadata headers:

- `x-openclaw-router-request-id`
- `x-openclaw-router-selected-model`
- `x-openclaw-router-routed`

### `GET /v1/models`

Returns OpenAI-compatible model list containing router aliases plus live Surplus models that intersect the static capability registry.

### `GET /health`

Basic service health.

### `GET /metrics`

Prometheus text metrics.

### `GET /routing-history?limit=100`

Recent SQLite routing decisions, including prompt analysis, score breakdown, selected model, latency, and status.

### `POST /feedback`

Rate a routed request so future routing learns from outcomes:

```json
{ "request_id": "<x-openclaw-router-request-id>", "rating": -1, "comment": "optional" }
```

`rating` is a number in `[-1, 1]`. Feedback is stored in SQLite and blended into the per-model history score (success rate 55%, latency 20%, feedback 25%).

### `GET /stats`

JSON summary for dashboards: totals (requests, routed, errors, avg latency, feedback), per-model rows (success/error counts, avg latency, avg rating, last used), and category breakdown.

### `GET /dashboard`

Self-contained HTML dashboard (no build step, auto-refreshes every 10s) rendering `/stats` and `/routing-history`.

### `GET /config/weights` and `PUT /config/weights`

Read or update the utility weights at runtime (validated, applied to subsequent requests immediately). Updates are in-memory only — set `UTILITY_WEIGHTS` in `.env` to persist across restarts.

### `POST /registry/reload`

Reloads the JSON capability registry and clears live model/price caches. The registry file is also watched (`REGISTRY_WATCH`, default on) and reloads automatically ~300ms after an edit; invalid JSON keeps the previous registry and logs an error.

## Routing behavior

The v1 prompt analyzer is intentionally rule-based. It detects:

- category: general, coding, analysis, writing, math, vision, tool_use, structured
- complexity
- coding
- vision
- tool/function use
- structured output
- estimated context tokens
- latency sensitivity

Live Surplus models/prices are intersected with `registry/models.json`. A model must have a live catalog entry, live pricing, and a static registry entry before it is eligible. Routing history stores rejected models and their rejection reasons.

Default utility weights:

```json
{
  "capability": 0.45,
  "cost": 0.25,
  "latency": 0.10,
  "history": 0.10,
  "preferences": 0.10
}
```

Scores and reasons are stored per request in SQLite for explainability.

## Offline weight evaluation

```bash
npm run evaluate
```

Replays up to 1000 stored routing decisions (their per-model score components are persisted, so no live traffic is needed) against the current weights plus five preset profiles (balanced, cost-heavy, capability-heavy, latency-heavy, history-heavy). Each profile is judged by the observed outcome quality (success rate + user feedback) of the models it would have picked. The report recommends a profile and prints the `PUT /config/weights` command to apply it live.

## Configuration

Copy `.env.example` to `.env` and set at least `SURPLUS_API_KEY`.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SURPLUS_BASE_URL` | `https://api.surplusintelligence.ai/v1` | Surplus OpenAI-compatible API base |
| `SURPLUS_API_KEY` | unset | Bearer token for Surplus |
| `ROUTER_MODEL_IDS` | `surplus-smart-router,auto` | Inbound model IDs that trigger routing |
| `CAPABILITY_REGISTRY_PATH` | `./registry/models.json` | Static model capability registry |
| `SQLITE_PATH` | `./data/router.sqlite` | Routing history DB |
| `CACHE_TTL_MS` | `60000` | Live model/price cache TTL |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout |
| `REGISTRY_WATCH` | `true` | Auto-reload registry on file change (`false`/`0`/`no`/`off` disables) |
| `UTILITY_WEIGHTS` | default JSON above | Explainable scoring weights |
| `USER_PREFERENCES` | `{}` | Optional prefer/avoid/cost/latency preferences |

Example preference JSON:

```json
{
  "preferModels": ["claude-sonnet-5"],
  "avoidModels": [],
  "maxInputCostPerMTok": 5,
  "maxOutputCostPerMTok": 25,
  "latencyBias": "balanced"
}
```

## OpenClaw setup

1. Build/install the service in your chosen directory.
2. Create `.env` from `.env.example`.
3. Set `SURPLUS_API_KEY`.
4. Start the service with your preferred OpenClaw process manager or container runtime.
5. Point OpenClaw OpenAI-compatible client config at:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "surplus-smart-router": {
        baseUrl: "http://127.0.0.1:8787/v1",
        apiKey: "local-router",
        api: "openai-completions",
        models: [{
          id: "surplus-smart-router",
          name: "Surplus Smart Router",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1000000,
          maxTokens: 128000
        }]
      }
    }
  },
  agents: {
    defaults: { model: { primary: "surplus-smart-router/surplus-smart-router" } }
  }
}
```

For explicit model bypass, set `model` to a real eligible Surplus model from `GET /v1/models`.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Run locally:

```bash
cp .env.example .env
# edit SURPLUS_API_KEY
npm run dev
```

Smoke test non-streaming:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"surplus-smart-router","messages":[{"role":"user","content":"Write a tiny TypeScript function."}]}'
```

Smoke test streaming:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Say hi."}]}'
```

## Docker

```bash
docker build -t openclaw-smart-router .
docker run --rm -p 8787:8787 --env-file .env openclaw-smart-router
```

If you mount custom state/registry:

```bash
docker run --rm -p 8787:8787 --env-file .env \
  -v "$PWD/registry:/app/registry:ro" \
  -v "$PWD/data:/app/data" \
  openclaw-smart-router
```

## v1 boundaries

No Redis, BullMQ, or OpenTelemetry are included. The service keeps cache and metrics in process and stores durable routing history in SQLite.

## License

MIT — see [LICENSE](./LICENSE).
