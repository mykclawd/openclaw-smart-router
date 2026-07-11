import { loadConfig } from './config.js';
import { HistoryStore } from './history.js';
import { DEFAULT_PROFILES, evaluateProfiles } from './evaluate.js';

const config = loadConfig();
const historyStore = new HistoryStore(config.sqlitePath);

const profiles = [
  { name: 'current', weights: config.utilityWeights },
  ...DEFAULT_PROFILES,
];

const report = evaluateProfiles(historyStore.list(1000), historyStore.modelStats(), profiles);
historyStore.close();

if (report.evaluatedRequests === 0) {
  console.log(`No routed requests with stored scores found in ${config.sqlitePath}. Route some traffic first.`);
  process.exit(0);
}

console.log(`Offline weight evaluation over ${report.evaluatedRequests} routed requests (${report.totalRows} history rows)\n`);
const header = ['profile', 'outcome-quality', 'cost-score', 'changed-picks'].map((column) => column.padEnd(18)).join('');
console.log(header);
for (const result of report.results) {
  console.log(
    result.name.padEnd(18)
    + String(result.avgOutcomeQuality).padEnd(18)
    + String(result.avgCostScore).padEnd(18)
    + `${result.selectionChanges}/${result.evaluatedRequests}`,
  );
}
const recommended = report.results.find((result) => result.name === report.recommended);
console.log(`\nRecommended profile: ${report.recommended}`);
if (recommended && report.recommended !== 'current') {
  console.log('Apply it live with:');
  console.log(`  curl -X PUT localhost:${config.port}/config/weights -H 'content-type: application/json' -d '${JSON.stringify(recommended.weights)}'`);
  console.log('Or persist it via UTILITY_WEIGHTS in .env.');
}
