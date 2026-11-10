import type { Relation, TrackSnapshot, TrajectorySnapshot } from "./model.js";

export type CausalRelationErrorCode =
  | "UNKNOWN_SOURCE_TRACK"
  | "UNKNOWN_TARGET_TRACK"
  | "SELF_RELATION"
  | "CAUSAL_CYCLE";

export class CausalRelationError extends Error {
  constructor(
    readonly code: CausalRelationErrorCode,
    message: string,
    readonly fromTrackId?: string,
    readonly toTrackId?: string,
    readonly cycle?: string[]
  ) {
    super(message);
    this.name = "CausalRelationError";
  }
}

function findCycle(relations: readonly Relation[]): string[] | undefined {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations) {
    const next = outgoing.get(relation.fromTrackId) ?? [];
    next.push(relation.toTrackId);
    outgoing.set(relation.fromTrackId, next);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (current: string): string[] | undefined => {
    if (active.has(current)) {
      const start = path.indexOf(current);
      return [...path.slice(start), current];
    }
    if (visited.has(current)) return undefined;
    visited.add(current);
    active.add(current);
    path.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(current);
    return undefined;
  };
  for (const relation of relations) {
    const cycle = visit(relation.fromTrackId);
    if (cycle) return cycle;
  }
  return undefined;
}

function findPath(
  relations: readonly Relation[],
  start: string,
  goal: string
): string[] | undefined {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations) {
    const next = outgoing.get(relation.fromTrackId) ?? [];
    next.push(relation.toTrackId);
    outgoing.set(relation.fromTrackId, next);
  }

  const queue: string[][] = [[start]];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === goal) return path;
    for (const next of outgoing.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

/** Validate a directed causal edge. Returns false for an already-recorded edge. */
export function validateRelation(
  tracks: readonly Pick<TrackSnapshot, "id">[],
  relations: readonly Relation[],
  relation: Relation
): boolean {
  const ids = new Set(tracks.map((track) => track.id));
  if (!ids.has(relation.fromTrackId)) {
    throw new CausalRelationError(
      "UNKNOWN_SOURCE_TRACK",
      `Unknown source Track "${relation.fromTrackId}" in Trajectory.`,
      relation.fromTrackId,
      relation.toTrackId
    );
  }
  if (!ids.has(relation.toTrackId)) {
    throw new CausalRelationError(
      "UNKNOWN_TARGET_TRACK",
      `Unknown target Track "${relation.toTrackId}" in Trajectory.`,
      relation.fromTrackId,
      relation.toTrackId
    );
  }
  if (relation.fromTrackId === relation.toTrackId) {
    throw new CausalRelationError(
      "SELF_RELATION",
      `Track "${relation.fromTrackId}" cannot be related to itself.`,
      relation.fromTrackId,
      relation.toTrackId
    );
  }

  if (relations.some((item) =>
    item.fromTrackId === relation.fromTrackId &&
    item.toTrackId === relation.toTrackId &&
    item.kind === relation.kind
  )) return false;

  const path = findPath(relations, relation.toTrackId, relation.fromTrackId);
  if (path) {
    const cycle = [relation.fromTrackId, ...path];
    throw new CausalRelationError(
      "CAUSAL_CYCLE",
      `Relation ${relation.fromTrackId} -> ${relation.toTrackId} creates a causal cycle: ${cycle.join(" -> ")}.`,
      relation.fromTrackId,
      relation.toTrackId,
      cycle
    );
  }
  return true;
}

/**
 * Return a deterministic topological projection. The input snapshot is never
 * reordered or mutated; ties are resolved by original Track sequence, then ID.
 */
export function topologicalTracks(
  snapshot: Pick<TrajectorySnapshot, "tracks" | "relations">
): TrackSnapshot[] {
  const tracks = snapshot.tracks;
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const indegree = new Map(tracks.map((track) => [track.id, 0]));
  const outgoing = new Map<string, Set<string>>();

  for (const relation of snapshot.relations) {
    if (!byId.has(relation.fromTrackId)) {
      throw new CausalRelationError(
        "UNKNOWN_SOURCE_TRACK",
        `Unknown source Track "${relation.fromTrackId}" in snapshot.`,
        relation.fromTrackId,
        relation.toTrackId
      );
    }
    if (!byId.has(relation.toTrackId)) {
      throw new CausalRelationError(
        "UNKNOWN_TARGET_TRACK",
        `Unknown target Track "${relation.toTrackId}" in snapshot.`,
        relation.fromTrackId,
        relation.toTrackId
      );
    }
    if (relation.fromTrackId === relation.toTrackId) {
      throw new CausalRelationError(
        "SELF_RELATION",
        `Track "${relation.fromTrackId}" cannot be related to itself.`,
        relation.fromTrackId,
        relation.toTrackId
      );
    }
    const targets = outgoing.get(relation.fromTrackId) ?? new Set<string>();
    if (!targets.has(relation.toTrackId)) {
      targets.add(relation.toTrackId);
      outgoing.set(relation.fromTrackId, targets);
      indegree.set(relation.toTrackId, indegree.get(relation.toTrackId)! + 1);
    }
  }

  const compare = (left: string, right: string) => {
    const a = byId.get(left)!;
    const b = byId.get(right)!;
    return a.sequence - b.sequence || a.id.localeCompare(b.id);
  };
  const ready = tracks.filter((track) => indegree.get(track.id) === 0).map((track) => track.id).sort(compare);
  const ordered: TrackSnapshot[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(byId.get(current)!);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }

  if (ordered.length !== tracks.length) {
    const cycleNodes = tracks.filter((track) => indegree.get(track.id)! > 0).map((track) => track.id);
    const cycle = findCycle(snapshot.relations) ?? cycleNodes;
    throw new CausalRelationError(
      "CAUSAL_CYCLE",
      `Cannot produce a topological projection; causal cycle detected among Tracks: ${cycleNodes.join(", ")}.`,
      cycleNodes[0],
      cycleNodes[cycleNodes.length - 1],
      cycle
    );
  }
  return ordered;
}
