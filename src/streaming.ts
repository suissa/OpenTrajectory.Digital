import type { TrajectoryExporter } from "./exporter.js";
import type {
  Expansion,
  Relation,
  TrackSnapshot,
  TrajectorySnapshot
} from "./model.js";
import { topologicalTracks } from "./causal.js";

export type TrajectoryStreamEventType =
  | "trajectory.started"
  | "trajectory.failed"
  | "trajectory.ended"
  | "track.started"
  | "track.failed"
  | "track.ended"
  | "expansion.recorded"
  | "relation.recorded";

export interface TrajectoryStreamEvent {
  protocol: "open-trajectory";
  version: 1;
  sessionId: string;
  sequence: number;
  timestamp: string;
  trajectoryId: string;
  type: TrajectoryStreamEventType;
  payload: TrajectorySnapshot | TrackSnapshot | Relation | {
    track: TrackSnapshot;
    expansion: Expansion;
  };
}

export interface TrajectoryStreamSnapshotFrame {
  kind: "snapshot";
  protocol: "open-trajectory";
  version: 1;
  sessionId: string;
  sequence: number;
  reason: "initial" | "replay-window-expired" | "cursor-ahead" | "session-changed" | "backpressure";
  trajectories: TrajectorySnapshot[];
}

export interface TrajectoryStreamReplayFrame {
  kind: "replay";
  protocol: "open-trajectory";
  version: 1;
  sessionId: string;
  fromSequence: number;
  toSequence: number;
  events: TrajectoryStreamEvent[];
}

export interface TrajectoryStreamEventFrame {
  kind: "event";
  event: TrajectoryStreamEvent;
}

export type TrajectoryStreamFrame =
  | TrajectoryStreamSnapshotFrame
  | TrajectoryStreamReplayFrame
  | TrajectoryStreamEventFrame;

export interface TrajectoryStreamHubOptions {
  sessionId?: string;
  maxBufferEvents?: number;
  maxQueuedEvents?: number;
  maxSnapshots?: number;
}

export interface TrajectoryStreamConnection {
  initial: TrajectoryStreamSnapshotFrame | TrajectoryStreamReplayFrame;
  subscription: TrajectoryStreamSubscription;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function compareTracks(left: TrackSnapshot, right: TrackSnapshot): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

export class TrajectoryStreamHub {
  readonly sessionId: string;
  private sequence = 0;
  private readonly events: TrajectoryStreamEvent[] = [];
  private readonly snapshots = new Map<string, TrajectorySnapshot>();
  private readonly subscriptions = new Set<TrajectoryStreamSubscription>();
  private readonly maxBufferEvents: number;
  private readonly maxQueuedEvents: number;
  private readonly maxSnapshots: number;
  private closed = false;

  constructor(options: TrajectoryStreamHubOptions = {}) {
    this.sessionId = options.sessionId ?? createSessionId();
    this.maxBufferEvents = options.maxBufferEvents ?? 2_048;
    this.maxQueuedEvents = options.maxQueuedEvents ?? 256;
    this.maxSnapshots = options.maxSnapshots ?? 512;
    for (const [name, value] of Object.entries({
      maxBufferEvents: this.maxBufferEvents,
      maxQueuedEvents: this.maxQueuedEvents,
      maxSnapshots: this.maxSnapshots
    })) {
      if (!Number.isInteger(value) || value < (name === "maxBufferEvents" ? 0 : 1)) {
        throw new RangeError(`${name} must be an integer greater than ${name === "maxBufferEvents" ? "or equal to " : ""}0.`);
      }
    }
  }

  connect(afterSequence?: number, sessionId?: string): TrajectoryStreamConnection {
    if (this.closed) throw new Error("TrajectoryStreamHub is closed.");
    if (afterSequence !== undefined &&
      (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      throw new RangeError("afterSequence must be a non-negative safe integer.");
    }

    const subscription = new TrajectoryStreamSubscription(
      this,
      this.maxQueuedEvents
    );
    this.subscriptions.add(subscription);

    const oldestSequence = this.events[0]?.sequence ?? this.sequence + 1;
    const sameSession = afterSequence === undefined || sessionId === this.sessionId;
    const replayAvailable = afterSequence !== undefined &&
      sameSession &&
      afterSequence <= this.sequence &&
      afterSequence >= oldestSequence - 1;

    const initial: TrajectoryStreamSnapshotFrame | TrajectoryStreamReplayFrame =
      replayAvailable
        ? {
            kind: "replay",
            protocol: "open-trajectory",
            version: 1,
            sessionId: this.sessionId,
            fromSequence: afterSequence + 1,
            toSequence: this.sequence,
            events: this.events
              .filter((event) => event.sequence > afterSequence)
              .map(clone)
          }
        : this.snapshotFrame(
            afterSequence === undefined
              ? "initial"
              : !sameSession
                ? "session-changed"
                : afterSequence > this.sequence
                  ? "cursor-ahead"
                  : "replay-window-expired"
          );

    return { initial, subscription };
  }

  publish<T extends TrajectoryStreamEvent["payload"]>(
    type: TrajectoryStreamEventType,
    trajectoryId: string,
    payload: T
  ): TrajectoryStreamEvent | undefined {
    if (this.closed) return undefined;
    const event: TrajectoryStreamEvent = {
      protocol: "open-trajectory",
      version: 1,
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      trajectoryId,
      type,
      payload: clone(payload)
    };
    if (this.maxBufferEvents > 0) {
      this.events.push(event);
      if (this.events.length > this.maxBufferEvents) this.events.shift();
    }
    const frame: TrajectoryStreamEventFrame = { kind: "event", event: clone(event) };
    for (const subscription of this.subscriptions) subscription.enqueue(frame);
    return clone(event);
  }

  updateTrajectory(snapshot: TrajectorySnapshot): void {
    if (this.closed) return;
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, clone(snapshot));
    this.trimSnapshots();
  }

