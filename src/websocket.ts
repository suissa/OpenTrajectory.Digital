import { Buffer } from "node:buffer";
import {
  TrajectoryStreamHub,
  type TrajectoryStreamSubscription
} from "./streaming.js";

export interface WebSocketConnectionLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface WebSocketServerLike {
  on(
    event: "connection",
    listener: (socket: WebSocketConnectionLike, request: unknown) => void
  ): unknown;
  close(callback?: (error?: Error) => void): void;
}

export interface WebSocketServerFactory {
  create(options: {
    host: string;
    port: number;
    maxPayload: number;
  }): WebSocketServerLike;
}

export interface TrajectoryWebSocketServerOptions {
  /** Defaults to 127.0.0.1. Non-loopback bindings require an authorize callback. */
  host?: string;
  /** Defaults to 7331. Port 0 may be used for an ephemeral port. */
  port?: number;
  /** Maximum inbound WebSocket message size. Defaults to 16 KiB. */
  maxPayloadBytes?: number;
  /** Required when binding beyond loopback. */
  authorize?: (request: unknown) => boolean;
}

interface SubscribeRequest {
  type: "subscribe";
  sessionId?: string;
  afterSequence?: number;
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data) && data.every((item): item is Buffer => Buffer.isBuffer(item))) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

/**
 * WebSocket transport adapter. Inject a WebSocketServerFactory (for example,
 * one backed by the optional ws package) to keep the SDK transport-neutral.
 */
export class TrajectoryWebSocketServer {
  readonly host: string;
  readonly port: number;
  readonly maxPayloadBytes: number;
  private readonly authorize?: (request: unknown) => boolean;
  private server?: WebSocketServerLike;
  private readonly sockets = new Set<WebSocketConnectionLike>();
  private closed = false;

  constructor(
    private readonly hub: TrajectoryStreamHub,
    private readonly factory: WebSocketServerFactory,
    options: TrajectoryWebSocketServerOptions = {}
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 7331;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024;
    this.authorize = options.authorize;

    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new RangeError("WebSocket port must be an integer from 0 to 65535.");
    }
    if (!Number.isInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1) {
      throw new RangeError("maxPayloadBytes must be a positive integer.");
    }
    if (!isLoopback(this.host) && !this.authorize) {
      throw new Error("Non-loopback WebSocket binding requires an authorize callback.");
    }
  }

  start(): this {
    if (this.closed) throw new Error("TrajectoryWebSocketServer is closed.");
    if (this.server) return this;
    this.server = this.factory.create({
      host: this.host,
      port: this.port,
      maxPayload: this.maxPayloadBytes
    });
    this.server.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });
    return this;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) {
      try {
        socket.close(1001, "server shutting down");
      } catch {
        // Closing one peer must not prevent the remaining peers from closing.
      }
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private handleConnection(
    socket: WebSocketConnectionLike,
    request: unknown
  ): void {
    if (this.closed) {
      socket.close(1001, "server shutting down");
      return;
    }
    try {
      if (this.authorize && !this.authorize(request)) {
        socket.close(1008, "unauthorized");
        return;
      }
    } catch {
      socket.close(1008, "authorization failed");
      return;
    }

    this.sockets.add(socket);
    let subscription: TrajectoryStreamSubscription | undefined;
    let subscribed = false;
    const cleanup = () => {
      subscription?.close();
      subscription = undefined;
      this.sockets.delete(socket);
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", (data) => {
      if (subscribed) {
        socket.close(1008, "only one subscription is allowed per connection");
        cleanup();
        return;
      }

      let requestMessage: SubscribeRequest;
      try {
        const message = toText(data);
        if (Buffer.byteLength(message, "utf8") > this.maxPayloadBytes) {
          socket.close(1009, "message exceeds configured maxPayloadBytes");
          cleanup();
          return;
        }
        const parsed = JSON.parse(message) as Partial<SubscribeRequest>;
        if (parsed.type !== "subscribe" ||
          (parsed.afterSequence !== undefined &&
            (!Number.isSafeInteger(parsed.afterSequence) || parsed.afterSequence < 0 ||
              typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0))) {
          throw new Error("Invalid subscribe request.");
        }
        requestMessage = {
          type: "subscribe",
          sessionId: parsed.sessionId,
          afterSequence: parsed.afterSequence
        };
      } catch {
        socket.close(1003, "expected a valid subscribe message");
        cleanup();
        return;
      }

      try {
        const connection = this.hub.connect(requestMessage.afterSequence, requestMessage.sessionId);
        subscribed = true;
        subscription = connection.subscription;
        socket.send(JSON.stringify(connection.initial));
        void this.pump(socket, connection.subscription);
      } catch {
        socket.close(1011, "unable to open stream");
        cleanup();
      }
    });
  }

  private async pump(
    socket: WebSocketConnectionLike,
    subscription: TrajectoryStreamSubscription
  ): Promise<void> {
    while (!this.closed) {
      const frame = await subscription.next();
      if (!frame) return;
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        subscription.close();
        try {
          socket.close(1011, "stream send failed");
        } catch {
          // The peer may already be gone.
        }
        return;
      }
    }
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
