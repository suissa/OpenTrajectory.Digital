import test from "node:test";
import assert from "node:assert/strict";
import { Track, Trajectory } from "../src/decorators.js";
import { TrajectoryRuntime, TrajectoryContext } from "../src/trajectory.js";

test("runtime records nested tracks and expansions", async () => {
  const runtime = new TrajectoryRuntime();
  await runtime.trajectory({ name: "root", correlationId: "corr-1" }, async () => {
    await runtime.current()!.track("parent", async () => {
      await runtime.current()!.track("child", () => "done");
    });
  });
  assert.equal(runtime.current(), undefined);
});

test("decorated synchronous methods preserve return type and value", () => {
  class Service {
    @Track("sync")
    value(input: number) { return input + 1; }
  }
  const service = new Service();
  const result = service.value(41);
  assert.equal(result, 42);
  assert.equal(typeof (result as any)?.then, "undefined");
});

test("decorated async methods remain promises", async () => {
  class Service {
    @Track("async")
    async value() { await Promise.resolve(); return "ok"; }
  }
  assert.equal(await new Service().value(), "ok");
});

test("decorated method keeps this binding and records thrown errors", () => {
  @Trajectory("service")
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
  let snapshot: ReturnType<NonNullable<typeof TrajectoryContext.current>["snapshot"]> | undefined;
  const runtime = new TrajectoryRuntime({ exporters: [{ onTrajectoryEnded(value) { snapshot = value; } }] });
  await runtime.trajectory({ name: "snapshot", attributes }, () => { attributes.source = "mutated"; });
  assert.equal(snapshot?.attributes.source, "caller");
});
