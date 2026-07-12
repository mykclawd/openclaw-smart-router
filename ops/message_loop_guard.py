#!/usr/bin/env python3
"""
Model-independent loop guard for OpenClaw agent turns.

OpenClaw has no built-in cap on repeated identical tool failures: if a model
keeps emitting the same tool call and the runner keeps rejecting it, the agent
re-generates the same failing call forever, burning tokens every iteration.
This happened on 2026-07-12 when gpt-5.5 repeatedly called message(action=send)
with schema-default poll fields, which the runner rejects as accidental poll
creation.

The real bug (a poll-field false positive) and the missing loop cap both live in
the upstream `openclaw` npm package, which gets wiped on every update, so we
cannot patch them durably. This guard instead watches session transcripts from
the outside and aborts a stuck run via the gateway `chat.abort` RPC once it sees
N consecutive identical tool failures. It is model- and cause-independent: any
repeated identical tool failure trips it, not just the poll-field case.

Pairs with discord_delivery_guard.py (which mirrors *missed* deliveries); this
one stops *looping* deliveries. Run under pm2 alongside it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Portable defaults: honor an explicit OpenClaw state dir (set by --profile/--dev),
# otherwise fall back to ~/.openclaw. No user-specific paths are baked in.
DEFAULT_STATE_ROOT = Path(os.environ.get("OPENCLAW_STATE_DIR") or Path.home() / ".openclaw")
DEFAULT_STATE_FILE = DEFAULT_STATE_ROOT / "state" / "message-loop-guard.json"
DEFAULT_LOG_FILE = DEFAULT_STATE_ROOT / "logs" / "message-loop-guard.log"
# Prefer whatever `openclaw` is on PATH; keep the npm-global location as a fallback.
OPENCLAW_BIN_CANDIDATES = ("openclaw", os.path.expanduser("~/.npm-global/bin/openclaw"))
_WS_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class SessionTarget:
    agent_id: str
    session_key: str
    session_id: str
    file_path: Path


@dataclass(frozen=True)
class ToolResult:
    is_error: bool
    signature: str
    timestamp_ms: int


def now_epoch() -> float:
    return time.time()


def parse_iso_ms(value: Any) -> int:
    if not isinstance(value, str) or not value:
        return 0
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return 0


def log(message: str, log_file: Path | None) -> None:
    line = f"{datetime.now(timezone.utc).isoformat()} {message}"
    print(line, flush=True)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def save_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(part for part in parts if part)
    return ""


def normalize(text: str, limit: int = 300) -> str:
    return _WS_RE.sub(" ", text).strip()[:limit]


def classify_tool_result(message: dict[str, Any], timestamp_ms: int) -> ToolResult:
    """Turn a toolResult transcript message into (is_error, signature).

    The signature is stable across loop iterations even when the model reworts
    the *request* slightly, because the rejection text is identical each time.
    """
    tool_name = str(message.get("toolName") or "")
    text = text_from_content(message.get("content"))
    is_error = False
    detail = text
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            status = str(parsed.get("status") or "").lower()
            if status == "error" or parsed.get("error"):
                is_error = True
                detail = str(parsed.get("error") or parsed.get("message") or text)
                tool_name = str(parsed.get("tool") or tool_name)
    except (json.JSONDecodeError, TypeError):
        # Fall back to a textual error heuristic for tools that do not emit the
        # structured {status,error} shape.
        lowered = text.lower()
        if '"status": "error"' in lowered or '"status":"error"' in lowered or lowered.startswith("error"):
            is_error = True
    signature = f"{tool_name}|{normalize(detail)}"
    return ToolResult(is_error=is_error, signature=signature, timestamp_ms=timestamp_ms)


def discover_targets(state_root: Path) -> list[SessionTarget]:
    targets: list[SessionTarget] = []
    for sessions_json in (state_root / "agents").glob("*/sessions/sessions.json"):
        agent_id = sessions_json.parent.parent.name
        sessions = load_json(sessions_json, {})
        if not isinstance(sessions, dict):
            continue
        for session_key, meta in sessions.items():
            if not isinstance(meta, dict):
                continue
            session_id = meta.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                continue
            file_path = sessions_json.parent / f"{session_id}.jsonl"
            if file_path.exists():
                targets.append(SessionTarget(agent_id, session_key, session_id, file_path))
    return targets


def read_tool_results(file_path: Path, tail_lines: int = 200) -> list[ToolResult]:
    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    results: list[ToolResult] = []
    for line in lines[-tail_lines:]:
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("type") != "message":
            continue
        message = row.get("message")
        if not isinstance(message, dict) or message.get("role") != "toolResult":
            continue
        timestamp_ms = parse_iso_ms(row.get("timestamp")) or parse_iso_ms(message.get("timestamp"))
        results.append(classify_tool_result(message, timestamp_ms))
    return results


def detect_loop(results: list[ToolResult], threshold: int) -> str | None:
    """Return the offending signature if the last `threshold` tool results are
    all errors sharing one signature, else None."""
    if len(results) < threshold:
        return None
    tail = results[-threshold:]
    first_sig = tail[0].signature
    if all(r.is_error and r.signature == first_sig for r in tail):
        return first_sig
    return None


def run_gateway_call(method: str, params: dict[str, Any], timeout: int) -> dict[str, Any] | None:
    payload = json.dumps(params)
    last_err: str | None = None
    for binary in OPENCLAW_BIN_CANDIDATES:
        try:
            proc = subprocess.run(
                [binary, "gateway", "call", method, "--params", payload, "--json", "--timeout", "10000"],
                capture_output=True, text=True, timeout=timeout,
            )
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            last_err = "timeout"
            continue
        out = proc.stdout or ""
        start, end = out.find("{"), out.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(out[start : end + 1])
            except json.JSONDecodeError:
                last_err = f"unparseable output: {out[:200]}"
        else:
            last_err = f"no json (exit {proc.returncode}): {(proc.stderr or out)[:200]}"
    if last_err:
        raise RuntimeError(last_err)
    return None


def abort_session(target: SessionTarget, timeout: int) -> dict[str, Any] | None:
    # sessionKey already encodes the agent (agent:<id>:...); the handler infers
    # agentId from it, so we pass sessionKey alone to avoid mismatch errors.
    return run_gateway_call("chat.abort", {"sessionKey": target.session_key}, timeout)


def scan_once(args: argparse.Namespace, state: dict[str, Any], log_file: Path | None) -> None:
    active_cutoff = now_epoch() - args.active_seconds
    for target in discover_targets(args.state_root):
        try:
            if target.file_path.stat().st_mtime < active_cutoff:
                continue  # stale session, not currently running
        except FileNotFoundError:
            continue
        results = read_tool_results(target.file_path)
        signature = detect_loop(results, args.threshold)
        if signature is None:
            continue
        # Authoritative recency gate: only act if the trailing errors are being
        # appended *now*. A stale transcript that merely ends in old loop errors
        # (e.g. mtime bumped by a resume) must not be aborted. Requires the newest
        # tool result to carry a fresh timestamp; if timestamps are missing we fall
        # back to the mtime prefilter already applied above.
        last_ts_ms = results[-1].timestamp_ms
        if last_ts_ms and (now_epoch() * 1000 - last_ts_ms) > args.active_seconds * 1000:
            continue
        prev = state.get(target.session_key)
        if (
            isinstance(prev, dict)
            and prev.get("signature") == signature
            and now_epoch() - float(prev.get("aborted_at", 0)) < args.cooldown_seconds
        ):
            continue  # already handled this exact loop within the cooldown window
        short_sig = signature[:160]
        log(
            f"LOOP detected agent={target.agent_id} session={target.session_key} "
            f"threshold={args.threshold} signature={short_sig!r}",
            log_file,
        )
        if args.dry_run:
            # A dry run must not persist state — writing it would suppress a real
            # abort later via the cooldown window.
            log(f"DRY-RUN: would chat.abort session={target.session_key}", log_file)
            continue
        try:
            result = abort_session(target, args.call_timeout)
            log(f"ABORTED session={target.session_key} result={json.dumps(result)}", log_file)
        except RuntimeError as error:
            log(f"ABORT FAILED session={target.session_key} error={error}", log_file)
            continue
        state[target.session_key] = {
            "signature": signature,
            "aborted_at": now_epoch(),
            "agent_id": target.agent_id,
        }
        save_json_atomic(args.state_file, state)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", type=Path, default=DEFAULT_STATE_ROOT)
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE)
    parser.add_argument("--log-file", type=Path, default=DEFAULT_LOG_FILE)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--threshold", type=int, default=5,
                        help="consecutive identical tool errors before aborting")
    parser.add_argument("--active-seconds", type=float, default=180.0,
                        help="only inspect sessions whose transcript changed within this window")
    parser.add_argument("--cooldown-seconds", type=float, default=120.0,
                        help="do not re-abort the same session+signature within this window")
    parser.add_argument("--call-timeout", type=int, default=25)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true", help="scan a single time and exit")
    args = parser.parse_args()

    log_file = args.log_file
    log(
        f"message-loop-guard starting threshold={args.threshold} poll={args.poll_seconds}s "
        f"cooldown={args.cooldown_seconds}s dry_run={args.dry_run}",
        log_file,
    )
    state = load_json(args.state_file, {})
    if not isinstance(state, dict):
        state = {}

    while True:
        try:
            scan_once(args, state, log_file)
        except Exception as error:  # never let the guard die on a transient error
            log(f"scan error: {type(error).__name__}: {error}", log_file)
        if args.once:
            return 0
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
