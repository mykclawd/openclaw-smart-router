import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { FeedbackRow, HistoryRow, RoutingDecision } from './types.js';

export interface HistoryStartInput {
  requestId: string;
  requestedModel: string;
  selectedModel: string;
  routed: boolean;
  category: string;
  complexity: number;
  streaming: boolean;
  decision: RoutingDecision;
}

export interface HistoryFinishInput {
  status: 'success' | 'error';
  latencyMs: number;
  errorMessage?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCostUsd?: number | null;
}

export interface ModelStats {
  selected_model: string;
  requests: number;
  successes: number;
  avg_latency_ms: number | null;
  avg_rating: number | null;
  feedback_count: number;
  total_estimated_cost_usd: number | null;
}

export interface StatsSummary {
  totals: {
    requests: number;
    routed: number;
    errors: number;
    avg_latency_ms: number | null;
    feedback_count: number;
    avg_rating: number | null;
    total_prompt_tokens: number | null;
    total_completion_tokens: number | null;
    total_estimated_cost_usd: number | null;
  };
  models: Array<ModelStats & { errors: number; last_used: string | null }>;
  categories: Array<{ category: string; requests: number }>;
}

export class HistoryStore {
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ':memory:') mkdirSync(dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        routed INTEGER NOT NULL,
        category TEXT NOT NULL,
        complexity REAL NOT NULL,
        streaming INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        latency_ms INTEGER,
        error_message TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        estimated_cost_usd REAL,
        decision_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_history_created_at ON routing_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_routing_history_selected_model ON routing_history(selected_model);
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES routing_history(request_id),
        created_at TEXT NOT NULL,
        rating REAL NOT NULL,
        comment TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_request_id ON feedback(request_id);
    `);
    this.migrateAddTokenColumns();
  }

  private migrateAddTokenColumns(): void {
    const columns = this.db.pragma('table_info(routing_history)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('prompt_tokens')) {
      this.db.exec('ALTER TABLE routing_history ADD COLUMN prompt_tokens INTEGER');
    }
    if (!names.has('completion_tokens')) {
      this.db.exec('ALTER TABLE routing_history ADD COLUMN completion_tokens INTEGER');
    }
    if (!names.has('estimated_cost_usd')) {
      this.db.exec('ALTER TABLE routing_history ADD COLUMN estimated_cost_usd REAL');
    }
  }

  insertStart(input: HistoryStartInput): void {
    this.db.prepare(`
      INSERT INTO routing_history (
        request_id, created_at, requested_model, selected_model, routed, category, complexity, streaming, status, decision_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
    `).run(
      input.requestId,
      input.decision.createdAt,
      input.requestedModel,
      input.selectedModel,
      input.routed ? 1 : 0,
      input.category,
      input.complexity,
      input.streaming ? 1 : 0,
      JSON.stringify(input.decision),
    );
  }

  finish(requestId: string, status: 'success' | 'error', latencyMs: number, errorMessage?: string | null): void;
  finish(requestId: string, input: HistoryFinishInput): void;
  finish(requestId: string, input: 'success' | 'error' | HistoryFinishInput, latencyMs?: number, errorMessage: string | null = null): void {
    const opts: HistoryFinishInput = typeof input === 'string'
      ? { status: input, latencyMs: latencyMs!, errorMessage }
      : input;
    this.db.prepare(`
      UPDATE routing_history SET status = ?, latency_ms = ?, error_message = ?, prompt_tokens = ?, completion_tokens = ?, estimated_cost_usd = ? WHERE request_id = ?
    `).run(
      opts.status,
      Math.round(opts.latencyMs),
      opts.errorMessage ?? null,
      opts.promptTokens ?? null,
      opts.completionTokens ?? null,
      opts.estimatedCostUsd ?? null,
      requestId,
    );
  }

  list(limit = 100): HistoryRow[] {
    return this.db.prepare(`
      SELECT * FROM routing_history ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, limit))) as HistoryRow[];
  }

  hasRequest(requestId: string): boolean {
    return this.db.prepare('SELECT 1 FROM routing_history WHERE request_id = ?').get(requestId) != null;
  }

  insertFeedback(requestId: string, rating: number, comment: string | null = null): FeedbackRow {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO feedback (request_id, created_at, rating, comment) VALUES (?, ?, ?, ?)
    `).run(requestId, createdAt, rating, comment);
    return { id: Number(result.lastInsertRowid), request_id: requestId, created_at: createdAt, rating, comment };
  }

  modelStats(): ModelStats[] {
    return this.db.prepare(`
      SELECT rh.selected_model,
             COUNT(*) AS requests,
             SUM(CASE WHEN rh.status = 'success' THEN 1 ELSE 0 END) AS successes,
             AVG(rh.latency_ms) AS avg_latency_ms,
             fb.avg_rating AS avg_rating,
             COALESCE(fb.feedback_count, 0) AS feedback_count
      FROM routing_history rh
      LEFT JOIN (
        SELECT rh2.selected_model AS model, AVG(f.rating) AS avg_rating, COUNT(*) AS feedback_count
        FROM feedback f
        JOIN routing_history rh2 ON rh2.request_id = f.request_id
        GROUP BY rh2.selected_model
      ) fb ON fb.model = rh.selected_model
      GROUP BY rh.selected_model
    `).all() as ModelStats[];
  }

  statsSummary(): StatsSummary {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS requests,
             SUM(routed) AS routed,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             AVG(latency_ms) AS avg_latency_ms,
             SUM(prompt_tokens) AS total_prompt_tokens,
             SUM(completion_tokens) AS total_completion_tokens,
             SUM(estimated_cost_usd) AS total_estimated_cost_usd
      FROM routing_history
    `).get() as { requests: number; routed: number | null; errors: number | null; avg_latency_ms: number | null; total_prompt_tokens: number | null; total_completion_tokens: number | null; total_estimated_cost_usd: number | null };
    const feedbackTotals = this.db.prepare(`
      SELECT COUNT(*) AS feedback_count, AVG(rating) AS avg_rating FROM feedback
    `).get() as { feedback_count: number; avg_rating: number | null };
    const models = this.db.prepare(`
      SELECT rh.selected_model,
             COUNT(*) AS requests,
             SUM(CASE WHEN rh.status = 'success' THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN rh.status = 'error' THEN 1 ELSE 0 END) AS errors,
             AVG(rh.latency_ms) AS avg_latency_ms,
             MAX(rh.created_at) AS last_used,
             fb.avg_rating AS avg_rating,
             COALESCE(fb.feedback_count, 0) AS feedback_count,
             SUM(rh.estimated_cost_usd) AS total_estimated_cost_usd
      FROM routing_history rh
      LEFT JOIN (
        SELECT rh2.selected_model AS model, AVG(f.rating) AS avg_rating, COUNT(*) AS feedback_count
        FROM feedback f
        JOIN routing_history rh2 ON rh2.request_id = f.request_id
        GROUP BY rh2.selected_model
      ) fb ON fb.model = rh.selected_model
      GROUP BY rh.selected_model
      ORDER BY requests DESC
    `).all() as StatsSummary['models'];
    const categories = this.db.prepare(`
      SELECT category, COUNT(*) AS requests FROM routing_history GROUP BY category ORDER BY requests DESC
    `).all() as StatsSummary['categories'];
    return {
      totals: {
        requests: totals.requests,
        routed: totals.routed ?? 0,
        errors: totals.errors ?? 0,
        avg_latency_ms: totals.avg_latency_ms,
        feedback_count: feedbackTotals.feedback_count,
        avg_rating: feedbackTotals.avg_rating,
        total_prompt_tokens: totals.total_prompt_tokens,
        total_completion_tokens: totals.total_completion_tokens,
        total_estimated_cost_usd: totals.total_estimated_cost_usd,
      },
      models,
      categories,
    };
  }

  close(): void {
    this.db.close();
  }
}
