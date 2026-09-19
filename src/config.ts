import dotenv from 'dotenv';
import { z } from 'zod';
import { UserPreferencesSchema, UtilityWeightsSchema, type UserPreferences, type UtilityWeights } from './types.js';

dotenv.config();

function parseJsonEnv<T>(name: string, schema: z.ZodType<T>, fallback: unknown): T {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return schema.parse(fallback);
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${(error as Error).message}`, { cause: error });
  }
}

function splitCsv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

const RawConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8787),
  host: z.string().default('0.0.0.0'),
  logLevel: z.string().default('info'),
  surplusBaseUrl: z.string().url().default('https://api.surplusintelligence.ai/v1'),
  surplusApiKey: z.string().optional(),
  routerModelIds: z.array(z.string()).default(['surplus-smart-router', 'auto']),
  capabilityRegistryPath: z.string().default('./registry/models.json'),
  sqlitePath: z.string().default('./data/router.sqlite'),
  cacheTtlMs: z.coerce.number().int().positive().default(60000),
  requestTimeoutMs: z.coerce.number().int().positive().default(120000),
  registryWatch: z.boolean().default(true),
  // jev (TypeSafe System One) prompt classifier.
  //   off    - never call jev; keyword heuristic decides (pre-integration behaviour)
  //   shadow - call jev, persist its answers next to the heuristic's, but the HEURISTIC still decides
  //   live   - jev's judgments drive eligibility and scoring, heuristic is the fallback
  // Default is `shadow`: there is currently no ground truth to prove jev routes better (the feedback
  // table is empty and routing_history never stored prompt text, so the 2485 historical rows cannot
  // be replayed). Shadow mode is what produces that evidence.
  jevMode: z.enum(['off', 'shadow', 'live']).default('shadow'),
  jevBaseUrl: z.string().url().default('https://api.typesafe.ai/v1'),
  jevApiKey: z.string().optional(),
  jevModel: z.string().default('jev-latest'),
  // Sits in front of every completion, so keep it tight; on timeout we fall back to the heuristic.
  jevTimeoutMs: z.coerce.number().int().positive().default(1500),
  // Well under jev's 32k state ceiling: its documented failure mode #5 is accuracy loss on large
  // states full of irrelevant detail.
  jevMaxStateChars: z.coerce.number().int().positive().default(12000),
  // Short-TTL cache for jev classifications, keyed on the exact scoped state. Recurring prompts
  // (cron jobs, health pings, client retries) decide in ~0 ms instead of paying ~400 ms per call.
  // 0 disables. Only successful classifications are cached; failures always retry live.
  jevCacheTtlMs: z.coerce.number().int().min(0).default(300000),
  // JIT catalog widening: in live mode, models present in the live Surplus catalog but missing
  // from the hand-maintained registry get a DERIVED registry entry built from the live listing's
  // own metadata (supported_features, context_length, architecture, supported_parameters), so the
  // router can exploit Surplus's dynamic pricing across the full catalog instead of only the
  // models someone has hand-scored. Derived entries get conservative capability scores (see
  // router.ts) so they must WIN on price/latency to be picked — an unknown model never outranks a
  // well-scored registry model on capability alone.
  jevJitCatalog: z.boolean().default(true),
});

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export interface AppConfig extends z.infer<typeof RawConfigSchema> {
  utilityWeights: UtilityWeights;
  userPreferences: UserPreferences;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = RawConfigSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    logLevel: process.env.LOG_LEVEL,
    surplusBaseUrl: process.env.SURPLUS_BASE_URL,
    surplusApiKey: process.env.SURPLUS_API_KEY,
    routerModelIds: splitCsv(process.env.ROUTER_MODEL_IDS, ['surplus-smart-router', 'auto']),
    capabilityRegistryPath: process.env.CAPABILITY_REGISTRY_PATH,
    sqlitePath: process.env.SQLITE_PATH,
    cacheTtlMs: process.env.CACHE_TTL_MS,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
    registryWatch: parseBoolEnv(process.env.REGISTRY_WATCH, true),
    // `|| undefined` so an empty env var falls through to the default instead of failing validation.
    jevMode: process.env.JEV_MODE || undefined,
    jevBaseUrl: process.env.JEV_BASE_URL || undefined,
    // JEV_API_KEY is the name used on this deployment; TYPESAFE_API_KEY is what the vendor's docs
    // and SDKs default to. Accept either so neither name is a silent no-op.
    jevApiKey: process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || undefined,
    jevModel: process.env.JEV_MODEL || undefined,
    jevTimeoutMs: process.env.JEV_TIMEOUT_MS,
    jevMaxStateChars: process.env.JEV_MAX_STATE_CHARS,
    jevCacheTtlMs: process.env.JEV_CACHE_TTL_MS,
    jevJitCatalog: parseBoolEnv(process.env.JEV_JIT_CATALOG, true),
  });

  const utilityWeights = parseJsonEnv('UTILITY_WEIGHTS', UtilityWeightsSchema, {
    capability: 0.45,
    cost: 0.25,
    latency: 0.10,
    history: 0.10,
    preferences: 0.10,
  });
  const userPreferences = parseJsonEnv('USER_PREFERENCES', UserPreferencesSchema, {});

  const merged = { ...base, utilityWeights, userPreferences, ...overrides };
  return RawConfigSchema.extend({
    utilityWeights: UtilityWeightsSchema,
    userPreferences: UserPreferencesSchema,
  }).parse(merged);
}
