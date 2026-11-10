import type { Attributes, Expansion, Relation, TrackSnapshot, TrajectorySnapshot } from "./model.js";
import type { TrajectoryExporter } from "./exporter.js";

export interface OpenTelemetrySpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export interface OpenTelemetrySpanLinkLike {
  context: OpenTelemetrySpanContextLike;
  attributes?: Record<string, string | number | boolean>;
}

export interface OpenTelemetrySpanLike {
  setAttribute(name: string, value: string | number | boolean): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  recordException?(exception: Error): unknown;
  addEvent?(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    timestamp?: Date
  ): unknown;
  addLink?(
    context: OpenTelemetrySpanContextLike,
    attributes?: Record<string, string | number | boolean>
  ): unknown;
  spanContext?(): OpenTelemetrySpanContextLike;
  end(endTime?: number | Date): void;
}

export interface OpenTelemetrySpanOptionsLike {
  attributes?: Record<string, string | number | boolean>;
  links?: OpenTelemetrySpanLinkLike[];
  startTime?: Date;
}

export interface OpenTelemetryTracerLike {
  startSpan(
    name: string,
    options?: OpenTelemetrySpanOptionsLike,
    context?: unknown
  ): OpenTelemetrySpanLike;
}

/**
 * Optional bridge to @opentelemetry/api's context.active() and trace.setSpan().
 * Keeping this structural avoids making OpenTelemetry a core dependency.
 */
export interface OpenTelemetryContextBridgeLike {
  active(): unknown;
  setSpan(context: unknown, span: OpenTelemetrySpanLike): unknown;
}

const OK = 1;
const ERROR = 2;

export class OpenTelemetryAdapter implements TrajectoryExporter {
  private readonly trajectorySpans = new Map<string, OpenTelemetrySpanLike>();
  private readonly trackSpans = new Map<string, OpenTelemetrySpanLike>();
  private readonly trackContexts = new Map<string, OpenTelemetrySpanContextLike>();
  private readonly pendingLinks = new Map<string, OpenTelemetrySpanLinkLike[]>();
  private readonly trajectoryTracks = new Map<string, Set<string>>();
  private readonly correlationIds = new Map<string, string>();

  constructor(
    private readonly tracer: OpenTelemetryTracerLike,
    private readonly contextBridge?: OpenTelemetryContextBridgeLike
  ) {}

  onTrajectoryStarted(trajectory: TrajectorySnapshot): void {
    const attributes = {
      "open_trajectory.trajectory_id": trajectory.id,
      "open_trajectory.name": trajectory.name,
      "open_trajectory.started_at": trajectory.startedAt,
      ...(trajectory.correlationId ? { "open_trajectory.correlation_id": trajectory.correlationId } : {}),
      ...clean(trajectory.attributes)
    };
    const span = this.tracer.startSpan(
      trajectory.name,
      { attributes, startTime: new Date(trajectory.startedAt) },
      this.contextBridge?.active()
    );
    this.trajectorySpans.set(trajectory.id, span);
    this.trajectoryTracks.set(trajectory.id, new Set());
    if (trajectory.correlationId) this.correlationIds.set(trajectory.id, trajectory.correlationId);
  }

  onTrackStarted(track: TrackSnapshot): void {
    const parent = track.parentId
      ? this.trackSpans.get(track.parentId)
      : this.trajectorySpans.get(track.trajectoryId);
    const parentContext = parent && this.contextBridge
      ? this.contextBridge.setSpan(this.contextBridge.active(), parent)
      : this.contextBridge?.active();
    const links = this.pendingLinks.get(track.id) ?? [];
    const span = this.tracer.startSpan(
      track.name,
      {
        attributes: {
          "open_trajectory.trajectory_id": track.trajectoryId,
          "open_trajectory.track_id": track.id,
          "open_trajectory.parent_track_id": track.parentId ?? "",
          "open_trajectory.depth": track.depth,
          "open_trajectory.sequence": track.sequence,
          "open_trajectory.started_at": track.startedAt,
          ...(this.correlationIds.get(track.trajectoryId)
            ? { "open_trajectory.correlation_id": this.correlationIds.get(track.trajectoryId)! }
            : {}),
          ...clean(track.attributes)
        },
        links,
        startTime: new Date(track.startedAt)
      },
      parentContext
    );
    this.trackSpans.set(track.id, span);
    const spanContext = span.spanContext?.();
    if (spanContext) this.trackContexts.set(track.id, spanContext);
    this.trajectoryTracks.get(track.trajectoryId)?.add(track.id);
    this.pendingLinks.delete(track.id);
  }