  updateTrack(track: TrackSnapshot): void {
    if (this.closed) return;
    const current = this.snapshots.get(track.trajectoryId);
    if (!current) return;
    const tracks = current.tracks.filter((item) => item.id !== track.id);
    tracks.push(clone(track));
    tracks.sort(compareTracks);
    this.updateTrajectory({ ...current, tracks });
  }

  updateRelation(trajectoryId: string, relation: Relation): void {
    if (this.closed) return;
    const current = this.snapshots.get(trajectoryId);
    if (!current) return;
    const relations = current.relations.filter((item) =>
      !(item.fromTrackId === relation.fromTrackId &&
        item.toTrackId === relation.toTrackId &&
        item.kind === relation.kind)
    );
    relations.push(clone(relation));
    this.updateTrajectory({ ...current, relations });
  }

  snapshotFrame(
    reason: TrajectoryStreamSnapshotFrame["reason"] = "initial"
  ): TrajectoryStreamSnapshotFrame {
    return {
      kind: "snapshot",
      protocol: "open-trajectory",
      version: 1,
      sessionId: this.sessionId,
      sequence: this.sequence,
      reason,
      trajectories: [...this.snapshots.values()].map(clone)
    };
  }

  removeSubscription(subscription: TrajectoryStreamSubscription): void {
    this.subscriptions.delete(subscription);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of [...this.subscriptions]) subscription.close();
    this.events.length = 0;
    this.snapshots.clear();
  }

  private trimSnapshots(): void {
    while (this.snapshots.size > this.maxSnapshots) {
      const completedId = [...this.snapshots.entries()]
        .find(([, snapshot]) => snapshot.status !== "running")?.[0];
      if (!completedId) break;
      this.snapshots.delete(completedId);
    }
  }
}

export class TrajectoryStreamSubscription {
  private readonly queue: TrajectoryStreamFrame[] = [];
  private readonly waiters: Array<(frame: TrajectoryStreamFrame | null) => void> = [];
  private resyncRequired = false;
  private closed = false;

  constructor(
    private readonly hub: TrajectoryStreamHub,
    private readonly maxQueuedEvents: number
  ) {}

  next(): Promise<TrajectoryStreamFrame | null> {
    if (this.resyncRequired) {
      this.resyncRequired = false;
      return Promise.resolve(this.hub.snapshotFrame("backpressure"));
    }
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  enqueue(frame: TrajectoryStreamEventFrame): void {
    if (this.closed || this.resyncRequired) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    if (this.queue.length >= this.maxQueuedEvents) {
      this.queue.length = 0;
      this.resyncRequired = true;
      const waiting = this.waiters.shift();
      waiting?.(this.hub.snapshotFrame("backpressure"));
      return;
    }
    this.queue.push(clone(frame));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.hub.removeSubscription(this);
  }
}

export class TrajectoryStreamExporter implements TrajectoryExporter {
  constructor(readonly hub: TrajectoryStreamHub) {}

  onTrajectoryStarted(trajectory: TrajectorySnapshot): void {
    this.hub.updateTrajectory(trajectory);
    this.hub.publish("trajectory.started", trajectory.id, trajectory);
  }

  onTrackStarted(track: TrackSnapshot): void {
    this.hub.updateTrack(track);
    this.hub.publish("track.started", track.trajectoryId, track);
  }

  onExpansion(track: TrackSnapshot, expansion: Expansion): void {
    this.hub.updateTrack(track);
    this.hub.publish("expansion.recorded", track.trajectoryId, {
      track,
      expansion
    });
  }

  onRelation(trajectory: TrajectorySnapshot, relation: Relation): void {
    this.hub.updateTrajectory(trajectory);
    this.hub.publish("relation.recorded", trajectory.id, relation);
  }

  onTrackEnded(track: TrackSnapshot): void {
    this.hub.updateTrack(track);
    if (track.status === "error") {
      this.hub.publish("track.failed", track.trajectoryId, track);
    }
    this.hub.publish("track.ended", track.trajectoryId, track);
  }

