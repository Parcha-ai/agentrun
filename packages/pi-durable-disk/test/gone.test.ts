// What this package no longer has, pinned so nothing brings it back by accident. A run is a local directory under its
// host's epoch; placing a run on an Archil disk, supervising it, and forking it are agentrun-serve's, not this package's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; files: string[] };

/** The Archil run path, the supervisor and its host drivers, the client that woke a run through them, and fork. */
const GONE_ROOT = [
  "ARCHIL_SCOPED", "acquire", "revoke", "takeOver", "readReleased", "withClaim", "listRunFiles", "readRunFile",
  "archilControl", "deleteRunTree", "ensureRunning", "readRunStatus", "SuperviseError",
  "localHost", "LocalHostError", "dockerHost", "DockerHostError",
  "DAYTONA_LIST_PRICES", "DaytonaApiError", "daytonaHost", "DaytonaHostError", "daytonaRest", "daytonaUsdPerSecond",
  "requestRun", "ServeError", "archilPlace", "fork", "ForkError", "forkLocal",
];
const GONE_INTERNALS = ["createRunDir", "findDelegations", "mintMountToken", "pathlessResolver", "removeMountToken", "unmountClaim", "LABEL_FLEET", "LABEL_RUN", "sandboxName", "sandboxStatus", "sweepSandboxes"];

test("the root and internals entries export none of the Archil run path, the supervisor, its host drivers, requestRun or fork", async () => {
  const root = await import("../src/index.ts");
  const internals = await import("../src/internals.ts");
  assert.deepEqual(GONE_ROOT.filter((name) => name in root), []);
  assert.deepEqual(GONE_INTERNALS.filter((name) => name in internals), []);
});

test("the package ships no archil wrapper: no ./bin/archil-scoped export, file or files entry", () => {
  assert.equal(pkg.exports["./bin/archil-scoped"], undefined);
  assert.ok(!pkg.files.includes("bin/archil-scoped"));
  assert.ok(!existsSync(`${ROOT}bin/archil-scoped`));
});

/** What `main` says for `argv`: its exit code and what it wrote to stderr. */
async function said(argv: string[]): Promise<{ code: number; err: string }> {
  const write = process.stderr.write;
  let err = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((err += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), err };
  } finally {
    process.stderr.write = write;
  }
}

test("the CLI has no supervise, release or fork command, and its usage names none of them", async () => {
  for (const command of ["supervise", "release", "fork"]) {
    const { code, err } = await said([command, "--id", "r1"]);
    assert.equal(code, 2, command);
    assert.match(err, new RegExp(`^unknown command ${command}\n`), command);
    assert.doesNotMatch(err.split("\n").slice(1).join("\n"), /pi-durable-disk (supervise|release|fork)\b/, `${command}: the usage names none of them`);
  }
});

test("run and status take a local directory only: the Archil flags are unknown options, and run without --dir says so", async () => {
  const run = await said(["run", "--disk", "d", "--region", "r", "--id", "r1", "--app", "a.ts"]);
  assert.equal(run.code, 2);
  assert.match(run.err, /^Unknown option '--disk'/);
  assert.doesNotMatch(run.err, /--(disk|region|mount-root|archil|token-stdin) /, "the usage names no Archil flag");
  for (const flag of ["--archil", "--token-stdin", "--mount-root"]) {
    const { code, err } = await said(["run", "--dir", "/nonexistent/r1", "--app", "a.ts", flag, ...(flag === "--token-stdin" ? [] : ["x"])]);
    assert.equal(code, 2, flag);
    assert.match(err, new RegExp(`^Unknown option '${flag}'`), flag);
  }
  const bare = await said(["run", "--app", "a.ts"]);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /^--dir is required\n/);
  const status = await said(["status", "--disk", "d", "--region", "r", "--id", "r1"]);
  assert.equal(status.code, 2);
  assert.match(status.err, /^Unknown option '--disk'/);
});

// The lease: its file, its watchdog, owner.lock, the seal and the ./lease entry.
const GONE_LEASE_ROOT = ["StoreBehindSealError", "leaseParkTarget"];
const GONE_LEASE_INTERNALS = ["isLeaseFresh", "parseRunRecord", "RUN_JSON"];

test("the ./lease entry is gone, and no entry exports the lease, the seal or the lease file's readers", async () => {
  assert.equal(pkg.exports["./lease"], undefined);
  assert.ok(!existsSync(`${ROOT}src/lease.ts`), "no lease entry module");
  assert.ok(!existsSync(`${ROOT}src/watchdog.ts`), "no lease watchdog");
  const root = await import("../src/index.ts");
  const internals = await import("../src/internals.ts");
  assert.deepEqual(GONE_LEASE_ROOT.filter((name) => name in root), []);
  assert.deepEqual(GONE_LEASE_INTERNALS.filter((name) => name in internals), []);
  const run = await import("../src/run.ts");
  assert.deepEqual(["openRunLease", "OWNER_LOCK", "LeaseLapsedError", "StoreBehindSealError", "takeOwnerLock"].filter((name) => name in run), []);
});

test("run takes its host's epoch: without --epoch it refuses with exit 2, saying so, and the lease flags are unknown options", async () => {
  const bare = await said(["run", "--dir", "/dev/null/r1", "--app", "a.ts"]);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /^--epoch is required: the host that starts a run holds its claim and hands it its epoch \(run --dir PATH --epoch N\)\n/);
  for (const flag of ["--heartbeat-ms", "--lease-expiry-ms", "--lease-margin-ms"]) {
    const { code, err } = await said(["run", "--dir", "/dev/null/r1", "--epoch", "1", "--app", "a.ts", flag, "1000"]);
    assert.equal(code, 2, flag);
    assert.match(err, new RegExp(`^Unknown option '${flag}'`), flag);
  }
});