  onExpansion(track: TrackSnapshot, expansion: Expansion): void {
    const span = this.trackSpans.get(track.id);
    if (!span) return;
    const attributes = {
      "open_trajectory.expansion_id": expansion.id,
      "open_trajectory.offset_ms": expansion.offsetMs,
      ...clean(expansion.attributes)
    };
    if (span.addEvent) {
      span.addEvent(expansion.label, attributes, new Date(expansion.timestamp));
    } else {
      span.setAttribute("open_trajectory.expansion." + expansion.id + ".label", expansion.label);
      span.setAttribute("open_trajectory.expansion." + expansion.id + ".offset_ms", expansion.offsetMs);
    }
  }

  onRelation(_trajectory: TrajectorySnapshot, relation: Relation): void {
    const sourceContext = this.trackContexts.get(relation.fromTrackId);
    const linkAttributes = {
      "open_trajectory.relation.kind": relation.kind,
      ...clean(relation.attributes ?? {})
    };
    const targetSpan = this.trackSpans.get(relation.toTrackId);
    if (sourceContext && targetSpan?.addLink) {
      targetSpan.addLink(sourceContext, linkAttributes);
      return;
    }
    if (sourceContext) {
      const links = this.pendingLinks.get(relation.toTrackId) ?? [];
      links.push({ context: sourceContext, attributes: linkAttributes });
      this.pendingLinks.set(relation.toTrackId, links);
      return;
    }
    if (targetSpan) {
      targetSpan.setAttribute("open_trajectory.relation." + relation.kind + ".source_track_id", relation.fromTrackId);
    }
  }

  onTrackEnded(track: TrackSnapshot): void {
    const span = this.trackSpans.get(track.id);
    if (!span) return;
    const endTime = track.endedAt ? new Date(track.endedAt) : undefined;
    try {
      span.setAttribute("open_trajectory.duration_ms", track.durationMs ?? 0);
      if (track.status === "error") {
        const message = track.error?.message ?? "Track failed";
        const exception = new Error(message);
        exception.name = track.error?.name ?? "Error";
        span.setAttribute("exception.type", exception.name);
        span.setAttribute("exception.message", exception.message);
        span.setStatus?.({ code: ERROR, message });
        span.recordException?.(exception);
      } else {
        span.setStatus?.({ code: OK });
      }
    } finally {
      try {
        span.end(endTime);
      } finally {
        this.trackSpans.delete(track.id);
        const context = span.spanContext?.();
        if (context) this.trackContexts.set(track.id, context);
      }
    }
  }

  onTrajectoryEnded(trajectory: TrajectorySnapshot): void {
    const span = this.trajectorySpans.get(trajectory.id);
    if (!span) return;
    const endTime = trajectory.endedAt ? new Date(trajectory.endedAt) : undefined;
    try {
      span.setAttribute("open_trajectory.duration_ms", trajectory.durationMs ?? 0);
      span.setAttribute("open_trajectory.status", trajectory.status);
      span.setAttribute("open_trajectory.track_count", trajectory.tracks.length);
      span.setAttribute("open_trajectory.relation_count", trajectory.relations.length);
      span.setStatus?.(
        trajectory.status === "error" ? { code: ERROR } : { code: OK }
      );
    } finally {
      try {
        span.end(endTime);
      } finally {
        this.trajectorySpans.delete(trajectory.id);
        this.correlationIds.delete(trajectory.id);
        for (const trackId of this.trajectoryTracks.get(trajectory.id) ?? []) {
          this.trackSpans.delete(trackId);
          this.trackContexts.delete(trackId);
          this.pendingLinks.delete(trackId);
        }
        this.trajectoryTracks.delete(trajectory.id);
      }
    }
  }
}

function clean(attributes: Attributes): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean"
    )
  );
}
