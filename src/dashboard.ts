export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Smart Router</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e8ee; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a7; margin-bottom: 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: #171a21; border: 1px solid #262b36; border-radius: 8px; padding: 14px; }
  .tile .label { color: #8b93a7; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .tile .value { font-size: 22px; margin-top: 4px; }
  h2 { font-size: 14px; color: #8b93a7; text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; background: #171a21; border: 1px solid #262b36; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #22262f; white-space: nowrap; }
  th { color: #8b93a7; font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .ok { color: #7ee2a8; }
  .err { color: #f2727f; }
  .muted { color: #8b93a7; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>OpenClaw Smart Router</h1>
<div class="sub">Live routing stats · refreshes every 10s · <span id="updated" class="muted"></span></div>
<div class="tiles" id="tiles"></div>
<h2>Models</h2>
<div class="wrap"><table id="models"><thead><tr>
  <th>Model</th><th>Requests</th><th>Success</th><th>Errors</th><th>Avg latency</th><th>Feedback</th><th>Avg rating</th><th>Est. cost</th><th>Last used</th>
</tr></thead><tbody></tbody></table></div>
<h2>Recent decisions</h2>
<div class="wrap"><table id="history"><thead><tr>
  <th>Time</th><th>Requested</th><th>Selected</th><th>Routed</th><th>Category</th><th>Status</th><th>Latency</th><th>Reason</th>
</tr></thead><tbody></tbody></table></div>
<script>
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function fmtMs(ms) { return ms == null ? '—' : Math.round(ms) + ' ms'; }
function fmtRating(rating) { return rating == null ? '—' : Number(rating).toFixed(2); }
function fmtCost(usd) { return usd == null ? '—' : '$' + Number(usd).toFixed(4); }
function tile(label, value, cls) {
  return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value ' + (cls || '') + '">' + esc(value) + '</div></div>';
}
async function refresh() {
  try {
    const [statsRes, historyRes] = await Promise.all([
      fetch('/stats'),
      fetch('/routing-history?limit=50'),
    ]);
    const stats = await statsRes.json();
    const history = await historyRes.json();
    const totals = stats.totals;
    document.getElementById('tiles').innerHTML =
      tile('Requests', totals.requests) +
      tile('Routed', totals.routed) +
      tile('Errors', totals.errors, totals.errors > 0 ? 'err' : 'ok') +
      tile('Avg latency', fmtMs(totals.avg_latency_ms)) +
      tile('Feedback', totals.feedback_count) +
      tile('Avg rating', fmtRating(totals.avg_rating)) +
      tile('Est. cost', fmtCost(totals.total_estimated_cost_usd)) +
      tile('Prompt tok', totals.total_prompt_tokens ?? '—') +
      tile('Completion tok', totals.total_completion_tokens ?? '—');
    document.querySelector('#models tbody').innerHTML = stats.models.map((row) =>
      '<tr><td>' + esc(row.selected_model) + '</td><td>' + row.requests + '</td><td class="ok">' + row.successes +
      '</td><td class="' + (row.errors > 0 ? 'err' : 'muted') + '">' + row.errors + '</td><td>' + fmtMs(row.avg_latency_ms) +
      '</td><td>' + row.feedback_count + '</td><td>' + fmtRating(row.avg_rating) + '</td><td>' + fmtCost(row.total_estimated_cost_usd) + '</td><td class="muted">' + esc(row.last_used || '—') + '</td></tr>'
    ).join('') || '<tr><td colspan="9" class="muted">No requests yet</td></tr>';
    document.querySelector('#history tbody').innerHTML = history.data.map((row) =>
      '<tr><td class="muted">' + esc(row.created_at) + '</td><td>' + esc(row.requested_model) + '</td><td>' + esc(row.selected_model) +
      '</td><td>' + (row.routed ? 'yes' : 'no') + '</td><td>' + esc(row.category) +
      '</td><td class="' + (row.status === 'error' ? 'err' : row.status === 'success' ? 'ok' : 'muted') + '">' + esc(row.status) +
      '</td><td>' + fmtMs(row.latency_ms) + '</td><td class="muted">' + esc(row.decision?.reason || '') + '</td></tr>'
    ).join('') || '<tr><td colspan="8" class="muted">No history yet</td></tr>';
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    document.getElementById('updated').textContent = 'refresh failed: ' + error;
  }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`;
