import type { ChatCompletionRequest, ChatMessage, PromptAnalysis, PromptCategory } from './types.js';

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (obj.type === 'image_url' || obj.image_url) return '[image]';
        return JSON.stringify(obj);
      }
      return String(item ?? '');
    }).join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function messageText(message: ChatMessage): string {
  return stringifyContent(message.content);
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

const fundActionTerms = [
  'approve', 'approval', 'allowance', 'spender', 'send', 'transfer', 'swap', 'bridge', 'deposit', 'withdraw',
  'buy', 'sell', 'trade', 'order', 'execute', 'sign', 'submit', 'rebalance', 'liquidate',
];

const fundObjectTerms = [
  'fund', 'funds', 'money', 'usdc', 'eth', 'weth', 'token', 'erc-20', 'erc20', 'wallet', 'contract',
  'safe tx', 'gnosis safe', 'transaction', 'tx ', 'on-chain', 'onchain', 'bankr', 'definitive',
  'cow', 'base chain', 'spender',
];

const explicitFundRiskTerms = [
  'sign and submit', 'execute that tx', 'execute the tx', 'execute this tx', 'safe tx',
  'approve usdc', 'approve it to a contract', 'erc-20 approve', 'erc20 approve',
  'move funds', 'moves funds', 'send usdc', 'transfer usdc', 'place order',
];

function detectsFundsMovementRisk(lower: string): boolean {
  if (includesAny(lower, explicitFundRiskTerms)) return true;
  return includesAny(lower, fundActionTerms) && includesAny(lower, fundObjectTerms);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function analyzePrompt(request: ChatCompletionRequest): PromptAnalysis {
  const text = request.messages.map(messageText).join('\n');
  const lower = text.toLowerCase();
  const reasons: string[] = [];

  const coding = includesAny(lower, [
    'typescript', 'javascript', 'python', 'rust', 'golang', 'code', 'function', 'class ', 'debug', 'stack trace',
    'compile', 'unit test', 'sql', 'regex', 'api endpoint', 'dockerfile', 'eslint', 'vitest', 'fastify',
  ]);
  if (coding) reasons.push('coding keywords detected');

  const vision = JSON.stringify(request.messages).toLowerCase().includes('image_url') || lower.includes('[image]');
  if (vision) reasons.push('image content detected');

  let tools = Boolean(request.tools || request.functions) || includesAny(lower, ['tool call', 'function call', 'use the tool', 'call the api']);

  const requiresMessageToolDelivery = includesAny(lower, [
    'final assistant text is not automatically delivered',
    'use the `message` tool',
    'use message(action=send)',
    'source replies are not automatically delivered',
    'visible replies require `message`',
  ]);
  if (requiresMessageToolDelivery) reasons.push('visible message_tool delivery required');
  if (requiresMessageToolDelivery) tools = true;

  const fundsMovementRisk = detectsFundsMovementRisk(lower);
  if (fundsMovementRisk) {
    reasons.push('funds movement or allowance risk detected');
    tools = true;
  }
  if (tools) reasons.push('tool/function use detected');

  const structuredOutput = Boolean(request.response_format) || includesAny(lower, [
    'json schema', 'valid json', 'return json', 'structured output', 'csv', 'yaml', 'xml', 'schema',
  ]);
  if (structuredOutput) reasons.push('structured output requested');

  const analysisTerms = includesAny(lower, [
    'analyze', 'reason', 'prove', 'root cause', 'architecture', 'tradeoff', 'compare', 'evaluate', 'derive',
    'hypothesis', 'investigate', 'design', 'plan', 'complex', 'step by step',
  ]);
  if (analysisTerms) reasons.push('analysis/reasoning terms detected');

  const writingTerms = includesAny(lower, ['write a story', 'poem', 'tone', 'brand voice', 'creative', 'slogan', 'lyrics', 'rewrite', 'edit this', 'blog post', 'press release']);
  if (writingTerms) reasons.push('writing/creative terms detected');

  const mathTerms = includesAny(lower, ['calculate', 'equation', 'algebra', 'calculus', 'probability', 'statistics', 'theorem', 'mathematical', 'solve for', 'integral', 'derivative']);
  if (mathTerms) reasons.push('math terms detected');

  const estimatedContextTokens = request.messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
  if (estimatedContextTokens > 16000) reasons.push('large context detected');

  let category: PromptCategory = 'general';
  if (vision) category = 'vision';
  else if (tools) category = 'tool_use';
  else if (coding) category = 'coding';
  else if (structuredOutput) category = 'structured';
  else if (mathTerms) category = 'math';
  else if (analysisTerms) category = 'analysis';
  else if (writingTerms) category = 'writing';

  let complexity = 0.25;
  complexity += Math.min(0.30, estimatedContextTokens / 100000);
  if (analysisTerms) complexity += 0.22;
  if (coding) complexity += 0.18;
  if (tools) complexity += 0.12;
  if (structuredOutput) complexity += 0.08;
  if (vision) complexity += 0.08;
  if (mathTerms) complexity += 0.18;
  if (request.messages.length > 8) complexity += 0.07;
  if (fundsMovementRisk) complexity += 0.30;
  complexity = Math.max(0, Math.min(1, complexity));

  const latency = complexity < 0.35 && estimatedContextTokens < 2000 ? 'low' : complexity > 0.70 || estimatedContextTokens > 24000 ? 'high' : 'normal';
  reasons.push(`estimated context ${estimatedContextTokens} tokens`);
  reasons.push(`complexity ${complexity.toFixed(2)}`);

  return {
    category,
    complexity,
    coding,
    vision,
    tools,
    structuredOutput,
    requiresMessageToolDelivery,
    fundsMovementRisk,
    estimatedContextTokens,
    latency,
    reasons,
  };
}
