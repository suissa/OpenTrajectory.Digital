import test from "node:test";
import assert from "node:assert/strict";
import { Expand, Track, Trajectory } from "../src/decorators.js";
import { TrajectoryRuntime } from "../src/trajectory.js";
import type { TrajectorySnapshot } from "../src/model.js";
import { TrajectoryLimitError } from "../src/limits.js";
import type { TrajectoryClock } from "../src/trajectory.js";

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
  let context!: import("../src/trajectory.js").TrajectoryContext;
  await assert.rejects(
    runtime.trajectory("invalid-track-cause", async () => {
      context = runtime.current()!;
      await context.track("existing", () => {});
      await context.track({ name: "invalid", causes: ["not-in-this-trajectory"] }, () => {});
    }),
    (error: unknown) => error instanceof Error && error.message.includes("Unknown source Track")
  );
  assert.deepEqual(context.snapshot().tracks.map((track) => track.name), ["existing"]);
});


test("exporter snapshots and expansion payloads cannot mutate internal state", async () => {
  let finalSnapshot!: TrajectorySnapshot;
  const observedBySecondExporter: string[] = [];
  const inputAttributes = { root: "original" };
  const runtime = new TrajectoryRuntime({
    exporters: [{
      onExpansion(track, expansion) {
        track.attributes.owner = "exporter-mutated";
        expansion.attributes.marker = "exporter-mutated";
      },
      onRelation(snapshot, relation) {
        snapshot.attributes.root = "exporter-mutated";
        relation.attributes!.edge = "exporter-mutated";
      },
      onTrajectoryEnded(snapshot) {
        finalSnapshot = snapshot;
      }
    }, {
      onRelation(snapshot, relation) {
        observedBySecondExporter.push(String(snapshot.attributes.root), String(relation.attributes?.edge));
      }
    }]
  });

  let context!: import("../src/trajectory.js").TrajectoryContext;
  await runtime.trajectory({ name: "snapshot-isolation", attributes: inputAttributes }, async () => {
    context = runtime.current()!;
    inputAttributes.root = "caller-mutated";
    await context.track({ name: "source", attributes: { owner: "original" } }, () => {
      Expand("source.event", { marker: "original" });
    });
    await context.track("target", () => {});
    const ids = context.snapshot().tracks.map((track) => track.id);
    context.relate(ids[0]!, ids[1]!, "causes", { edge: "original" });

    const external = context.snapshot();
    external.attributes.root = "caller-mutated";
    external.tracks[0]!.attributes.owner = "caller-mutated";
    external.tracks[0]!.expansions[0]!.attributes.marker = "caller-mutated";
    external.relations[0]!.attributes!.edge = "caller-mutated";
  });

  assert.equal(finalSnapshot.attributes.root, "original");
  assert.equal(finalSnapshot.tracks[0]!.attributes.owner, "original");
  assert.equal(finalSnapshot.tracks[0]!.expansions[0]!.attributes.marker, "original");
  assert.equal(finalSnapshot.relations[0]!.attributes!.edge, "original");
  assert.deepEqual(observedBySecondExporter, ["original", "original"]);
});

test("all exporters receive lifecycle finalization after a start hook fails", async () => {
  const events: string[] = [];
  const runtime = new TrajectoryRuntime({
    exporters: [
      {
        onTrackStarted() { events.push("failing:start"); throw new Error("start hook failed"); },
        onTrackEnded(track) { events.push("failing:end:" + track.status); },
        onTrajectoryEnded(trajectory) { events.push("failing:trajectory:" + trajectory.status); }
      },
      {
        onTrackStarted() { events.push("observer:start"); },
        onTrackEnded(track) { events.push("observer:end:" + track.status); },
        onTrajectoryEnded(trajectory) { events.push("observer:trajectory:" + trajectory.status); }
      }
    ]
  });
  let callbackRan = false;

  await assert.rejects(
    runtime.trajectory("exporter-start-failure", () =>
      runtime.current()!.track("never-runs", () => { callbackRan = true; })
    ),
    (error: unknown) => error instanceof AggregateError
  );

  assert.equal(callbackRan, false);
  assert.ok(events.includes("observer:start"));
  assert.ok(events.includes("failing:end:error"));
  assert.ok(events.includes("observer:end:error"));
  assert.ok(events.includes("failing:trajectory:error"));
  assert.ok(events.includes("observer:trajectory:error"));
});

