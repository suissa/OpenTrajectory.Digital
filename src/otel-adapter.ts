import type { Attributes, Expansion, TrackSnapshot } from "./model.js";
import type { TrajectoryExporter } from "./exporter.js";
export interface OpenTelemetrySpanLike {
  setAttribute(name: string, value: string | number | boolean): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  recordException?(exception: Error): unknown;
  end(endTime?: number): void;
}
export interface OpenTelemetryTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): OpenTelemetrySpanLike;
}
export class OpenTelemetryAdapter implements TrajectoryExporter {
  private readonly spans = new Map<string, OpenTelemetrySpanLike>();
  constructor(private readonly tracer: OpenTelemetryTracerLike) {}
  onTrackStarted(track: TrackSnapshot): void {
    const span = this.tracer.startSpan(track.name, { attributes: { "open_trajectory.trajectory_id": track.trajectoryId, "open_trajectory.track_id": track.id, "open_trajectory.parent_track_id": track.parentId ?? "", "open_trajectory.depth": track.depth, "open_trajectory.sequence": track.sequence, ...clean(track.attributes) }});
    this.spans.set(track.id, span);
  }
  onExpansion(track: TrackSnapshot, expansion: Expansion): void {
    const span = this.spans.get(track.id); span?.setAttribute("open_trajectory.expansion." + expansion.id + ".label", expansion.label); span?.setAttribute("open_trajectory.expansion." + expansion.id + ".offset_ms", expansion.offsetMs);
  }
  onTrackEnded(track: TrackSnapshot): void {
    const span = this.spans.get(track.id); if (!span) return; span.setAttribute("open_trajectory.duration_ms", track.durationMs ?? 0);
    if (track.status === "error") { span.setStatus?.({ code: 2, message: track.error?.message }); span.recordException?.(new Error(track.error?.message ?? "Track failed")); } else span.setStatus?.({ code: 1 });
    span.end(); this.spans.delete(track.id);
  }
}
function clean(attributes: Attributes): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"));
}