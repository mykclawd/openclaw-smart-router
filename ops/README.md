# ops — operational guards

External watchdogs that back up the router's routing-time protections. These run
as host processes (pm2), not as part of the router service.

## message_loop_guard.py

Model-independent loop guard for OpenClaw agent turns.

**Why it exists.** The router's registry flags (`delivery.messageToolReliable`)
keep *known-bad* models off the visible message-delivery path. But that is a
denylist — a new or unflagged model can still emit a malformed tool call that
OpenClaw's message runner rejects, and OpenClaw has no built-in cap on repeated
identical tool failures, so the agent re-generates the same failing call forever
and burns tokens. This happened on 2026-07-12 with `gpt-5.5` emitting
`message(action=send)` with schema-default poll fields.

This guard is the categorical backstop: it watches session transcripts and aborts
a stuck run once it sees N consecutive identical tool failures, regardless of
model or cause. It cannot live inside OpenClaw (that package is wiped on every
update; its hook API exposes no tool-result event and hooks cannot abort a turn),
so it runs from the outside.

**How it works.**
- Tails session JSONL under `~/.openclaw/agents/*/sessions/`.
- Fires when the last `--threshold` (default 5) tool results are all errors with
  the same signature **and** the newest error is recent (file-mtime prefilter +
  message-timestamp recency gate, both `--active-seconds`, default 180s), so a
  stale transcript that merely ends in old errors is never touched.
- Aborts via `openclaw gateway call chat.abort --params '{"sessionKey":"…"}'`.
- 120s cooldown per (session, signature); state in
  `~/.openclaw/state/message-loop-guard.json`; log in
  `~/.openclaw/workspace-general/logs/message-loop-guard.log`.

**Deploy.** The live copy runs from `~/.openclaw/workspace-general/scripts/`
(alongside `discord_delivery_guard.py`) under pm2:

```bash
cp ops/message_loop_guard.py ~/.openclaw/workspace-general/scripts/
pm2 start ~/.openclaw/workspace-general/scripts/message_loop_guard.py \
  --name openclaw-message-loop-guard --interpreter python3 \
  -- --poll-seconds 5 --threshold 5
pm2 save
```

Dry-run a single scan without aborting anything:

```bash
python3 ops/message_loop_guard.py --once --dry-run --log-file /dev/stdout
```
