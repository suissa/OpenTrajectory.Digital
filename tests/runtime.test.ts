import test from "node:test";
import assert from "node:assert/strict";
import { Track, Trajectory } from "../src/decorators.js";
import { TrajectoryRuntime } from "../src/trajectory.js";
import type { TrajectorySnapshot } from "../src/model.js";

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
  await runtime.trajectory({ name: "snapshot", attributes }, () => {});
  snapshot!.attributes.source = "snapshot-mutated";
  assert.equal(attributes.source, "caller");
});


test("causal relation kinds are directed and duplicate edges are idempotent", async () => {
  const runtime = new TrajectoryRuntime();
  let context!: import("../src/trajectory.js").TrajectoryContext;
  let ids: string[] = [];
  await runtime.trajectory("relation-kinds", async () => {
    context = runtime.current()!;
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await context.track(name, () => {});
    }
    ids = context.snapshot().tracks.map((track) => track.id);
  });

  const kinds = ["causes", "depends_on", "expands", "follows", "derives_from"] as const;
  kinds.forEach((kind, index) => {
    context.relate(ids[index]!, ids[index + 1]!, kind);
    context.relate(ids[index]!, ids[index + 1]!, kind);
  });
  assert.equal(context.snapshot().relations.length, kinds.length);
  assert.deepEqual(context.topologicalTracks().map((track) => track.name), ["a", "b", "c", "d", "e", "f"]);
});

test("unknown, foreign, and self relations are rejected with diagnostics", async () => {
  const runtime = new TrajectoryRuntime();
  let context!: import("../src/trajectory.js").TrajectoryContext;
  let ownId = "";
  await runtime.trajectory("local", async () => {
    context = runtime.current()!;
    await context.track("local-track", () => {});
    ownId = context.snapshot().tracks[0]!.id;
  });

  let foreignId = "";
  await runtime.trajectory("foreign", async () => {
    await runtime.current()!.track("foreign-track", () => {});
    foreignId = runtime.current()!.snapshot().tracks[0]!.id;
  });

  const { CausalRelationError } = await import("../src/causal.js");
  assert.throws(
    () => context.relate("missing-source", ownId, "causes"),
    (error: unknown) => error instanceof CausalRelationError && error.code === "UNKNOWN_SOURCE_TRACK"
  );
  assert.throws(
    () => context.relate(ownId, foreignId, "causes"),
    (error: unknown) => error instanceof CausalRelationError && error.code === "UNKNOWN_TARGET_TRACK"
  );
  assert.throws(
    () => context.relate(ownId, ownId, "causes"),
    (error: unknown) => error instanceof CausalRelationError && error.code === "SELF_RELATION"
  );
});

test("causal cycles are rejected and never produce an invalid topological order", async () => {
  const runtime = new TrajectoryRuntime();
  let context!: import("../src/trajectory.js").TrajectoryContext;
  let ids: string[] = [];
  await runtime.trajectory("cycle", async () => {
    context = runtime.current()!;
    for (const name of ["a", "b", "c"]) await context.track(name, () => {});
    ids = context.snapshot().tracks.map((track) => track.id);
  });

  context.relate(ids[0]!, ids[1]!, "causes");
  context.relate(ids[1]!, ids[2]!, "depends_on");
  const { CausalRelationError } = await import("../src/causal.js");
  assert.throws(
    () => context.relate(ids[2]!, ids[0]!, "follows"),
    (error: unknown) => error instanceof CausalRelationError && error.code === "CAUSAL_CYCLE"
  );
  assert.deepEqual(context.topologicalTracks().map((track) => track.name), ["a", "b", "c"]);
});

test("topological projection is deterministic and does not reorder temporal snapshots", async () => {
  const runtime = new TrajectoryRuntime();
  let context!: import("../src/trajectory.js").TrajectoryContext;
  let ids: string[] = [];
  await runtime.trajectory("projection", async () => {
    context = runtime.current()!;
    for (const name of ["a", "b", "c", "d"]) await context.track(name, () => {});
    ids = context.snapshot().tracks.map((track) => track.id);
  });

  context.relate(ids[2]!, ids[0]!, "causes");
  context.relate(ids[0]!, ids[1]!, "derives_from");
  const temporal = context.snapshot().tracks.map((track) => track.name);
  const first = context.topologicalTracks().map((track) => track.name);
  const second = context.topologicalTracks().map((track) => track.name);
  assert.deepEqual(temporal, ["a", "b", "c", "d"]);
  assert.deepEqual(first, ["c", "a", "b", "d"]);
  assert.deepEqual(second, first);
});

test("TrackOptions.causes validates source IDs and creates directed edges", async () => {
  const runtime = new TrajectoryRuntime();
  let snapshot: TrajectorySnapshot | undefined;
  await runtime.trajectory("track-causes", async () => {
    const context = runtime.current()!;
    await context.track("cause", () => {});
    const causeId = context.snapshot().tracks[0]!.id;
    await context.track({ name: "effect", causes: [causeId] }, () => {});
    snapshot = context.snapshot();
  });
  assert.equal(snapshot?.relations.length, 1);
  assert.equal(snapshot?.relations[0]?.kind, "causes");
  assert.equal(snapshot?.relations[0]?.toTrackId, snapshot?.tracks[1]?.id);
});


test("topological projection rejects cyclic external snapshots with a cycle path", async () => {
  const runtime = new TrajectoryRuntime();
  let snapshot!: TrajectorySnapshot;
  await runtime.trajectory("external-cycle", async () => {
    const context = runtime.current()!;
    for (const name of ["a", "b", "c"]) await context.track(name, () => {});
    snapshot = context.snapshot();
  });
  const ids = snapshot.tracks.map((track) => track.id);
  const invalid = {
    ...snapshot,
    relations: [
      { fromTrackId: ids[0]!, toTrackId: ids[1]!, kind: "causes" as const },
      { fromTrackId: ids[1]!, toTrackId: ids[2]!, kind: "follows" as const },
      { fromTrackId: ids[2]!, toTrackId: ids[0]!, kind: "derives_from" as const }
    ]
  };
  const { CausalRelationError, topologicalTracks } = await import("../src/causal.js");
  assert.throws(
    () => topologicalTracks(invalid),
    (error: unknown) => error instanceof CausalRelationError &&
      error.code === "CAUSAL_CYCLE" &&
      error.cycle?.length === 4 &&
      error.cycle[0] === error.cycle[error.cycle.length - 1]
  );
});

test("invalid TrackOptions.causes does not leave a partial Track", async () => {
  const runtime = new TrajectoryRuntime();
  await assert.rejects(
    runtime.trajectory("invalid-track-cause", async () => {
      const context = runtime.current()!;
      await context.track("existing", () => {});
      await context.track({ name: "invalid", causes: ["not-in-this-trajectory"] }, () => {});
    }),
    (error: unknown) => error instanceof Error && error.message.includes("Unknown source Track")
  );
  // The failed Track is validated before insertion, so no ghost Track is emitted.
});