  onTrajectoryEnded(trajectory: TrajectorySnapshot): void {
    this.hub.updateTrajectory(trajectory);
    if (trajectory.status === "error") {
      this.hub.publish("trajectory.failed", trajectory.id, trajectory);
    }
    this.hub.publish("trajectory.ended", trajectory.id, trajectory);
  }
}

export interface TrajectoryTrackNode {
  track: TrackSnapshot;
  children: TrajectoryTrackNode[];
}

export interface TrajectoryProjection {
  trajectory: TrajectorySnapshot;
  roots: TrajectoryTrackNode[];
  tracksInSequence: TrackSnapshot[];
  tracksInCausalOrder: TrackSnapshot[];
  relations: Relation[];
}

/** Shared hierarchy and ordering projection for terminal and browser consumers. */
export function projectTrajectorySnapshot(
  snapshot: TrajectorySnapshot
): TrajectoryProjection {
  const tracksInSequence = [...snapshot.tracks].sort(compareTracks);
  const nodes = new Map<string, TrajectoryTrackNode>();
  for (const track of tracksInSequence) {
    nodes.set(track.id, { track: clone(track), children: [] });
  }
  const roots: TrajectoryTrackNode[] = [];

  for (const track of tracksInSequence) {
    const node = nodes.get(track.id)!;
    const parent = track.parentId ? nodes.get(track.parentId) : undefined;
    if (parent && parent.track.id !== track.id) parent.children.push(node);
    else roots.push(node);
  }

  const sortTree = (items: TrajectoryTrackNode[]) => {
    items.sort((left, right) => compareTracks(left.track, right.track));
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);

  return {
    trajectory: clone(snapshot),
    roots,
    tracksInSequence: tracksInSequence.map(clone),
    tracksInCausalOrder: topologicalTracks(snapshot).map(clone),
    relations: snapshot.relations.map(clone)
  };
}

/** Stateful reducer shared by TUI and Web clients. */
export class TrajectoryStreamStore {
  private readonly snapshots = new Map<string, TrajectorySnapshot>();
  private currentSessionId?: string;
  private sequence = 0;

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  apply(frame: TrajectoryStreamFrame): void {
    if (frame.kind === "snapshot") {
      this.snapshots.clear();
      for (const snapshot of frame.trajectories) {
        this.snapshots.set(snapshot.id, clone(snapshot));
      }
      this.currentSessionId = frame.sessionId;
      this.sequence = frame.sequence;
      return;
    }
    if (frame.kind === "replay") {
      this.assertSession(frame.sessionId);
      if (frame.fromSequence !== this.sequence + 1) {
        throw new Error("Stream replay gap: a fresh snapshot is required.");
      }
      for (const event of frame.events) this.applyEventWithSequence(event);
      this.sequence = frame.toSequence;
      return;
    }
    this.applyEventWithSequence(frame.event);
  }

  getSnapshot(trajectoryId: string): TrajectorySnapshot | undefined {
    const snapshot = this.snapshots.get(trajectoryId);
    return snapshot ? clone(snapshot) : undefined;
  }

  getSnapshots(): TrajectorySnapshot[] {
    return [...this.snapshots.values()].map(clone);
  }

  getProjections(): TrajectoryProjection[] {
    return this.getSnapshots()
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(projectTrajectorySnapshot);
  }

  private assertSession(sessionId: string): void {
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      throw new Error("Stream session changed: a fresh snapshot is required.");
    }
    this.currentSessionId ??= sessionId;
  }

  private applyEventWithSequence(event: TrajectoryStreamEvent): void {
    this.assertSession(event.sessionId);
    if (event.sequence <= this.sequence) return;
    if (event.sequence !== this.sequence + 1) {
      throw new Error("Stream sequence gap: a fresh snapshot is required.");
    }
    this.applyEvent(event);
    this.sequence = event.sequence;
  }

  private applyEvent(event: TrajectoryStreamEvent): void {
    switch (event.type) {
      case "trajectory.started":
      case "trajectory.failed":
      case "trajectory.ended":
        this.snapshots.set(event.trajectoryId, clone(event.payload as TrajectorySnapshot));
        return;
      case "track.started":
      case "track.failed":
      case "track.ended":
        this.upsertTrack(event.payload as TrackSnapshot);
        return;
      case "expansion.recorded":
        this.upsertTrack((event.payload as { track: TrackSnapshot }).track);
        return;
      case "relation.recorded":
        this.upsertRelation(event.trajectoryId, event.payload as Relation);
        return;
    }
  }

  private upsertTrack(track: TrackSnapshot): void {
    const current = this.snapshots.get(track.trajectoryId);
    if (!current) return;
    const tracks = current.tracks.filter((item) => item.id !== track.id);
    tracks.push(clone(track));
    tracks.sort(compareTracks);
    this.snapshots.set(track.trajectoryId, { ...current, tracks });
  }

  private upsertRelation(trajectoryId: string, relation: Relation): void {
    const current = this.snapshots.get(trajectoryId);
    if (!current) return;
    const relations = current.relations.filter((item) =>
      !(item.fromTrackId === relation.fromTrackId &&
        item.toTrackId === relation.toTrackId &&
        item.kind === relation.kind)
    );
    relations.push(clone(relation));
    this.snapshots.set(trajectoryId, { ...current, relations });
  }
}

function createSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // Session IDs are cursors, not credentials; this fallback is not an auth token.
  return "session-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
