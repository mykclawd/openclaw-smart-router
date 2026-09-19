import { describe, expect, it } from 'vitest';
import { analyzePrompt } from '../src/analyzer.js';
import { scopePromptForJev } from '../src/promptScope.js';
import { JevClient } from '../src/jevClient.js';
import { buildQuestions, classifyWithJev, interpret, mergeJevIntoAnalysis, REASONING_LEVELS, TIER_REASONING_FLOOR } from '../src/jevAnalysis.js';
import type { ChatCompletionRequest } from '../src/types.js';

/** A request shaped like the ones OpenClaw actually sends: huge envelope, small real ask. */
function openClawRequest(ask: string): ChatCompletionRequest {
  return {
    model: 'surplus-smart-router',
    stream: false,
    tools: [{ type: 'function', function: { name: 'message', description: 'send a message' } }],
    messages: [
      {
        role: 'system',
        // Condensed from the real OpenClaw dev-brain system prompt, keeping the terms that were
        // measured tripping the keyword detector in production.
        content: 'You are a personal assistant running inside OpenClaw. Use the `message` tool to send the final user-visible answer. Final assistant text is not automatically delivered in this run. exec before answering: run commands, build scripts, unit test. Always verify build/lint before claiming something works. Code changes in properly formatted code blocks with language tags. Never send a transaction or approve a token from the wallet without confirmation.',
      },
      {
        role: 'user',
        content: `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n{"chat_id":"channel:150971","sender":{"name":"myk.eth"}}\n\`\`\`\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n## Media Generation Tasks\n- tool=image_generate; none\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\n\n${ask}\n\nDelivery: Final assistant text is not automatically delivered in this run. Use the \`message\` tool to send the final user-visible answer.`,
      },
    ],
  } as ChatCompletionRequest;
}

