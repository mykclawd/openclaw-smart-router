export class Metrics {
  private requestsTotal = 0;
  private routedTotal = 0;
  private upstreamErrorsTotal = 0;
  private latenciesMs: number[] = [];
  private modelSelections = new Map<string, number>();

  recordRequest(routed: boolean, selectedModel: string): void {
    this.requestsTotal += 1;
    if (routed) this.routedTotal += 1;
    this.modelSelections.set(selectedModel, (this.modelSelections.get(selectedModel) ?? 0) + 1);
  }

  recordLatency(latencyMs: number): void {
    this.latenciesMs.push(latencyMs);
    if (this.latenciesMs.length > 1000) this.latenciesMs.shift();
  }

  recordUpstreamError(): void {
    this.upstreamErrorsTotal += 1;
  }

  snapshot(): string {
    const lines: string[] = [];
    lines.push('# HELP openclaw_smart_router_requests_total Total chat completion requests.');
    lines.push('# TYPE openclaw_smart_router_requests_total counter');
    lines.push(`openclaw_smart_router_requests_total ${this.requestsTotal}`);
    lines.push('# HELP openclaw_smart_router_routed_total Total requests routed by smart router.');
    lines.push('# TYPE openclaw_smart_router_routed_total counter');
    lines.push(`openclaw_smart_router_routed_total ${this.routedTotal}`);
    lines.push('# HELP openclaw_smart_router_upstream_errors_total Total upstream errors.');
    lines.push('# TYPE openclaw_smart_router_upstream_errors_total counter');
    lines.push(`openclaw_smart_router_upstream_errors_total ${this.upstreamErrorsTotal}`);
    lines.push('# HELP openclaw_smart_router_latency_ms_recent_average Recent average request latency in milliseconds.');
    lines.push('# TYPE openclaw_smart_router_latency_ms_recent_average gauge');
    const avg = this.latenciesMs.length ? this.latenciesMs.reduce((a, b) => a + b, 0) / this.latenciesMs.length : 0;
    lines.push(`openclaw_smart_router_latency_ms_recent_average ${avg.toFixed(2)}`);
    lines.push('# HELP openclaw_smart_router_model_selections_total Selected model count by model.');
    lines.push('# TYPE openclaw_smart_router_model_selections_total counter');
    for (const [model, count] of [...this.modelSelections.entries()].sort()) {
      lines.push(`openclaw_smart_router_model_selections_total{model=${JSON.stringify(model)}} ${count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