test("exporter end failures do not prevent other exporters or trajectory cleanup", async () => {
  const events: string[] = [];
  const runtime = new TrajectoryRuntime({
    exporters: [
      {
        onTrackEnded() { events.push("failing:end"); throw new Error("end hook failed"); },
        onTrajectoryEnded() { events.push("failing:trajectory-end"); }
      },
      {
        onTrackEnded() { events.push("observer:end"); },
        onTrajectoryEnded() { events.push("observer:trajectory-end"); }
      }
    ]
  });

  await assert.rejects(
    runtime.trajectory("exporter-end-failure", async () => {
      await runtime.current()!.track("tracked", () => "complete");
    }),
    (error: unknown) => error instanceof AggregateError
  );
  assert.ok(events.includes("observer:end"));
  assert.ok(events.includes("failing:trajectory-end"));
  assert.ok(events.includes("observer:trajectory-end"));
});

test("injected monotonic clock gives deterministic duration and process uptime metrics", async () => {
  let monotonic = 1_000;
  let wall = 1_800_000_000_000;
  const clock: TrajectoryClock = {
    monotonicNow: () => monotonic,
    wallTime: () => new Date(wall).toISOString()
  };
  let snapshot!: TrajectorySnapshot;
  const runtime = new TrajectoryRuntime({
    clock,
    exporters: [{ onTrajectoryEnded(value) { snapshot = value; } }]
  });

  await runtime.trajectory("clocked", async () => {
    monotonic += 5;
    wall += 5;
    await runtime.current()!.track("timed", () => {
      monotonic += 2;
      wall += 2;
      Expand("tick", { step: 1 });
      monotonic += 3;
      wall += 3;
    });
  });

  assert.equal(snapshot.processUptimeMs, 1_000);
  assert.equal(snapshot.processStartupMs, snapshot.processUptimeMs);
  assert.equal(snapshot.durationMs, 10);
  assert.equal(snapshot.tracks[0]!.durationMs, 5);
  assert.equal(snapshot.tracks[0]!.expansions[0]!.offsetMs, 2);
});

test("configured expansion, depth, and attribute limits fail before mutating state", async () => {
  const expansionRuntime = new TrajectoryRuntime({
    limits: { maxExpansionsPerTrack: 1 }
  });
  await expansionRuntime.trajectory("expansion-limit", async () => {
    await expansionRuntime.current()!.track("limited", () => {
      Expand("first");
      assert.throws(
        () => Expand("second"),
        (error: unknown) => error instanceof TrajectoryLimitError &&
          error.code === "MAX_EXPANSIONS_PER_TRACK"
      );
    });
  });

  const depthRuntime = new TrajectoryRuntime({ limits: { maxTrackDepth: 0 } });
  let depthContext!: import("../src/trajectory.js").TrajectoryContext;
  await depthRuntime.trajectory("depth-limit", async () => {
    depthContext = depthRuntime.current()!;
    await depthContext.track("root", async () => {
      await assert.rejects(
        depthRuntime.current()!.track("too-deep", () => {}),
        (error: unknown) => error instanceof TrajectoryLimitError &&
          error.code === "MAX_TRACK_DEPTH"
      );
    });
  });
  assert.deepEqual(depthContext.snapshot().tracks.map((track) => track.name), ["root"]);

  const attributeRuntime = new TrajectoryRuntime({
    limits: { maxAttributeBytes: 12 }
  });
  await attributeRuntime.trajectory("attribute-limit", async () => {
    const context = attributeRuntime.current()!;
    await assert.rejects(
      context.track({ name: "oversized", attributes: { payload: "this is too large" } }, () => {}),
      (error: unknown) => error instanceof TrajectoryLimitError &&
        error.code === "MAX_ATTRIBUTE_BYTES"
    );
    assert.equal(context.snapshot().tracks.length, 0);
  });
});
