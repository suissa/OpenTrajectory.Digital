export type AttributeValue = string | number | boolean | null;
export type Attributes = Record<string, AttributeValue>;
export type RelationKind = "causes" | "depends_on" | "expands" | "follows" | "derives_from";
export interface Relation { fromTrackId: string; toTrackId: string; kind: RelationKind; attributes?: Attributes; }
export interface Expansion { id: string; label: string; timestamp: string; offsetMs: number; attributes: Attributes; }
export interface TrackSnapshot {
  id: string; trajectoryId: string; parentId?: string; name: string; startedAt: string; endedAt?: string;
  durationMs?: number; status: "running" | "ok" | "error"; depth: number; sequence: number;
  attributes: Attributes; expansions: Expansion[]; error?: { name: string; message: string };
}
export interface Destination {
  id: string;
  label: string;
  status: "expected" | "satisfied" | "failed";
  attributes: Attributes;
}
export interface TrajectorySnapshot {
  id: string; name: string; correlationId?: string; startedAt: string; endedAt?: string; durationMs?: number;
  /** Monotonic milliseconds elapsed since this Node.js process started, sampled at Trajectory creation. */
  processUptimeMs: number;
  /** @deprecated Use processUptimeMs. Kept as a compatibility alias in the 0.x API. */
  processStartupMs: number;
  status: "running" | "ok" | "error"; attributes: Attributes; tracks: TrackSnapshot[]; relations: Relation[]; destination?: Destination;
}
export interface TrackOptions { name?: string; attributes?: Attributes; causes?: string[]; }
export interface TrajectoryOptions { name?: string; correlationId?: string; attributes?: Attributes; }
