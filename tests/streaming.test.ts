import test from "node:test";
import assert from "node:assert/strict";
import { Expand } from "../src/decorators.js";
import { TrajectoryRuntime } from "../src/trajectory.js";
import {
  TrajectoryStreamExporter,
  TrajectoryStreamHub,
  TrajectoryStreamStore,
  projectTrajectorySnapshot
} from "../src/streaming.js";
import { TrajectoryWebSocketServer } from "../src/websocket.js";
import type {
  WebSocketConnectionLike,
  WebSocketServerFactory,
  WebSocketServerLike
} from "../src/websocket.js";

test("new stream clients receive a snapshot followed by incremental events", async () => {
  const hub = new TrajectoryStreamHub({ sessionId: "session-stream", maxBufferEvents: 64 });
  const runtime = new TrajectoryRuntime({
    exporters: [new TrajectoryStreamExporter(hub)]
  });
  const connection = hub.connect();
  const store = new TrajectoryStreamStore();
  store.apply(connection.initial);
  assert.equal(connection.initial.kind, "snapshot");
  assert.equal(store.getSnapshots().length, 0);

  await runtime.trajectory("streamed", async () => {
    const context = runtime.current()!;
    await context.track("parent", async () => {
      await runtime.current()!.track("child", () => {
        Expand("child.ready", { step: 1 });
      });
    });
    const ids = context.snapshot().tracks.map((track) => track.id);
    context.relate(ids[0]!, ids[1]!, "causes");
  });

  const frames = [];
  for (let index = 0; index < 8; index += 1) {
    const frame = await connection.subscription.next();
    assert.ok(frame);
    frames.push(frame);
    store.apply(frame!);
  }
  const eventTypes = frames
    .filter((frame) => frame.kind === "event")
    .map((frame) => frame.kind === "event" ? frame.event.type : "");
  assert.deepEqual(eventTypes, [
    "trajectory.started",
    "track.started",
    "track.started",
    "expansion.recorded",
    "track.ended",
    "track.ended",
    "relation.recorded",
    "trajectory.ended"
  ]);

  const snapshot = store.getSnapshots()[0]!;
  const projection = projectTrajectorySnapshot(snapshot);
  assert.equal(projection.roots.length, 1);
  assert.equal(projection.roots[0]!.track.name, "parent");
  assert.equal(projection.roots[0]!.children[0]!.track.name, "child");
  assert.deepEqual(
    projection.tracksInCausalOrder.map((track) => track.name),
    ["parent", "child"]
  );
  assert.equal(snapshot.relations.length, 1);
  const destination = {
    id: "destination-dashboard",
    label: "Dashboard",
    status: "satisfied" as const,
    attributes: { intentId: "intent-login" }
  };
  store.apply({
    kind: "event",
    event: {
      protocol: "open-trajectory",
      version: 1,
      sessionId: hub.sessionId,
      sequence: 9,
      timestamp: new Date().toISOString(),
      trajectoryId: snapshot.id,
      type: "trajectory.ended",
      payload: { ...snapshot, destination }
    }
  });
  assert.deepEqual(store.getSnapshot(snapshot.id)?.destination, destination);
  assert.equal(store.sessionId, hub.sessionId);
  assert.equal(store.lastSequence, 9);
  assert.throws(
    () => store.apply({
      kind: "event",
      event: {
        protocol: "open-trajectory",
        version: 1,
        sessionId: hub.sessionId,
        sequence: 11,
        timestamp: new Date().toISOString(),
        trajectoryId: snapshot.id,
        type: "trajectory.ended",
        payload: snapshot
      }
    }),
    /sequence gap/
  );
  connection.subscription.close();
});

test("reconnect replays retained events and falls back to a final snapshot when stale", async () => {
  const hub = new TrajectoryStreamHub({
    sessionId: "session-replay",
    maxBufferEvents: 2
  });
  const runtime = new TrajectoryRuntime({
    exporters: [new TrajectoryStreamExporter(hub)]
  });
  await runtime.trajectory("completed", async () => {
    await runtime.current()!.track("work", () => {});
  });

  const latestSequence = hub.snapshotFrame().sequence;
  const replay = hub.connect(latestSequence - 2, hub.sessionId);
  assert.equal(replay.initial.kind, "replay");
  if (replay.initial.kind === "replay") {
    assert.equal(replay.initial.events.length, 2);
  }
  replay.subscription.close();

  const changedSession = hub.connect(latestSequence - 2, "previous-process-session");
  assert.equal(changedSession.initial.kind, "snapshot");
  if (changedSession.initial.kind === "snapshot") {
    assert.equal(changedSession.initial.reason, "session-changed");
  }
  changedSession.subscription.close();

  const stale = hub.connect(0, hub.sessionId);
  assert.equal(stale.initial.kind, "snapshot");
  if (stale.initial.kind === "snapshot") {
    assert.equal(stale.initial.reason, "replay-window-expired");
    assert.equal(stale.initial.trajectories[0]!.status, "ok");
  }
  stale.subscription.close();

  const current = hub.connect();
  assert.equal(current.initial.kind, "snapshot");
  if (current.initial.kind === "snapshot") {
    assert.equal(current.initial.trajectories[0]!.tracks[0]!.status, "ok");
  }
  current.subscription.close();
});

