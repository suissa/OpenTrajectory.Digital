import test from "node:test";
import assert from "node:assert/strict";
import { Expand } from "../src/decorators.js";
import { OpenTelemetryAdapter } from "../src/otel-adapter.js";
import type {
  OpenTelemetryContextBridgeLike,
  OpenTelemetrySpanContextLike,
  OpenTelemetrySpanLike,
  OpenTelemetrySpanOptionsLike,
  OpenTelemetryTracerLike
} from "../src/otel-adapter.js";
import { TrajectoryRuntime } from "../src/trajectory.js";

class FakeSpan implements OpenTelemetrySpanLike {
  readonly attributes = new Map<string, string | number | boolean>();
  readonly events: Array<{ name: string; attributes?: Record<string, string | number | boolean> }> = [];
  readonly links: Array<{ context: OpenTelemetrySpanContextLike; attributes?: Record<string, string | number | boolean> }> = [];
  status?: { code: number; message?: string };
  exceptions: Error[] = [];
  ended = false;
  constructor(
    readonly name: string,
    readonly options: OpenTelemetrySpanOptionsLike,
    readonly parentContext: unknown,
    private readonly throwOnStatus = false,
    private readonly index = 0
  ) {}
  setAttribute(name: string, value: string | number | boolean): void {
    this.attributes.set(name, value);
  }
  setStatus(status: { code: number; message?: string }): void {
    if (this.throwOnStatus) throw new Error("status exporter failed");
    this.status = status;
  }
  recordException(exception: Error): void {
    this.exceptions.push(exception);
  }
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    this.events.push({ name, attributes });
  }
  addLink(context: OpenTelemetrySpanContextLike, attributes?: Record<string, string | number | boolean>): void {
    this.links.push({ context, attributes });
  }
  spanContext(): OpenTelemetrySpanContextLike {
    return { traceId: "trace-1", spanId: `span-${this.index}`, traceFlags: 1 };
  }
  end(): void {
    this.ended = true;
  }
}

class FakeTracer implements OpenTelemetryTracerLike {
  readonly spans: FakeSpan[] = [];
  constructor(private readonly failTrackStatus = false) {}
  startSpan(name: string, options: OpenTelemetrySpanOptionsLike = {}, context?: unknown): FakeSpan {
    const span = new FakeSpan(name, options, context, this.failTrackStatus && name !== "root", this.spans.length + 1);
    this.spans.push(span);
    return span;
  }
}

function fakeContextBridge(): OpenTelemetryContextBridgeLike {
  return {
    active: () => ({ active: true }),
    setSpan: (context, span) => ({ parent: span.spanContext?.(), previous: context })
  };
}

test("OpenTelemetry adapter creates a root, preserves track parents, expansions and causal links", async () => {
  const tracer = new FakeTracer();
  const adapter = new OpenTelemetryAdapter(tracer, fakeContextBridge());
  const runtime = new TrajectoryRuntime({ exporters: [adapter] });

  await runtime.trajectory(
    { name: "root", correlationId: "corr-otel-1", attributes: { service: "checkout" } },
    async () => {
      const context = runtime.current()!;
      await context.track("source", () => {});
      const sourceId = context.snapshot().tracks[0]!.id;
      await context.track({ name: "target", causes: [sourceId] }, async () => {
        Expand("target.ready", { phase: "prepared" });
        await runtime.current()!.track("child", () => Expand("child.done", { count: 1 }));
        const targetId = context.snapshot().tracks[1]!.id;
        context.relate(sourceId, targetId, "derives_from");
      });
    }
  );

  const root = tracer.spans.find((span) => span.name === "root")!;
  const source = tracer.spans.find((span) => span.name === "source")!;
  const target = tracer.spans.find((span) => span.name === "target")!;
  const child = tracer.spans.find((span) => span.name === "child")!;
  assert.ok(root);
  assert.equal(root.options.attributes?.["open_trajectory.correlation_id"], "corr-otel-1");
  assert.equal(root.options.attributes?.["service"], "checkout");
  assert.equal(source.parentContext && (source.parentContext as { parent?: unknown }).parent !== undefined, true);
  assert.equal(child.parentContext && (child.parentContext as { parent?: { spanId?: string } }).parent?.spanId, target.spanContext().spanId);
  assert.equal(target.options.links?.length, 1);
  assert.equal(target.links.length, 1);
  assert.equal(target.events[0]?.name, "target.ready");
  assert.equal(child.events[0]?.name, "child.done");
  assert.ok(tracer.spans.every((span) => span.ended));
  assert.equal(root.status?.code, 1);
});

test("OpenTelemetry adapter maps failures to error status and exception events", async () => {
  const tracer = new FakeTracer();
  const runtime = new TrajectoryRuntime({
    exporters: [new OpenTelemetryAdapter(tracer, fakeContextBridge())]
  });

  await assert.rejects(
    runtime.trajectory("root", async () => {
      await runtime.current()!.track("failing.track", () => {
        throw new TypeError("original failure");
      });
    }),
    /original failure/
  );

  const track = tracer.spans.find((span) => span.name === "failing.track")!;
  const root = tracer.spans.find((span) => span.name === "root")!;
  assert.equal(track.status?.code, 2);
  assert.equal(track.status?.message, "original failure");
  assert.equal(track.exceptions[0]?.name, "TypeError");
  assert.equal(track.exceptions[0]?.message, "original failure");
  assert.equal(track.attributes.get("exception.type"), "TypeError");
  assert.equal(track.ended, true);
  assert.equal(root.status?.code, 2);
  assert.equal(root.ended, true);
});

test("OpenTelemetry spans are ended even when status export throws", async () => {
  const tracer = new FakeTracer(true);
  const runtime = new TrajectoryRuntime({
    exporters: [new OpenTelemetryAdapter(tracer, fakeContextBridge())]
  });

  await assert.rejects(
    runtime.trajectory("root", async () => {
      await runtime.current()!.track("status-failure", () => {});
    }),
    /status exporter failed/
  );

  const track = tracer.spans.find((span) => span.name === "status-failure")!;
  const root = tracer.spans.find((span) => span.name === "root")!;
  assert.equal(track.ended, true);
  assert.equal(root.ended, true);
});
