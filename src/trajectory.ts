import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes, Expansion, Relation, RelationKind, TrackOptions, TrackSnapshot, TrajectoryOptions, TrajectorySnapshot } from "./model.js";
import type { TrajectoryExporter } from "./exporter.js";
const contexts = new AsyncLocalStorage<TrajectoryContext>();
let nextId = 0;
function id(prefix: string): string { nextId += 1; return prefix + "-" + Date.now().toString(36) + "-" + nextId; }
function now(): string { return new Date().toISOString(); }
function elapsed(start: number): number { return Math.round(performance.now() - start); }
function errorOf(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
class ActiveTrack {
  readonly id = id("track"); readonly startedAt = now(); readonly startedAtMs = performance.now(); readonly expansions: Expansion[] = [];
  status: "running" | "ok" | "error" = "running"; endedAt?: string; durationMs?: number; error?: { name: string; message: string };
  constructor(readonly trajectory: TrajectoryContext, readonly name: string, readonly parentId: string | undefined, readonly depth: number, readonly sequence: number, readonly attributes: Attributes) {}
  snapshot(): TrackSnapshot { return { id: this.id, trajectoryId: this.trajectory.id, parentId: this.parentId, name: this.name, startedAt: this.startedAt, endedAt: this.endedAt, durationMs: this.durationMs, status: this.status, depth: this.depth, sequence: this.sequence, attributes: this.attributes, expansions: [...this.expansions], error: this.error }; }
}
export class TrajectoryContext {
  readonly id = id("trajectory"); readonly startedAt = now(); readonly startedAtMs = performance.now(); readonly tracks: ActiveTrack[] = []; readonly relations: Relation[] = [];
  status: "running" | "ok" | "error" = "running"; endedAt?: string; durationMs?: number;
  constructor(readonly name: string, readonly options: TrajectoryOptions = {}, private readonly exporters: TrajectoryExporter[] = []) {}
  static current(): TrajectoryContext | undefined { return contexts.getStore(); }
  static expand(label: string, attributes: Attributes = {}): void {
    const context = contexts.getStore(); const track = context?.activeTrack(); if (!context || !track) return;
    const expansion: Expansion = { id: id("expansion"), label, timestamp: now(), offsetMs: elapsed(track.startedAtMs), attributes };
    track.expansions.push(expansion); context.exporters.forEach((exporter) => exporter.onExpansion?.(track.snapshot(), expansion));
  }
  static relate(fromTrackId: string, toTrackId: string, kind: RelationKind, attributes?: Attributes): void { contexts.getStore()?.relate(fromTrackId, toTrackId, kind, attributes); }
  snapshot(): TrajectorySnapshot { return { id: this.id, name: this.name, correlationId: this.options.correlationId, startedAt: this.startedAt, endedAt: this.endedAt, durationMs: this.durationMs, status: this.status, attributes: this.options.attributes ?? {}, tracks: this.tracks.map((track) => track.snapshot()), relations: [...this.relations] }; }
  async run<T>(callback: () => T | Promise<T>): Promise<T> {
    this.exporters.forEach((exporter) => exporter.onTrajectoryStarted?.(this.snapshot()));
    try { const result = await contexts.run(this, callback); this.status = "ok"; return result; }
    catch (error) { this.status = "error"; throw error; }
    finally { this.endedAt = now(); this.durationMs = elapsed(this.startedAtMs); this.exporters.forEach((exporter) => exporter.onTrajectoryEnded?.(this.snapshot())); }
  }
  async track<T>(options: TrackOptions | string, callback: () => T | Promise<T>): Promise<T> {
    const normalized: TrackOptions = typeof options === "string" ? { name: options } : options; const parent = this.activeTrack();
    const track = new ActiveTrack(this, normalized.name ?? "unnamed.track", parent?.id, parent ? parent.depth + 1 : 0, this.tracks.length + 1, normalized.attributes ?? {});
    this.tracks.push(track); for (const cause of normalized.causes ?? []) this.relate(cause, track.id, "causes");
    this.exporters.forEach((exporter) => exporter.onTrackStarted?.(track.snapshot()));
    try { const result = await contexts.run(this.withActive(track), callback); track.status = "ok"; return result; }
    catch (error) { track.status = "error"; track.error = errorOf(error); throw error; }
    finally { track.endedAt = now(); track.durationMs = elapsed(track.startedAtMs); this.exporters.forEach((exporter) => exporter.onTrackEnded?.(track.snapshot())); }
  }
  relate(fromTrackId: string, toTrackId: string, kind: RelationKind, attributes?: Attributes): void { this.relations.push({ fromTrackId, toTrackId, kind, attributes }); }
  private activeTrack(): ActiveTrack | undefined { return (this as TrajectoryContext & { _active?: ActiveTrack })._active; }
  private withActive(track: ActiveTrack): TrajectoryContext { const child = Object.create(this) as TrajectoryContext & { _active?: ActiveTrack }; child._active = track; return child; }
}
export interface RuntimeOptions { exporters?: TrajectoryExporter[]; autoReport?: boolean; }
export class TrajectoryRuntime {
  constructor(private readonly options: RuntimeOptions = {}) {}
  trajectory<T>(options: TrajectoryOptions | string, callback: () => T | Promise<T>): Promise<T> {
    const normalized = typeof options === "string" ? { name: options } : options;
    return new TrajectoryContext(normalized.name ?? "unnamed.trajectory", normalized, this.options.exporters ?? []).run(callback);
  }
  current(): TrajectoryContext | undefined { return TrajectoryContext.current(); }
}
export const trajectoryRuntime = new TrajectoryRuntime();