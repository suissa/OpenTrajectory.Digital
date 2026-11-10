# Realtime stream protocol

The streaming layer is transport-neutral. Attach `TrajectoryStreamExporter` to a runtime, then expose its `TrajectoryStreamHub` through an in-process consumer or a WebSocket server.

## Versioned event envelope

Every incremental event uses this envelope:

```json
{
  "protocol": "open-trajectory",
  "version": 1,
  "sessionId": "process-session-id",
  "sequence": 42,
  "timestamp": "2026-11-10T12:00:00.000Z",
  "trajectoryId": "trajectory-...",
  "type": "track.started",
  "payload": {}
}
```

Sequence numbers are strictly increasing within one hub session. A new process creates a new session ID; clients must discard an old cursor and request a snapshot when the session ID changes.

Event types:

| Event | Payload |
| --- | --- |
| `trajectory.started` | Full TrajectorySnapshot |
| `track.started` | TrackSnapshot |
| `expansion.recorded` | TrackSnapshot plus Expansion |
| `relation.recorded` | Relation |
| `track.failed` | Failed TrackSnapshot |
| `track.ended` | Final TrackSnapshot |
| `trajectory.failed` | Failed TrajectorySnapshot |
| `trajectory.ended` | Final TrajectorySnapshot |

Failure events are emitted before their corresponding ended event. The ended payload remains authoritative for final status and duration.

## Snapshot, replay, and reconnect

A new client calls `hub.connect()`. The returned `initial` frame is a full snapshot. It then reads incremental event frames from `subscription.next()`.

A reconnecting client passes its last applied sequence: `hub.connect(lastSequence)`. If the requested cursor is still in the ring buffer, the initial frame contains only events after that sequence. If the cursor is too old or belongs to a future sequence, the hub sends a fresh snapshot. A process restart changes `sessionId`; always resynchronize on a session change.

The event ring buffer is bounded by `maxBufferEvents` (default 2,048). Each subscriber has a bounded queue `maxQueuedEvents` (default 256). If a subscriber falls behind, its queued events are discarded and its next read returns a current snapshot with reason `backpressure`. This prevents a slow TUI/browser from blocking instrumented execution. Snapshot retention defaults to 512 Trajectories; completed snapshots are evicted first, while active snapshots are retained.

## Shared client state and projection

Both terminal and browser clients should use the same reducer and projection functions. This package deliberately does not prescribe a terminal UI framework or a web component library.

```ts
import {
  TrajectoryStreamHub,
  TrajectoryStreamStore,
  projectTrajectorySnapshot
} from "@opentrajectory/digital";

const hub = new TrajectoryStreamHub();
const connection = hub.connect(); // For a remote client, receive frames from the WebSocket instead.
const store = new TrajectoryStreamStore();
store.apply(connection.initial);
store.apply(connection.initial);
while (true) {
  const frame = await connection.subscription.next();
  if (!frame) break;
  store.apply(frame);
  const projections = store.getProjections();
  // Render the same roots, children, sequence, causal order and relations
  // in the TUI or browser dashboard.
}
```

`projectTrajectorySnapshot` exposes:
- `roots`: the Track hierarchy using `parentId` and stable `sequence` ordering.
- `tracksInSequence`: original temporal order.
- `tracksInCausalOrder`: deterministic topological order from the causal graph.
- `relations`: causal/dependency edges.

`TrajectoryStreamStore` applies snapshots, replay batches and incremental events. Its getters return defensive copies.

## WebSocket transport

The server accepts an injected `WebSocketServerFactory`, so the SDK does not force a WebSocket implementation into the core dependency graph. For example, consumers can adapt the `ws` package:

```ts
import { WebSocketServer } from "ws";
import {
  TrajectoryStreamExporter,
  TrajectoryStreamHub,
  TrajectoryWebSocketServer,
  TrajectoryRuntime,
  type WebSocketServerFactory
} from "@opentrajectory/digital";

const hub = new TrajectoryStreamHub();
const runtime = new TrajectoryRuntime({
  exporters: [new TrajectoryStreamExporter(hub)]
});
const factory: WebSocketServerFactory = {
  create: (options) => new WebSocketServer(options) as never
};
const server = new TrajectoryWebSocketServer(hub, factory, {
  host: "127.0.0.1",
  port: 7331
}).start();
```

A client sends one JSON message after connecting:

```json
{ "type": "subscribe", "afterSequence": 41 }
```

Omit `afterSequence` for a fresh snapshot. The server sends the initial snapshot/replay frame, then event frames. Reconnect by opening a new socket and sending the last applied sequence.

Defaults: host `127.0.0.1`, port `7331`, inbound message limit 16 KiB. Port 0 is accepted for ephemeral test ports. Binding to any non-loopback host requires an explicit `authorize(request)` callback. Use TLS at a trusted reverse proxy for remote deployments; the SDK does not terminate TLS or prescribe an authentication scheme.

## Backpressure and shutdown

The WebSocket pump waits for each subscription frame and does not perform network work inside exporter hooks. A slow peer triggers queue resynchronization. Closing a socket closes its subscription; closing the server sends close code 1001 and releases connected subscriptions. Hub publication is synchronous and bounded by configured event/queue limits.

## Security boundary

Loopback is the default and the only binding that does not require an authorization callback. A non-loopback host without `authorize` is rejected at construction. The callback receives the underlying server request and must enforce the application's authentication and authorization policy. The transport does not treat a client-supplied session ID or cursor as an identity credential.
