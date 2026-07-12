---
name: "openclaw-smart-router-setup"
description: "Install & wire the open-source OpenClaw Smart Router (Surplus Intelligence model router) into an OpenClaw gateway."
---

# OpenClaw Smart Router — Setup Skill

## When to use this

The user wants to install the **OpenClaw Smart Router** (open-source, OpenAI-compatible
model router for Surplus Intelligence) into their own OpenClaw gateway. This skill
walks an agent through cloning, configuring, wiring into `openclaw.json`,
verifying, and installing the loop guard — end to end, autonomously.

Repo: `https://github.com/mykclawd/openclaw-smart-router` (MIT licensed).

## What it does

A small Fastify service that sits between OpenClaw and Surplus Intelligence's
marketplace API. When a request's `model` is `surplus-smart-router` or `auto`,
it picks the best live Surplus model for that specific prompt (based on a rule-based
prompt analyzer + capability/cost/latency/history/preference scoring) instead of
you hardcoding one model for every request. Falls through transparently
(OpenAI-compatible proxy, including SSE streaming) for explicit model requests too.

## Prerequisites

- Node.js >= 22
- A Surplus Intelligence API key — sign up at https://www.surplusintelligence.ai
  and get one from the dashboard. Without this the router will build and start
  but every request will fail upstream.
- Somewhere to run a long-lived process: `pm2`, `systemd`, Docker, or a screen/tmux
  session. Do not run it as a one-off foreground `npm run dev` in production.
- Python 3.9+ and the `openclaw` CLI on `PATH` — for the loop guard in Step 7
  (strongly recommended; prevents runaway token-burn loops).

## Step 1 — Clone and install

```bash
git clone https://github.com/mykclawd/openclaw-smart-router.git
cd openclaw-smart-router
npm install
```

## Step 2 — Configure

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
SURPLUS_API_KEY=*** key from surplusintelligence.ai>
```

Leave everything else at defaults unless you have a reason to change them
(see README "Configuration" table for the full variable list — port, SQLite
path, cache TTL, utility weights, user preferences).

**Do not commit `.env`.** It's already gitignored in this repo; keep it that way
if you fork.

## Step 3 — Build and run

Pick one:

**Direct (dev/testing):**
```bash
npm run build
npm start
```

**pm2 (recommended for always-on):**
```bash
npm run build
pm2 start dist/index.js --name openclaw-smart-router
pm2 save
```

**Docker:**
```bash
docker build -t openclaw-smart-router .
docker run -d --name openclaw-smart-router -p 8787:8787 --env-file .env \
  -v "$PWD/data:/app/data" openclaw-smart-router
```

## Step 4 — Verify it's alive

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/models | head -c 500
```

`/health` should return ok. `/v1/models` should list the router aliases
(`surplus-smart-router`, `auto`) plus live Surplus models that intersect the
static capability registry (`registry/models.json`). If the model list is
empty, the Surplus API key is likely wrong or the marketplace call is failing —
check logs (`pm2 logs openclaw-smart-router` or `docker logs`).

## Step 5 — Wire into OpenClaw config

Read the target OpenClaw config first (do not blind-overwrite):
follow this estate's config-change-control discipline — inspect existing
`models.providers` before merging, back up the file, and use the `gateway`
tool's `config.schema.patch`/`apply` actions rather than hand-editing when
that tool is available.

Add (merge, don't replace) a provider block like:

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
  }
}
```

To make it the default model for an agent:

```json5
{
  agents: {
    defaults: { model: { primary: "surplus-smart-router/surplus-smart-router" } }
  }
}
```

Or leave agents on their current default and let users opt in per-agent/session
by setting `model: surplus-smart-router/surplus-smart-router` explicitly.

## Step 6 — Restart the gateway

Use the `gateway` tool's `restart` action (not stop+start). Confirm with
`openclaw status` or `session_status` that the new provider is visible and
a test message routes through it (check response headers
`x-openclaw-router-selected-model` and `x-openclaw-router-routed` if you have
raw HTTP visibility, or just watch `/routing-history` on the router's own
dashboard at `http://127.0.0.1:8787/dashboard`).

## Step 7 — Install the loop guard (strongly recommended)

The router's `registry/models.json` `delivery.messageToolReliable` flags keep
*known-bad* models off the visible message-delivery path — but that's a denylist.
A new or unflagged model can still emit a malformed tool call that OpenClaw's
message runner rejects, and OpenClaw caps neither repeated tool failures nor agent
turns, so the agent can loop on the same failing call forever and burn tokens.

`ops/message_loop_guard.py` is the model-independent backstop: it watches session
transcripts and aborts a stuck run via `chat.abort` once it sees N consecutive
identical tool failures (recency-gated so stale transcripts are never touched). It
runs as a host process because it can't live inside OpenClaw (that package is wiped
on update; its hook API exposes no tool-result event and hooks can't abort a turn).

No configuration needed — it discovers agents/sessions under `$OPENCLAW_STATE_DIR`
(or `~/.openclaw`) and finds `openclaw` on `PATH`. Install alongside the router:

```bash
pm2 start ops/message_loop_guard.py \
  --name openclaw-message-loop-guard --interpreter python3 \
  -- --poll-seconds 5 --threshold 5
pm2 save
```

Verify it's watching (aborts nothing; just detects + logs):

```bash
python3 ops/message_loop_guard.py --once --dry-run --log-file /dev/stdout
```

Requires Python 3.9+ and the `openclaw` CLI on `PATH`. See `ops/README.md` for
tuning options (`--threshold`, `--active-seconds`, `--cooldown-seconds`).

## Common failure modes

- **Empty `/v1/models`**: bad/missing `SURPLUS_API_KEY`, or Surplus marketplace
  API is down. Check `/health` and container/process logs.
- **Every request 502s**: `REQUEST_TIMEOUT_MS` too low for the selected model,
  or upstream Surplus provider is unreachable. Check `/metrics` for error rates.
- **Router picks obviously wrong models**: tune `UTILITY_WEIGHTS` via
  `PUT /config/weights` (runtime, non-persistent) or `.env` (persistent), or
  run `npm run evaluate` against stored routing history for a data-driven
  weight recommendation.
- **Silent no-op after config change**: OpenClaw config changes need a gateway
  restart to take effect — a `models.providers` edit without a restart won't
  show up in `/v1/models` on the OpenClaw side even though the router itself
  is fine.

## Security notes

- The router never returns your `SURPLUS_API_KEY` in any response body,
  header, or log line — verified by source inspection (`src/surplusClient.ts`
  only sends it as an outbound `Authorization: Bearer` header to Surplus).
- `/dashboard` and `/stats` expose routing history (which models were picked,
  latency, feedback) but not request/response content or credentials. Don't
  expose port 8787 to the public internet without your own auth/reverse-proxy
  layer if that history is sensitive.
- Treat `.env` like any other secret file: never commit it, restrict file
  permissions if the host is multi-tenant.
