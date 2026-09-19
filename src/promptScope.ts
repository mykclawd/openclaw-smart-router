import type { ChatCompletionRequest, ChatMessage } from './types.js';

/**
 * Extracts the part of a request that actually describes the user's ask, for use as jev `state`.
 *
 * Why this exists: `analyzePrompt` keyword-matches the ENTIRE concatenated message array, which on
 * this deployment is dominated by OpenClaw's system/runtime envelope. Measured against 2485 rows of
 * routing_history on 2026-09-19: 98.6% of requests tripped "coding keywords", 98.7% "analysis terms",
 * 95.6% "funds movement risk", and 98.3% saturated complexity at 1.00. The envelope contains the
 * words "code", "function", "analyze", "plan", "send", "token", "wallet" and "transaction", so the
 * classifier was reading OpenClaw's boilerplate rather than the request.
 *
 * jev has the same exposure from the other direction: its documented failure mode #5 is "large state
 * full of irrelevant detail" — accuracy falls as unrelated content grows. Handing jev the raw message
 * array would reproduce the existing bug at higher latency and a per-call price.
 *
 * IMPORTANT: this is deliberately NOT used for envelope-derived signals. `requiresMessageToolDelivery`
 * must keep scanning the full message array — it matches on OpenClaw runtime text and is the 2026-07-12
 * mitigation for the Discord silent-reply bug (grok-4.3 returning final text without calling the
 * delivery tool). Scoping it to the user turn would silently regress that fix.
 */

const CONTEXT_BLOCK_PATTERNS: RegExp[] = [
  // OpenClaw internal context injected by the UserPromptSubmit hook.
  /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g,
  // Conversation-info / chat-history envelopes: an `openclaw:ctx` marker followed by a fenced JSON
  // block. Anchored on the literal marker text rather than its decorative ⟦⟧ brackets — those are
  // presentation and a mismatched bracket character silently leaks the whole JSON blob into the
  // state (observed 2026-09-19 while testing with U+29FC instead of U+27E6).
  /[^\w\s]{0,2}openclaw:ctx[^\w\s]{0,2}\s*```(?:json)?[\s\S]*?```/g,
  /[^\w\s]{0,2}openclaw:ctx[^\w\s]{0,2}[^\n]*/g,
  // Belt and braces: a `Conversation info:` line followed by a fenced block, marker or not.
  /^[ \t]*conversation info:[^\n]*\n+```(?:json)?[\s\S]*?```/gim,
  // Harness reminders.
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  // Untrusted-content wrappers from web_fetch results pasted into a turn.
  /<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g,
];

const ENVELOPE_LINE_PREFIXES = [
  'delivery:',
  'conversation info:',
  'chat history since last reply:',
  'userpromptsubmit hook additional context:',
  'activation:',
  'runtime:',
  'current model identity:',
];

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (obj.type === 'image_url' || obj.image_url) return '[image]';
        return '';
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  return '';
}

function stripEnvelope(text: string): string {
  let out = text;
  for (const pattern of CONTEXT_BLOCK_PATTERNS) out = out.replace(pattern, ' ');
  const lines = out.split('\n').filter((line) => {
    // OpenClaw prefixes the label with a timestamp (`[Sat 2026-09-19 21:49 UTC] Conversation info:`),
    // so drop optional bracketed junk before matching envelope line prefixes.
    const lower = line.trim().toLowerCase().replace(/^\[[^\]]*\]\s*/, '');
    if (!lower) return false;
    return !ENVELOPE_LINE_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ScopedPrompt {
  /** The user's actual ask, envelope stripped. Empty when nothing survived stripping. */
  state: string;
  /** True when stripping removed everything — caller should fall back to the heuristic. */
  empty: boolean;
  /** Chars removed by envelope stripping; surfaced for shadow-mode diagnostics. */
  strippedChars: number;
}

/**
 * Returns the newest user message that survives envelope stripping, truncated to `maxChars`.
 *
 * Truncation keeps the TAIL of the turn: when a user pastes a long log or file and then asks a
 * question, the question is almost always last. jev's state budget is 32k tokens for state plus the
 * longest question, but the practical limit here is lower — accuracy degrades with irrelevant bulk,
 * so the default cap is well under the hard ceiling.
 *
 * Scans NEWEST-FIRST because OpenClaw appends context-only envelope injections as user messages:
 * continuation nudges and post-tool re-prompts carry the full
 * <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> block and no ask, so the LAST user message can strip to
 * empty while the turn's real ask sits in an earlier user message. Observed live 2026-09-19: every
 * decision in an active session failed with `empty_state` and jev never classified anything.
 */
export function scopePromptForJev(request: ChatCompletionRequest, maxChars = 12000): ScopedPrompt {
  const userMessages = request.messages.filter((message: ChatMessage) => message.role === 'user');
  let stripped = '';
  let strippedChars = 0;
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const raw = stringifyContent(userMessages[i].content);
    stripped = stripEnvelope(raw);
    strippedChars = Math.max(0, raw.length - stripped.length);
    if (stripped) break;
  }

  if (!stripped) return { state: '', empty: true, strippedChars };

  const state = stripped.length > maxChars ? stripped.slice(stripped.length - maxChars) : stripped;
  return { state, empty: false, strippedChars };
}
