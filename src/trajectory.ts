import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Attributes,
  Expansion,
  Relation,
  RelationKind,
  TrackOptions,
  TrackSnapshot,
  TrajectoryOptions,
  TrajectorySnapshot
} from "./model.js";
import type { TrajectoryExporter } from "./exporter.js";
import {
  assertAttributeSize,
  assertExpansionCount,
  assertTrackDepth,
  validateTrajectoryLimits,
  type TrajectoryLimits
} from "./limits.js";
import { topologicalTracks as projectTopologicalTracks, validateRelation } from "./causal.js";

const contexts = new AsyncLocalStorage<TrajectoryContext>();
let nextId = 0;

export interface TrajectoryClock {
  /** Monotonic milliseconds since the Node.js process performance time origin. */
  monotonicNow(): number;
  /** Wall-clock timestamp in ISO-8601 format. */
  wallTime(): string;
}

const systemClock: TrajectoryClock = {
  monotonicNow: () => performance.now(),
  wallTime: () => new Date().toISOString()
};

function id(prefix: string): string {
  nextId += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + nextId;
}

function elapsed(clock: TrajectoryClock, start: number): number {
  return Math.round(clock.monotonicNow() - start);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null && "then" in value;
}

function errorOf(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function notifyExporters(
  exporters: readonly TrajectoryExporter[],
  event: string,
  notify: (exporter: TrajectoryExporter) => void
): void {
  const errors: unknown[] = [];
  for (const exporter of exporters) {
    try {
      notify(exporter);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `One or more exporters failed during ${event}.`);
  }
}

function finishAndRethrow(
  primary: unknown,
  finalize: () => void,
  message: string
): never {
  try {
    finalize();
  } catch (finalizeError) {
    throw new AggregateError([primary, finalizeError], message);
  }
  throw primary;
}

class ActiveTrack {
  readonly id = id("track");
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly expansions: Expansion[] = [];
  status: "running" | "ok" | "error" = "running";
  endedAt?: string;
  durationMs?: number;
  error?: { name: string; message: string };

  constructor(
    readonly trajectory: TrajectoryContext,
    readonly name: string,
    readonly parentId: string | undefined,
    readonly depth: number,
    readonly sequence: number,
    readonly attributes: Attributes,
    clock: TrajectoryClock
  ) {
    this.startedAt = clock.wallTime();
    this.startedAtMs = clock.monotonicNow();
  }

  snapshot(): TrackSnapshot {
    return {
      id: this.id,
      trajectoryId: this.trajectory.id,
      parentId: this.parentId,
      name: this.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      status: this.status,
      depth: this.depth,
      sequence: this.sequence,
      attributes: { ...this.attributes },
      expansions: this.expansions.map((item) => ({
        ...item,
        attributes: { ...item.attributes }
      })),
      error: this.error ? { ...this.error } : undefined
    };
  }
}

export class TrajectoryContext {
  readonly id = id("trajectory");
  readonly startedAt: string;
  readonly startedAtMs: number;
  private readonly tracks: ActiveTrack[] = [];
  private readonly relations: Relation[] = [];
  status: "running" | "ok" | "error" = "running";
  endedAt?: string;
  durationMs?: number;

  readonly name: string;
  readonly options: TrajectoryOptions;
  private readonly exporters: TrajectoryExporter[];
  private readonly clock: TrajectoryClock;
  private readonly limits: TrajectoryLimits;

  constructor(
    name: string,
    options: TrajectoryOptions = {},
    exporters: TrajectoryExporter[] = [],
    clock: TrajectoryClock = systemClock,
    limits: TrajectoryLimits = {}
  ) {
    this.name = name;
    this.options = Object.freeze({
      ...options,
      attributes: options.attributes
        ? Object.freeze({ ...options.attributes })
        : undefined
    }) as TrajectoryOptions;
    this.exporters = [...exporters];
    this.clock = clock;
    this.limits = { ...limits };
    assertAttributeSize(this.options.attributes ?? {}, this.limits);
    this.startedAt = clock.wallTime();
    this.startedAtMs = clock.monotonicNow();
  }

  static current(): TrajectoryContext | undefined {
    return contexts.getStore();
  }

  static expand(label: string, attributes: Attributes = {}): void {
    const context = contexts.getStore();
    const track = context?.activeTrack();
    if (!context || !track) return;
    assertAttributeSize(attributes, context.limits);
    assertExpansionCount(track.expansions.length, context.limits);

    const expansion: Expansion = {
      id: id("expansion"),
      label,
      timestamp: context.clock.wallTime(),
      offsetMs: elapsed(context.clock, track.startedAtMs),
      attributes: { ...attributes }
    };
    track.expansions.push(expansion);
    notifyExporters(context.exporters, "onExpansion", (exporter) =>
      exporter.onExpansion?.(track.snapshot(), {
        ...expansion,
        attributes: { ...expansion.attributes }
      })
    );
  }

  static relate(
    fromTrackId: string,
    toTrackId: string,
    kind: RelationKind,
    attributes?: Attributes
  ): void {
    contexts.getStore()?.relate(fromTrackId, toTrackId, kind, attributes);
  }

  snapshot(): TrajectorySnapshot {
    const processUptimeMs = Math.round(this.startedAtMs);
    return {
      id: this.id,
      name: this.name,
      correlationId: this.options.correlationId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      processUptimeMs,
      processStartupMs: processUptimeMs,
      status: this.status,
      attributes: { ...(this.options.attributes ?? {}) },
      tracks: this.tracks.map((track) => track.snapshot()),
      relations: this.relations.map((relation) => ({
        ...relation,
        attributes: relation.attributes ? { ...relation.attributes } : undefined
      }))
    };
  }

  runMaybe<T>(callback: () => T | Promise<T>): T | Promise<T> {
    const finish = (status: "ok" | "error") => {
      this.status = status;
      this.endedAt = this.clock.wallTime();
      this.durationMs = elapsed(this.clock, this.startedAtMs);
      notifyExporters(this.exporters, "onTrajectoryEnded", (exporter) =>
        exporter.onTrajectoryEnded?.(this.snapshot())
      );
    };

    try {
      notifyExporters(this.exporters, "onTrajectoryStarted", (exporter) =>
        exporter.onTrajectoryStarted?.(this.snapshot())
      );
    } catch (error) {
      return finishAndRethrow(
        error,
        () => finish("error"),
        "Trajectory start and finalization both failed."
      );
    }

    let result: T | Promise<T>;
    try {
      result = contexts.run(this, callback);
    } catch (error) {
      return finishAndRethrow(
        error,
        () => finish("error"),
        "Trajectory callback and finalization both failed."
      );
    }

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (value) => {
          finish("ok");
          return value;
        },
        (error) => finishAndRethrow(
          error,
          () => finish("error"),
          "Trajectory callback and finalization both failed."
        )
      );
    }

    finish("ok");
    return result;
  }

  async run<T>(callback: () => T | Promise<T>): Promise<T> {
    return await this.runMaybe(callback);
  }

  trackMaybe<T>(
    options: TrackOptions | string,
    callback: () => T | Promise<T>
  ): T | Promise<T> {
    const normalized: TrackOptions = typeof options === "string"
      ? { name: options }
      : options;
    assertAttributeSize(normalized.attributes ?? {}, this.limits);

    const parent = this.activeTrack();
    const depth = parent ? parent.depth + 1 : 0;
    assertTrackDepth(depth, this.limits);

    const track = new ActiveTrack(
      this,
      normalized.name ?? "unnamed.track",
      parent?.id,
      depth,
      this.tracks.length + 1,
      { ...(normalized.attributes ?? {}) },
      this.clock
    );
    const causes = [...new Set(normalized.causes ?? [])];
    const candidateTracks = [
      ...this.tracks.map((item) => ({ id: item.id })),
      { id: track.id }
    ];
    for (const cause of causes) {
      validateRelation(candidateTracks, this.relations, {
        fromTrackId: cause,
        toTrackId: track.id,
        kind: "causes"
      });
    }

    this.tracks.push(track);
    const finish = (status: "ok" | "error", error?: unknown) => {
      track.status = status;
      if (error !== undefined) track.error = errorOf(error);
      track.endedAt = this.clock.wallTime();
      track.durationMs = elapsed(this.clock, track.startedAtMs);
      notifyExporters(this.exporters, "onTrackEnded", (exporter) =>
        exporter.onTrackEnded?.(track.snapshot())
      );
    };

    try {
      for (const cause of causes) this.relate(cause, track.id, "causes");
      notifyExporters(this.exporters, "onTrackStarted", (exporter) =>
        exporter.onTrackStarted?.(track.snapshot())
      );
    } catch (error) {
      return finishAndRethrow(
        error,
        () => finish("error", error),
        "Track startup and finalization both failed."
      );
    }

    let result: T | Promise<T>;
    try {
      result = contexts.run(this.withActive(track), callback);
    } catch (error) {
      return finishAndRethrow(
        error,
        () => finish("error", error),
        "Track callback and finalization both failed."
      );
    }

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (value) => {
          finish("ok");
          return value;
        },
        (error) => finishAndRethrow(
          error,
          () => finish("error", error),
          "Track callback and finalization both failed."
        )
      );
    }

    finish("ok");
    return result;
  }

  async track<T>(
    options: TrackOptions | string,
    callback: () => T | Promise<T>
  ): Promise<T> {
    return await this.trackMaybe(options, callback);
  }

  relate(
    fromTrackId: string,
    toTrackId: string,
    kind: RelationKind,
    attributes?: Attributes
  ): void {
    assertAttributeSize(attributes ?? {}, this.limits);
    const relation: Relation = {
      fromTrackId,
      toTrackId,
      kind,
      attributes: attributes ? { ...attributes } : undefined
    };
    if (validateRelation(this.tracks, this.relations, relation)) {
      this.relations.push(relation);
      notifyExporters(this.exporters, "onRelation", (exporter) =>
        exporter.onRelation?.(this.snapshot(), {
          ...relation,
          attributes: relation.attributes ? { ...relation.attributes } : undefined
        })
      );
    }
  }

  topologicalTracks(): TrackSnapshot[] {
    return projectTopologicalTracks(this.snapshot());
  }

  private activeTrack(): ActiveTrack | undefined {
    return (this as TrajectoryContext & { _active?: ActiveTrack })._active;
  }

  private withActive(track: ActiveTrack): TrajectoryContext {
    const child = Object.create(this) as TrajectoryContext & { _active?: ActiveTrack };
    child._active = track;
    return child;
  }
}

export interface RuntimeOptions {
  exporters?: TrajectoryExporter[];
  clock?: TrajectoryClock;
  limits?: TrajectoryLimits;
}

export class TrajectoryRuntime {
  private readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions = {}) {
    validateTrajectoryLimits(options.limits);
    this.options = {
      ...options,
      exporters: options.exporters ? [...options.exporters] : undefined,
      limits: options.limits ? { ...options.limits } : undefined
    };
  }

  trajectoryMaybe<T>(
    options: TrajectoryOptions | string,
    callback: () => T | Promise<T>
  ): T | Promise<T> {
    const normalized = typeof options === "string" ? { name: options } : options;
    return new TrajectoryContext(
      normalized.name ?? "unnamed.trajectory",
      normalized,
      this.options.exporters ?? [],
      this.options.clock ?? systemClock,
      this.options.limits ?? {}
    ).runMaybe(callback);
  }

  trajectory<T>(
    options: TrajectoryOptions | string,
    callback: () => T | Promise<T>
  ): Promise<T> {
    return Promise.resolve(this.trajectoryMaybe(options, callback));
  }

  current(): TrajectoryContext | undefined {
    return TrajectoryContext.current();
  }
}

export const trajectoryRuntime = new TrajectoryRuntime();
