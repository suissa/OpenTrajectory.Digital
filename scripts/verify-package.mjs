import {
  execFileSync
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "opentrajectory-package-"));
const consumer = join(temp, "consumer");
mkdirSync(consumer, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
}

function inspectFiles(pack, label) {
  const paths = pack.files.map((file) => file.path);
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts"
  ];
  for (const path of required) {
    if (!paths.includes(path)) throw new Error(`${label} is missing required file: ${path}`);
  }
  const unexpected = paths.filter((path) =>
    !["package.json", "README.md", "LICENSE"].includes(path) &&
    !path.startsWith("dist/")
  );
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected files: ${unexpected.join(", ")}`);
  }
}

try {
  const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]))[0];
  inspectFiles(dryRun, "npm pack --dry-run");

  const packed = JSON.parse(run("npm", [
    "pack",
    "--json",
    "--pack-destination",
    temp
  ]))[0];
  inspectFiles(packed, "npm pack");
  const tarball = join(temp, packed.filename);
  if (!existsSync(tarball)) throw new Error("npm pack did not create the expected tarball.");

  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "opentrajectory-package-consumer-check",
    private: true,
    type: "module"
  }, null, 2));
  execFileSync("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    tarball
  ], { cwd: consumer, stdio: "inherit" });

  const consumerSource = `import {
  Expand,
  TrajectoryRuntime,
  TrajectoryStreamExporter,
  TrajectoryStreamHub,
  TrajectoryStreamStore,
  projectTrajectorySnapshot,
  type TrajectoryClock,
  type TrajectoryLimits,
  type TrajectorySnapshot
} from "@opentrajectory/digital";
import {
  TrajectoryWebSocketServer,
  type WebSocketServerFactory
} from "@opentrajectory/digital/websocket";
import {
  TrajectoryStreamHub as BrowserStreamHub,
  TrajectoryStreamStore as BrowserStreamStore
} from "@opentrajectory/digital/streaming";

const clock: TrajectoryClock = {
  monotonicNow: () => 1,
  wallTime: () => new Date(0).toISOString()
};
const limits: TrajectoryLimits = {
  maxAttributeBytes: 4096,
  maxExpansionsPerTrack: 5,
  maxTrackDepth: 2
};
const hub = new TrajectoryStreamHub();
const runtime = new TrajectoryRuntime({
  clock,
  limits,
  exporters: [new TrajectoryStreamExporter(hub)]
});
const store = new TrajectoryStreamStore();
const browserHub = new BrowserStreamHub();
const browserStore = new BrowserStreamStore();
const snapshot: TrajectorySnapshot | undefined = runtime.current()?.snapshot();
if (snapshot) projectTrajectorySnapshot(snapshot);
const factory: WebSocketServerFactory = {
  create: () => ({ on: () => undefined, close: (callback) => callback?.() })
};
const webSocketServer = new TrajectoryWebSocketServer(hub, factory);
void store;
void browserHub;
void browserStore;
void webSocketServer;
Expand("consumer.typecheck");
`;
  writeFileSync(join(consumer, "consumer.mts"), consumerSource);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true
    },
    include: ["consumer.mts"]
  }, null, 2));

  const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(consumer, "tsconfig.json")], {
    cwd: consumer,
    stdio: "inherit"
  });

  const runtimeCheck = `import {
  Expand,
  TrajectoryRuntime,
  TrajectoryStreamExporter,
  TrajectoryStreamHub,
  TrajectoryStreamStore
} from "@opentrajectory/digital";
const hub = new TrajectoryStreamHub();
const store = new TrajectoryStreamStore();
const runtime = new TrajectoryRuntime({
  exporters: [new TrajectoryStreamExporter(hub)]
});
const connection = hub.connect();
store.apply(connection.initial);
await runtime.trajectory("tarball.consumer", async () => {
  await runtime.current().track("consumer.track", () => Expand("consumer.ready"));
});
connection.subscription.close();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", runtimeCheck], {
    cwd: consumer,
    stdio: "inherit"
  });

  console.log(`Verified ${packed.filename}: ${packed.files.length} package files, ESM import and TypeScript declarations.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