test("slow subscribers are resynchronized from a bounded snapshot instead of blocking execution", async () => {
  const hub = new TrajectoryStreamHub({
    sessionId: "session-backpressure",
    maxBufferEvents: 32,
    maxQueuedEvents: 1
  });
  const runtime = new TrajectoryRuntime({
    exporters: [new TrajectoryStreamExporter(hub)]
  });
  const connection = hub.connect();

  await runtime.trajectory("backpressure", async () => {
    await runtime.current()!.track("one", () => {});
    await runtime.current()!.track("two", () => {});
  });

  const resync = await connection.subscription.next();
  assert.equal(resync?.kind, "snapshot");
  if (resync?.kind === "snapshot") {
    assert.equal(resync.reason, "backpressure");
    assert.equal(resync.trajectories[0]!.status, "ok");
    assert.equal(resync.trajectories[0]!.tracks.length, 2);
  }
  connection.subscription.close();
});

test("concurrent trajectories share one monotonic session sequence without mixing state", async () => {
  const hub = new TrajectoryStreamHub({ sessionId: "session-concurrent", maxBufferEvents: 128 });
  const runtime = new TrajectoryRuntime({
    exporters: [new TrajectoryStreamExporter(hub)]
  });
  await Promise.all(["alpha", "beta"].map((name) =>
    runtime.trajectory(name, async () => {
      await runtime.current()!.track("work", async () => {
        await Promise.resolve();
        Expand(name + ".done");
      });
    })
  ));

  const connection = hub.connect(0, hub.sessionId);
  assert.equal(connection.initial.kind, "replay");
  if (connection.initial.kind === "replay") {
    const events = connection.initial.events;
    const sequences = events.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length);
    assert.deepEqual(
      new Set(events.map((event) => event.trajectoryId)),
      new Set(hub.snapshotFrame().trajectories.map((snapshot) => snapshot.id))
    );
  }
  connection.subscription.close();
});

class FakeSocket implements WebSocketConnectionLike {
  readonly sent: unknown[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();

  on(event: "message" | "close" | "error", listener: (value?: unknown) => void): unknown {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.emit("close");
  }

  receive(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class FakeWebSocketServer implements WebSocketServerLike {
  private connection?: (socket: WebSocketConnectionLike, request: unknown) => void;
  on(
    _event: "connection",
    listener: (socket: WebSocketConnectionLike, request: unknown) => void
  ): unknown {
    this.connection = listener;
    return this;
  }
  accept(socket: WebSocketConnectionLike, request: unknown = {}): void {
    this.connection?.(socket, request);
  }
  close(callback?: (error?: Error) => void): void {
    callback?.();
  }
}

test("WebSocket transport defaults to loopback:7331 and streams the shared protocol", async () => {
  const hub = new TrajectoryStreamHub({ sessionId: "session-ws" });
  const server = new FakeWebSocketServer();
  let createdOptions: { host: string; port: number; maxPayload: number } | undefined;
  const factory: WebSocketServerFactory = {
    create(options) {
      createdOptions = options;
      return server;
    }
  };
  const transport = new TrajectoryWebSocketServer(hub, factory).start();
  assert.deepEqual(createdOptions, {
    host: "127.0.0.1",
    port: 7331,
    maxPayload: 16 * 1024
  });

  const socket = new FakeSocket();
  server.accept(socket);
  socket.receive({ type: "subscribe" });
  assert.equal((socket.sent[0] as { kind: string }).kind, "snapshot");

  const runtime = new TrajectoryRuntime({
    exporters: [new TrajectoryStreamExporter(hub)]
  });
  await runtime.trajectory("websocket", () => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(socket.sent.some((frame) =>
    (frame as { kind?: string; event?: { type?: string } }).kind === "event" &&
    (frame as { event?: { type?: string } }).event?.type === "trajectory.started"
  ));

  await transport.close();
  assert.equal(socket.closed[0]?.code, 1001);
});

test("non-loopback WebSocket binding requires an authorization callback", () => {
  const hub = new TrajectoryStreamHub();
  const factory: WebSocketServerFactory = {
    create: () => new FakeWebSocketServer()
  };
  assert.throws(
    () => new TrajectoryWebSocketServer(hub, factory, { host: "0.0.0.0" }),
    /authorize callback/
  );

  const server = new FakeWebSocketServer();
  const transport = new TrajectoryWebSocketServer(hub, {
    create: () => server
  }, {
    host: "0.0.0.0",
    authorize: (request) => (request as { allowed?: boolean }).allowed === true
  }).start();
  const socket = new FakeSocket();
  server.accept(socket, { allowed: false });
  assert.equal(socket.closed[0]?.code, 1008);
  void transport.close();
});
