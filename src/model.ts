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
export interface TrajectorySnapshot {
  id: string; name: string; correlationId?: string; startedAt: string; endedAt?: string; durationMs?: number;
  status: "running" | "ok" | "error"; attributes: Attributes; tracks: TrackSnapshot[]; relations: Relation[];
}
export interface TrackOptions { name?: string; attributes?: Attributes; causes?: string[]; }
export interface TrajectoryOptions { name?: string; correlationId?: string; attributes?: Attributes; autoReport?: boolean; }