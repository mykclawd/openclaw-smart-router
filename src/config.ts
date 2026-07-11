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
