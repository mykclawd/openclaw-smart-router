import { z } from 'zod';

export const UtilityWeightsSchema = z.object({
  capability: z.number().min(0).default(0.45),
  cost: z.number().min(0).default(0.25),
  latency: z.number().min(0).default(0.10),
  history: z.number().min(0).default(0.10),
  preferences: z.number().min(0).default(0.10),
});
export type UtilityWeights = z.infer<typeof UtilityWeightsSchema>;

export const UserPreferencesSchema = z.object({
  preferModels: z.array(z.string()).default([]),
  avoidModels: z.array(z.string()).default([]),
  maxInputCostPerMTok: z.number().positive().optional(),
  maxOutputCostPerMTok: z.number().positive().optional(),
  latencyBias: z.enum(['low-cost', 'balanced', 'low-latency', 'high-capability']).default('balanced'),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const RegistryModelSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  features: z.object({
    chat: z.boolean().default(true),
    streaming: z.boolean().default(true),
    coding: z.boolean().default(false),
    vision: z.boolean().default(false),
    tools: z.boolean().default(false),
    structuredOutput: z.boolean().default(false),
  }),
  contextWindow: z.number().int().positive().default(8192),
  maxOutputTokens: z.number().int().positive().default(64000),
  latencyMs: z.number().positive().default(2000),
  delivery: z.object({
    messageToolReliable: z.boolean().default(true),
  }).default({ messageToolReliable: true }),
  capabilities: z.object({
    general: z.number().min(0).max(1).default(0.5),
    coding: z.number().min(0).max(1).default(0),
    reasoning: z.number().min(0).max(1).default(0.5),
    writing: z.number().min(0).max(1).default(0.5),
    math: z.number().min(0).max(1).default(0.5),
    vision: z.number().min(0).max(1).default(0),
    tools: z.number().min(0).max(1).default(0),
    structuredOutput: z.number().min(0).max(1).default(0),
  }),
  notes: z.string().optional(),
});
export type RegistryModel = z.infer<typeof RegistryModelSchema>;

export const CapabilityRegistrySchema = z.object({
  version: z.number().int().positive().default(1),
  updatedAt: z.string().optional(),
  models: z.array(RegistryModelSchema),
});
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

export const ChatMessageSchema = z.object({
  role: z.string(),
  content: z.any().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.any().optional(),
}).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  tools: z.any().optional(),
  functions: z.any().optional(),
  response_format: z.any().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
}).passthrough();
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export type PromptCategory = 'general' | 'coding' | 'analysis' | 'writing' | 'math' | 'vision' | 'tool_use' | 'structured';

export interface PromptAnalysis {
  category: PromptCategory;
  complexity: number;
  coding: boolean;
  vision: boolean;
  tools: boolean;
  structuredOutput: boolean;
  requiresMessageToolDelivery: boolean;
  fundsMovementRisk: boolean;
  estimatedContextTokens: number;
  latency: 'low' | 'normal' | 'high';
  reasons: string[];
}

export interface LiveModel {
  id: string;
  raw: unknown;
}

export interface LivePrice {
  model: string;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  raw: unknown;
}

export interface CandidateModel {
  id: string;
  registry: RegistryModel;
  live: LiveModel;
  price?: LivePrice;
}

export interface ScoreBreakdown {
  capability: number;
  cost: number;
  latency: number;
  history: number;
  preferences: number;
  total: number;
  reasons: string[];
}

export interface RoutingDecision {
  requestId: string;
  requestedModel: string;
  selectedModel: string;
  routed: boolean;
  eligibleModels: string[];
  rejectedModels: Array<{ id: string; reasons: string[] }>;
  analysis: PromptAnalysis;
  scores: Record<string, ScoreBreakdown>;
  selectedModelPrice?: { inputCostPerMTok?: number; outputCostPerMTok?: number };
  reason: string;
  createdAt: string;
}

export const FeedbackRequestSchema = z.object({
  request_id: z.string().min(1),
  rating: z.number().min(-1).max(1),
  comment: z.string().max(2000).optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export interface FeedbackRow {
  id: number;
  request_id: string;
  created_at: string;
  rating: number;
  comment: string | null;
}

export interface HistoryRow {
  id: number;
  request_id: string;
  created_at: string;
  requested_model: string;
  selected_model: string;
  routed: number;
  category: string;
  complexity: number;
  streaming: number;
  status: string;
  latency_ms: number | null;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
  decision_json: string;
}