describe('promptScope', () => {
  it('strips the OpenClaw envelope and keeps the actual ask', () => {
    const scoped = scopePromptForJev(openClawRequest('what time is the game tonight?'));
    expect(scoped.empty).toBe(false);
    expect(scoped.state).toContain('what time is the game tonight?');
    expect(scoped.state).not.toContain('openclaw:ctx');
    expect(scoped.state).not.toContain('BEGIN_OPENCLAW_INTERNAL_CONTEXT');
    expect(scoped.state).not.toContain('Final assistant text is not automatically delivered');
    expect(scoped.strippedChars).toBeGreaterThan(0);
  });

  it('removes the boilerplate that made the keyword analyzer fire on everything', () => {
    // The live measurement: 95.6% of requests tripped funds-movement, 98.6% coding, on envelope text.
    const request = openClawRequest('what time is the game tonight?');
    const heuristic = analyzePrompt(request);
    expect(heuristic.fundsMovementRisk).toBe(true); // the bug, reproduced
    expect(heuristic.coding).toBe(true);

    const scoped = scopePromptForJev(request);
    const lower = scoped.state.toLowerCase();
    // None of the terms that tripped the detector survive scoping.
    for (const term of ['token', 'wallet', 'transaction', 'exec', 'build scripts']) {
      expect(lower).not.toContain(term);
    }
  });

  it('keeps the tail when the turn is longer than the cap', () => {
    const request = openClawRequest(`${'x'.repeat(5000)}\nso what should I do?`);
    const scoped = scopePromptForJev(request, 200);
    expect(scoped.state.length).toBeLessThanOrEqual(200);
    expect(scoped.state).toContain('so what should I do?');
  });

  it('strips the ctx block even when the decorative brackets differ', () => {
    // Regression: testing with U+29FC/U+29FD instead of the real U+27E6/U+27E7 leaked the whole
    // JSON blob into jev's state. The marker text is stable; the brackets are presentation.
    for (const [open, close] of [['⟦', '⟧'], ['⧼', '⧽'], ['', '']]) {
      const request = {
        model: 'surplus-smart-router',
        messages: [{
          role: 'user',
          content: `Conversation info: ${open}openclaw:ctx${close}\n\`\`\`json\n{"chat_id":"c","sender":{"name":"myk.eth"}}\n\`\`\`\n\nwhat time is it?`,
        }],
      } as ChatCompletionRequest;
      const scoped = scopePromptForJev(request);
      expect(scoped.state).toBe('what time is it?');
      expect(scoped.state).not.toContain('chat_id');
    }
  });

  it('falls back to the newest user message that survives stripping', () => {
    // OpenClaw appends context-only envelope injections as user messages (continuation nudges,
    // post-tool re-prompts), so the LAST user message can strip to empty while the turn's real ask
    // sits in an earlier user message. Live 2026-09-19: every decision in an active session failed
    // `empty_state` because only the newest user message was considered — jev never classified.
    const request = {
      model: 'surplus-smart-router',
      messages: [
        { role: 'system', content: 'You are a personal assistant.' },
        { role: 'user', content: 'what time is the game tonight?' },
        { role: 'assistant', content: 'Checking now.' },
        {
          role: 'user',
          content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info: \u27e6openclaw:ctx\u27e7\n```json\n{"chat_id":"channel:150971"}\n```\n\nDelivery: Final assistant text is not automatically delivered.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        },
      ],
    } as ChatCompletionRequest;
    const scoped = scopePromptForJev(request);
    expect(scoped.empty).toBe(false);
    expect(scoped.state).toBe('what time is the game tonight?');
  });

  it('reports empty when nothing survives stripping', () => {
    const request = {
      model: 'surplus-smart-router',
      messages: [{ role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>' }],
    } as ChatCompletionRequest;
    expect(scopePromptForJev(request).empty).toBe(true);
  });

  it('REGRESSION: message_tool delivery detection still reads the full message array', () => {
    // promptScope must never be applied to this signal. It is the 2026-07-12 mitigation for the
    // Discord silent-reply bug; scoping it to the user turn would let grok-4.3 be picked again.
    const analysis = analyzePrompt(openClawRequest('say hi'));
    expect(analysis.requiresMessageToolDelivery).toBe(true);
  });
});

describe('jev question set', () => {
  it('asks only the judgments code cannot compute', () => {
    const questions = buildQuestions();
    expect(Object.keys(questions).sort()).toEqual(['domain', 'funds_movement', 'reasoning_tier']);
    // Structural facts must never be delegated to the model.
    for (const key of ['tools', 'vision', 'structured_output', 'context_tokens']) {
      expect(questions).not.toHaveProperty(key);
    }
    expect(questions.reasoning_tier.type).toBe('score');
    expect((questions.reasoning_tier as { criteria: string[] }).criteria).toHaveLength(REASONING_LEVELS.length);
  });
});

function scoreResult(score: number, confidence: number, noul = 0) {
  return {
    response: {
      model: 'jev-1.13.0',
      answers: {
        reasoning_tier: { type: 'score' as const, score, confidence, legend: {}, probabilities: {} },
        funds_movement: { type: 'noul' as const, noul },
        domain: { type: 'choice' as const, choice: 'coding', probabilities: {}, confidence: 0.9 },
      },
    },
    failure: null,
    latencyMs: 42,
  };
}

describe('confidence gating', () => {
  it('rounds to nearest tier when confident', () => {
    expect(interpret(scoreResult(2.4, 0.9), 's', 0)?.reasoningTier).toBe(2);
  });

  it('rounds UP when unsure, so an ambiguous ask gets the more capable model', () => {
    expect(interpret(scoreResult(2.1, 0.3), 's', 0)?.reasoningTier).toBe(3);
  });

  it('never exceeds the top tier', () => {
    expect(interpret(scoreResult(4.0, 0.2), 's', 0)?.reasoningTier).toBe(REASONING_LEVELS.length - 1);
  });

  it('treats an uncertain funds answer as risky', () => {
    // A false negative here could let a weak model drive a real transaction.
    expect(interpret(scoreResult(1, 0.9, 0.30), 's', 0)?.fundsMovement).toBe(true);
    expect(interpret(scoreResult(1, 0.9, 0.05), 's', 0)?.fundsMovement).toBe(false);
  });
});

describe('merge into analysis', () => {
  it('lets structural facts win over jev', () => {
    const base = analyzePrompt(openClawRequest('draw me a diagram'));
    const jev = interpret(scoreResult(1, 0.9, 0.01), 'draw me a diagram', 0)!;
    const merged = mergeJevIntoAnalysis(base, jev);
    // tools are structurally present, so the category stays tool_use regardless of jev's domain.
    expect(merged.category).toBe('tool_use');
    expect(merged.tools).toBe(true);
    // jev clears the false funds-risk flag the keyword matcher set.
    expect(base.fundsMovementRisk).toBe(true);
    expect(merged.fundsMovementRisk).toBe(false);
  });

  it('keeps the coding filter when jev labels a coding request as analysis', () => {
    // jev's domain Choice is relative — it returns exactly one option — so a real coding question
    // can come back as `analysis`. Replacing `coding` with the Choice alone would silently disable
    // the coding-capability filter. The scoped-text keyword check is the backstop.
    const request = openClawRequest('why is this function slow?');
    const base = analyzePrompt(request);
    const jev = interpret(
      {
        response: {
          model: 'jev-1.13.0',
          answers: {
            reasoning_tier: { type: 'score' as const, score: 3, confidence: 0.9, legend: {}, probabilities: {} },
            funds_movement: { type: 'noul' as const, noul: 0.01 },
            domain: { type: 'choice' as const, choice: 'analysis', probabilities: {}, confidence: 0.8 },
          },
        },
        failure: null,
        latencyMs: 10,
      },
      'why is this function slow?',
      0,
    )!;
    expect(jev.domain).toBe('analysis');
    expect(mergeJevIntoAnalysis(base, jev).coding).toBe(true);
  });

  it('drops the coding filter when the scoped ask is genuinely not about code', () => {
    const base = analyzePrompt(openClawRequest('what time is it?'));
    expect(base.coding).toBe(true); // envelope false positive
    const jev = interpret(scoreResult(0, 0.95, 0.01), 'what time is it?', 0)!;
    // scoreResult fixes domain to 'coding'; override to the realistic answer for this ask.
    const merged = mergeJevIntoAnalysis(base, { ...jev, domain: 'general' });
    expect(merged.coding).toBe(false);
  });

  it('maps tier to a monotonic reasoning floor', () => {
    for (let i = 1; i < TIER_REASONING_FLOOR.length; i += 1) {
      expect(TIER_REASONING_FLOOR[i]).toBeGreaterThan(TIER_REASONING_FLOOR[i - 1]);
    }
  });
});

describe('fail-open behaviour', () => {
  const request = openClawRequest('refactor this function');

  it('returns no analysis when the key is missing', async () => {
    const client = new JevClient('https://api.typesafe.ai/v1', undefined, 1500, 'jev-latest', fetch);
    expect(client.enabled).toBe(false);
    const out = await classifyWithJev(client, request, 12000);
    expect(out.analysis).toBeNull();
    expect(out.failure?.kind).toBe('disabled');
  });

  it('returns no analysis on timeout rather than throwing', async () => {
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as unknown as typeof fetch;
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 20, 'jev-latest', hangingFetch);
    const out = await classifyWithJev(client, request, 12000);
    expect(out.analysis).toBeNull();
    expect(out.failure?.kind).toBe('timeout');
  });

  it.each([
    [401, 'auth'],
    [422, 'bad_request'],
    [429, 'rate_limited'],
    [529, 'overloaded'],
  ])('classifies HTTP %i as %s without throwing', async (status, kind) => {
    const erroringFetch = (async () => new Response('nope', { status })) as unknown as typeof fetch;
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', erroringFetch);
    const out = await classifyWithJev(client, request, 12000);
    expect(out.analysis).toBeNull();
    expect(out.failure?.kind).toBe(kind);
  });

  it('returns no analysis on a malformed body', async () => {
    const badFetch = (async () => new Response('{"nope":1}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', badFetch);
    const out = await classifyWithJev(client, request, 12000);
    expect(out.analysis).toBeNull();
    expect(out.failure?.kind).toBe('malformed');
  });

  it('sends the scoped state, not the raw message array', async () => {
    let sentBody: { state?: string } = {};
    const capturingFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify(scoreResult(3, 0.9).response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', capturingFetch);
    const out = await classifyWithJev(client, request, 12000);
    expect(out.analysis).not.toBeNull();
    expect(sentBody.state).toContain('refactor this function');
    expect(sentBody.state).not.toContain('Final assistant text is not automatically delivered');
  });
});

describe('classification cache', () => {
  const request = openClawRequest('what time is it?');
  const okFetch = (counter: { calls: number }) => (async () => {
    counter.calls += 1;
    return new Response(JSON.stringify(scoreResult(1, 0.9).response), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  it('serves a repeated identical prompt from cache instead of re-calling jev', async () => {
    const counter = { calls: 0 };
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', okFetch(counter), 60000);
    const first = await classifyWithJev(client, request, 12000);
    const second = await classifyWithJev(client, request, 12000);
    expect(counter.calls).toBe(1);
    expect(first.analysis?.reasoningTier).toBe(second.analysis?.reasoningTier);
    expect(second.analysis?.latencyMs).toBe(0);
    expect(client.cacheStats).toEqual({ size: 1, hits: 1, misses: 1 });
  });

  it('calls jev again once the TTL has passed', async () => {
    const counter = { calls: 0 };
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', okFetch(counter), 1);
    await classifyWithJev(client, request, 12000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await classifyWithJev(client, request, 12000);
    expect(counter.calls).toBe(2);
  });

  it('never caches a failure — a transient 529 must not pin the router to the heuristic', async () => {
    const counter = { calls: 0 };
    const flaky = (async () => {
      counter.calls += 1;
      if (counter.calls === 1) return new Response('busy', { status: 529 });
      return new Response(JSON.stringify(scoreResult(1, 0.9).response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', flaky, 60000);
    const first = await classifyWithJev(client, request, 12000);
    expect(first.failure?.kind).toBe('overloaded');
    const second = await classifyWithJev(client, request, 12000);
    expect(second.analysis).not.toBeNull();
    expect(counter.calls).toBe(2);
    expect(client.cacheStats.size).toBe(1);
  });

  it('is disabled when the TTL is 0', async () => {
    const counter = { calls: 0 };
    const client = new JevClient('https://api.typesafe.ai/v1', 'k', 1500, 'jev-latest', okFetch(counter), 0);
    await classifyWithJev(client, request, 12000);
    await classifyWithJev(client, request, 12000);
    expect(counter.calls).toBe(2);
  });
});
