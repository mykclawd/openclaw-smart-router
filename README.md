# OpenClaw Smart Router v1

OpenClaw Smart Router is a small OpenAI-compatible TypeScript service that chooses an eligible Surplus Intelligence model when the inbound model is `surplus-smart-router` or `auto`.

## Quickstart

### Option A: let your OpenClaw agent install it for you

This repo ships a `SKILL.md`. If you're running OpenClaw, just tell your agent:

```
Install this skill and set up the OpenClaw Smart Router: https://github.com/mykclawd/openclaw-smart-router
```

Or install the skill directly via the CLI, then ask your agent to run the setup:

```bash
openclaw skills install git:mykclawd/openclaw-smart-router
```

The skill walks the agent through cloning, configuring, running, wiring into
`openclaw.json`, and verifying — end to end.

### Option B: do it by hand

```bash
git clone https://github.com/mykclawd/openclaw-smart-router.git
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

### `GET /payments/balance`

Surplus account balance for deposit-based billing, proxied from `GET /v1/payments/deposit-address`/`/v1/payments/balance` upstream and cached for `CACHE_TTL_MS`:

```json
{
  "balance_usdc": 1635.51,
  "allowance_usdc": 90.14,
  "pending_deposit_usdc": 0,
  "deposit_address": "0x…",
  "deposit_chain_id": 8453,
  "deposit_token_address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "deposit_min_confirmations": 20,
  "account_status": "active",
  "auto_topup_enabled": true
}
```

`balance_usdc` is the spendable deposit balance — inference draws down from it. `allowance_usdc` reflects the legacy ERC-20 approval flow and is kept for visibility only. When the deposit can't cover a request, Surplus returns HTTP 402 and the router forwards it with an added hint to top up USDC on Base to `deposit_address`.

### `GET /dashboard`

Self-contained HTML dashboard (no build step, auto-refreshes every 10s) rendering `/stats`, `/payments/balance` (Surplus deposit tile, red below 10 USDC), and `/routing-history`.

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

## jev prompt classification

The rule-based analyzer above scans the **entire** concatenated message array. Under OpenClaw that array is dominated by the system/runtime envelope, which contains the words `code`, `function`, `analyze`, `plan`, `send`, `token`, `wallet` and `transaction`. Measured over 2485 stored decisions on 2026-09-19:

- 98.6% tripped "coding keywords detected"
- 98.7% tripped "analysis/reasoning terms detected"
- 95.6% tripped "funds movement or allowance risk detected"
- 98.3% ended at `complexity == 1.00`

Every flag fired on nearly every request, so the analyzer's output carried almost no information about the actual ask. The funds-risk flag is a hard eligibility filter (`MIN_FUNDS_REASONING_CAPABILITY = 0.90`), and 11 of the 21 registry models sit below that floor — so the false positive makes a capability gate binding on traffic that never touches funds.

[jev](https://docs.typesafe.ai) (TypeSafe System One) replaces the three judgments the keyword matcher was failing at. Everything the request states structurally stays in code — jev is never asked what can be computed exactly:

| Signal | Source |
| --- | --- |
| `tools`, `vision`, `structuredOutput` | the request body |
| `estimatedContextTokens` | arithmetic |
| `requiresMessageToolDelivery` | full-array string match (unchanged) |
| reasoning tier (0–4) | jev `Score` |
| funds movement | jev `Noul` |
| domain | jev `Choice` |

jev sees only the latest user turn with the envelope stripped (`src/promptScope.ts`). This matters for accuracy, not just cost: jev's documented failure mode #5 is degradation on large states full of irrelevant detail.

Known limit of that scoping: it takes the latest `user` message only. Mid-conversation, when the latest turn is a bare `"yes, do it"`, jev classifies the acknowledgement rather than the task it refers to. The heuristic's structural signals (tools, vision, context size) still apply, but expect the reasoning tier to read low on those turns.

Because `analysis.coding` is a hard filter and jev's domain Choice returns exactly one option, the merged `coding` flag is the **union** of jev's domain and a keyword check over the scoped text — a coding question jev labels `analysis` must not silently clear the coding-capability requirement.

### Modes

Set with `JEV_MODE`:

- `off` — never call jev; pre-integration behaviour.
- `shadow` *(default)* — call jev and persist its answers next to the heuristic's, but the **heuristic still decides**.
- `live` — jev drives eligibility and scoring.

The default is `shadow` deliberately. There is no ground truth yet: the `feedback` table is empty, and `routing_history` has never stored prompt text, so the 2485 pre-existing rows **cannot** be replayed offline. Shadow mode is what produces the comparison data; it records the scoped prompt so a labelled set can be built.

```bash
npm run jev:compare
```

Prints jev-vs-heuristic disagreement rates, tier and domain distributions, jev latency percentiles, and the fallback rate.

This measures disagreement **volume, not correctness** — nothing in it says which classifier was right. Turning it into evidence means hand-labelling the captured `jev.analysis.state` values and scoring both against those labels.

### Failure behaviour

jev is on the critical path of every completion, so it fails open in every branch — timeout, 401, 422, 429, 529, network error, or malformed body all fall back to the keyword analyzer and the request proceeds. Failures are recorded in `decision_json` so the fallback rate is measurable. The jev call runs concurrently with the Surplus `/models` and `/prices` fetches, so it usually adds no wall-clock latency.

The reasoning tier floor is an optimisation, not a safety gate: if no model meets it, the floor is dropped and the request retries rather than failing. The funds-movement gate is **not** relaxed that way — it exists to keep weak models away from real transactions.

### Just-in-time capability check

For the top tiers the router also requires the **live** Surplus listing to advertise `reasoning` in `supported_features`, rather than trusting the hand-maintained registry alone. This is the `scripts/pick_trench_model.py` gate applied per request instead of once a day. When a live entry omits `supported_features`, the check fails open.

### Just-in-time catalog widening

Surplus prices move, and the cheapest capable model for a given tier is often one nobody has hand-scored into the registry. In `live` mode, models present in the live catalog but missing from the registry get a **derived** entry built from the live listing's own metadata (`supported_features`, `context_length`, `architecture.input_modalities`, `supported_parameters`, `top_provider.max_completion_tokens`) and enter the candidate pool.

Safety properties:

- Live mode only. In `shadow` mode the heuristic decides, and widening there would let the known-noisy keyword classifier route traffic onto unvetted models.
- Conservative derived capabilities (`0.4` across the board). A derived model must win on **price or latency** to be picked — it can never outrank a hand-scored model on capability. Set cost-heavy weights (`UTILITY_WEIGHTS` with a high `cost` share) if you want dynamic pricing to be decisive.
- Text-to-text models only; non-chat modalities (image/video/audio generation, embeddings, TTS) are excluded at derivation.
- The same gates apply as for registry models: reasoning tier floor, live `reasoning` feature check, funds-movement floor, context fit, price caps.

Disable with `JEV_JIT_CATALOG=false` to route only across the hand-maintained registry.

### Classification cache

jev sits on the critical path of every completion (~400 ms cold). Recurring scoped prompts — cron jobs, identical health pings, client retries — are served from a short-TTL in-process cache (`JEV_CACHE_TTL_MS`, default 5 min) instead of re-calling jev. Only successful classifications are cached; failures always retry live, so a transient 529 can't pin the router to the heuristic. Hit/miss counters are exported on `/metrics` as `openclaw_smart_router_jev_cache_*`. Set `JEV_CACHE_TTL_MS=0` to disable.

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
| `JEV_MODE` | `shadow` | `off`, `shadow`, or `live` — see [jev prompt classification](#jev-prompt-classification) |
| `JEV_API_KEY` | unset | Bearer token for jev (`TYPESAFE_API_KEY` also accepted). Without it jev is disabled and the keyword analyzer decides |
| `JEV_BASE_URL` | `https://api.typesafe.ai/v1` | TypeSafe API base |
| `JEV_MODEL` | `jev-latest` | Pin a version (e.g. `jev-1.13.0`) if you tune confidence thresholds |
| `JEV_TIMEOUT_MS` | `1500` | jev timeout; on expiry the request falls back to the heuristic |
| `JEV_MAX_STATE_CHARS` | `12000` | Cap on the scoped prompt sent to jev |
| `JEV_CACHE_TTL_MS` | `300000` | Classification cache TTL in ms; `0` disables |
| `JEV_JIT_CATALOG` | `true` | Live mode only: widen the candidate pool to live-catalog models with no registry entry |

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
