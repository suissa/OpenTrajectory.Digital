import test from "node:test";
import assert from "node:assert/strict";
import { Track, Trajectory } from "../src/decorators.js";
import { TrajectoryRuntime } from "../src/trajectory.js";
import type { TrajectorySnapshot, TrackSnapshot } from "../src/model.js";

test("runtime records nested tracks and expansions", async () => {
  let snapshot: TrajectorySnapshot | undefined;
  const runtime = new TrajectoryRuntime({ exporters: [{ onTrajectoryEnded(value) { snapshot = value; } }] });
  await runtime.trajectory({ name: "root", correlationId: "corr-1" }, async () => {
    await runtime.current()!.track("parent", async () => {
      await runtime.current()!.track("child", () => "done");
    });
  });
  assert.equal(snapshot?.correlationId, "corr-1");
  assert.deepEqual(snapshot?.tracks.map((track) => [track.name, track.depth, track.sequence]), [
    ["parent", 0, 1], ["child", 1, 2]
  ]);
});

test("decorated synchronous methods preserve return type and value", () => {
  class Service {
    @Track("sync")
    value(input: number) { return input + 1; }
  }
  const result = new Service().value(41);
  assert.equal(result, 42);
  assert.equal(typeof (result as any)?.then, "undefined");
});

test("decorated async methods remain promises", async () => {
  class Service {
    @Track("async")
    async value() { await Promise.resolve(); return "ok"; }
  }
  const result = new Service().value();
  assert.equal(typeof (result as any)?.then, "function");
  assert.equal(await result, "ok");
});

test("decorated method keeps this binding and records thrown errors", () => {
  let ended: TrackSnapshot | undefined;
  class Service {
    count = 0;
    @Track("increment")
    increment() { this.count += 1; throw new Error("expected"); }
  }
  const service = new Service();
  assert.throws(() => service.increment(), /expected/);
  assert.equal(service.count, 1);
});

test("concurrent trajectories retain isolated async contexts", async () => {
  const runtime = new TrajectoryRuntime();
  const seen: string[] = [];
  await Promise.all(["a", "b"].map((name) => runtime.trajectory(name, async () => {
    await Promise.resolve();
    await runtime.current()!.track(name, () => { seen.push(name); });
  })));
  assert.deepEqual(seen.sort(), ["a", "b"]);
});

test("snapshot attributes are detached from caller-owned objects", async () => {
  const attributes = { source: "caller" };
  let snapshot: TrajectorySnapshot | undefined;
  const runtime = new TrajectoryRuntime({ exporters: [{ onTrajectoryEnded(value) { snapshot = value; } }] });
  await runtime.trajectory({ name: "snapshot", attributes }, () => { attributes.source = "mutated"; });
  assert.equal(snapshot?.attributes.source, "caller");
});
