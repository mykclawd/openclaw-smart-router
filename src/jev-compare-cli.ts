/**
 * Shadow-mode readout: compares what jev said against what the keyword heuristic said, over the
 * decisions stored in routing_history.
 *
 * Run with: npm run jev:compare
 *
 * This exists because shadow mode is otherwise write-only. The router has never had ground truth —
 * the feedback table is empty and routing_history stores no prompt text, so the 2485 rows that
 * predate this integration cannot be replayed. Comparison data only accumulates from here forward.
 */

import { loadConfig } from './config.js';
import { HistoryStore } from './history.js';
import type { JevDecisionRecord, RoutingDecision } from './types.js';

const config = loadConfig();
const historyStore = new HistoryStore(config.sqlitePath);
const rows = historyStore.list(5000);
historyStore.close();

interface Paired { jev: JevDecisionRecord; requestId: string; createdAt: string }

const paired: Paired[] = [];
let failures = 0;
const failureKinds = new Map<string, number>();

for (const row of rows) {
  let decision: RoutingDecision;
  try {
    decision = JSON.parse(row.decision_json) as RoutingDecision;
  } catch {
    continue;
  }
  const jev = decision.jev;
  if (!jev) continue;
  if (!jev.analysis) {
    failures += 1;
    const kind = jev.failure?.kind ?? 'unknown';
    failureKinds.set(kind, (failureKinds.get(kind) ?? 0) + 1);
    continue;
  }
  paired.push({ jev, requestId: row.request_id, createdAt: row.created_at });
}

if (paired.length === 0 && failures === 0) {
  console.log(`No jev records found in ${config.sqlitePath}.`);
  console.log('Set JEV_MODE=shadow and TYPESAFE_API_KEY, then route some traffic.');
  process.exit(0);
}

const total = paired.length + failures;
console.log(`jev shadow comparison over ${total} classified requests (${failures} fell back to the heuristic)\n`);

if (failures > 0) {
  const kinds = [...failureKinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${count}`).join(' ');
  console.log(`fallback reasons: ${kinds}\n`);
}

if (paired.length === 0) {
  console.log('No successful classifications yet — every call fell back.');
  process.exit(0);
}

const latencies = paired.map((entry) => entry.jev.latencyMs).sort((a, b) => a - b);
const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
console.log(`jev latency ms: p50=${p(0.5)} p90=${p(0.9)} p99=${p(0.99)} max=${latencies[latencies.length - 1]}\n`);

// Funds-movement is the headline disagreement: the heuristic measured 95.6% positive in production.
let heuristicFunds = 0;
let jevFunds = 0;
let bothFunds = 0;
for (const { jev } of paired) {
  if (jev.heuristic.fundsMovementRisk) heuristicFunds += 1;
  if (jev.analysis!.fundsMovement) jevFunds += 1;
  if (jev.heuristic.fundsMovementRisk && jev.analysis!.fundsMovement) bothFunds += 1;
}
const pct = (n: number) => `${((n / paired.length) * 100).toFixed(1)}%`;
console.log('funds-movement flag');
console.log(`  heuristic says yes: ${heuristicFunds} (${pct(heuristicFunds)})`);
console.log(`  jev says yes:       ${jevFunds} (${pct(jevFunds)})`);
console.log(`  both agree yes:     ${bothFunds}\n`);

const tiers = new Map<number, number>();
for (const { jev } of paired) tiers.set(jev.analysis!.reasoningTier, (tiers.get(jev.analysis!.reasoningTier) ?? 0) + 1);
console.log('jev reasoning tier distribution');
for (const tier of [...tiers.keys()].sort()) {
  console.log(`  tier ${tier}: ${tiers.get(tier)} (${pct(tiers.get(tier)!)})`);
}

const domains = new Map<string, number>();
for (const { jev } of paired) domains.set(jev.analysis!.domain, (domains.get(jev.analysis!.domain) ?? 0) + 1);
console.log('\njev domain vs heuristic category');
for (const [domain, count] of [...domains.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${domain.padEnd(10)} ${count} (${pct(count)})`);
}

const heuristicSaturated = paired.filter((entry) => entry.jev.heuristic.complexity >= 0.999).length;
console.log(`\nheuristic complexity saturated at 1.00: ${heuristicSaturated} (${pct(heuristicSaturated)})`);
const lowConfidence = paired.filter((entry) => entry.jev.analysis!.reasoningConfidence < 0.55).length;
console.log(`jev low-confidence tier answers (rounded up): ${lowConfidence} (${pct(lowConfidence)})`);

console.log('\nTo see individual disagreements:');
console.log(`  sqlite3 ${config.sqlitePath} "select json_extract(decision_json,'$.jev.analysis.state') from routing_history where json_extract(decision_json,'$.jev') is not null limit 20;"`);
