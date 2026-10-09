// daytonaHost unit tests over a fake Daytona client whose toolbox runs each command with a local shell (the in-box
// launcher and a fake instance really run, in a scratch directory standing for the box), the status mapping, the create
// retries, stop, the janitor, and the REST client over a fake fetch. No Daytona, no Archil, no network.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  daytonaHost,
  daytonaRest,
  DaytonaApiError,
  DaytonaHostError,
  LABEL_FLEET,
  LABEL_RUN,
  sandboxName,
  sandboxStatus,
  sweepSandboxes,
  type CreateSandboxBody,
  type DaytonaClient,
  type ExecResult,
  type SandboxInfo,
} from "../src/hosts/daytona.ts";
import { launchStatus, readState, serve, type LaunchSpec, type LaunchState } from "../src/hosts/daytona-launch.ts";
import type { HostHandle } from "../src/supervise.ts";

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const TOKEN = `tok-${"7".repeat(40)}`;
const DAYTONA_KEY_SENTINEL = "daytona-key-must-not-travel";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCE = fileURLToPath(new URL("./fixtures/daytona-instance.mjs", import.meta.url));
const ME = userInfo().username;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
/** The scratch directories made since the last test ended. */
let fresh: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  fresh.push(d);
  return d;
};

/**
 * The fixture processes of these scratch directories, found in /proc rather than in the launchers' state files (a
 * launcher records an instance only after it spawned it, so a state file can lag): a launcher names its box on its
 * command line (`serve <name> --dir <d>/box`), an instance carries `PDA_TEST_OUT=<d>/...` in its environment. Never
 * this process (the `serve` tests run a launcher here). Empty where there is no /proc.
 */
function fixtureProcesses(within: string[]): { pid: number; what: string }[] {
  if (within.length === 0 || !existsSync("/proc/self/environ")) return [];
  const found: { pid: number; what: string }[] = [];
  for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    let argv: string[];
    let env: string[];
    try {
      argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
    } catch {
      continue;
    }
    const launcher = within.some((d) => argv.includes("serve") && argv[argv.indexOf("--dir") + 1] === join(d, "box"));
    const instance = within.some((d) => env.some((e) => e.startsWith(`PDA_TEST_OUT=${d}/`)));
    if (launcher || instance) found.push({ pid: Number(name), what: argv.filter(Boolean).slice(1).join(" ").slice(0, 200) });
  }
  return found;
}

/** SIGKILL every fixture process of `within` (an instance leads a session of its own: its group too) until none is left. */
async function reap(within: string[]): Promise<void> {
  for (let t0 = Date.now(), left = fixtureProcesses(within); left.length > 0 && Date.now() - t0 < 10_000; left = fixtureProcesses(within)) {
    for (const { pid } of left) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {}
      }
    }
    await sleep(50);
  }
}

/**
 * No fixture process outlives its test: whatever a test leaves running past a short grace (a stop that just returned
 * may still be exiting) is killed, and the test fails for it.
 */
afterEach(async () => {
  const mine = fresh;
  fresh = [];
  let left = fixtureProcesses(mine);
  for (const t0 = Date.now(); left.length > 0 && Date.now() - t0 < 5_000; left = fixtureProcesses(mine)) await sleep(50);
  await reap(mine);
  assert.deepEqual(fixtureProcesses(mine), [], "every fixture process is gone");
  assert.deepEqual(left, [], "a fixture process outlived its test");
});

/** The launchers and instances any test left alive, from /proc and from the state files, killed after the suite. */
after(async () => {
  await reap(dirs);
  for (const d of dirs) {
    const box = join(d, "box");
    if (!existsSync(box)) continue;
    for (const f of readdirSync(box).filter((n) => n.endsWith(".state"))) {
      const s = JSON.parse(readFileSync(join(box, f), "utf8")) as LaunchState;
      // `serve` tests ran the launcher in this process: its state names this pid, which is not ours to kill.
      for (const pid of [s.instance, s.launcher].filter((p) => p && p !== process.pid)) {
        try {
          process.kill(pid!, "SIGKILL");
        } catch {}
      }
    }
  }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(20)) {
    const v = fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The toolbox: the command piped to a shell's stdin, output combined, the process group killed at the timeout. */
function shell(command: string, timeoutSec: number, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [], { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = timeoutSec > 0 ? setTimeout(() => process.kill(-child.pid!, "SIGKILL"), timeoutSec * 1000) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, result: out });
    });
    child.stdin.end(command);
  });
}

type Fault = Error | "landed-503" | "409-own" | "409-foreign";

/** An in-memory Daytona: boxes start after `startAfterGets` reads; every call is recorded; faults are queued per call. */
function fakeDaytona(o: { startAfterGets?: number; cwd?: string; writeFiles?: boolean } = {}) {
  const boxes = new Map<string, SandboxInfo & { deleted?: boolean; reads: number }>();
  const calls: { op: string; arg?: unknown }[] = [];
  const creates: CreateSandboxBody[] = [];
  const uploads: { box: string; path: string; text: string }[] = [];
  const execs: { box: string; command: string }[] = [];
  const faults = { create: [] as Fault[], get: [] as Error[], remove: [] as Error[], exec: [] as (Error | ExecResult)[], upload: [] as Error[] };
  let next = 1;
  const add = (body: CreateSandboxBody, labels = body.labels) => {
    const box = { id: `sb-${next++}`, name: body.name, state: "creating", labels, target: body.target, reads: 0 };
    boxes.set(box.id, box);
    return box;
  };
  const find = (idOrName: string) => [...boxes.values()].find((b) => !b.deleted && (b.id === idOrName || b.name === idOrName));
  const view = ({ reads: _r, deleted: _d, ...b }: SandboxInfo & { deleted?: boolean; reads: number }): SandboxInfo => ({ ...b, labels: { ...b.labels } });
  const client: DaytonaClient = {
    async create(body) {
      calls.push({ op: "create", arg: body });
      creates.push(structuredClone(body));
      const f = faults.create.shift();
      if (f instanceof Error) throw f;
      if (f === "landed-503") {
        add(body);
        throw new DaytonaApiError(503, "POST /sandbox: 503 upstream");
      }
      if (f === "409-own" || f === "409-foreign") {
        add(body, f === "409-own" ? body.labels : { [LABEL_FLEET]: "someone-else" });
        throw new DaytonaApiError(409, `POST /sandbox: 409 Sandbox with name ${body.name} already exists`);
      }
      if (find(body.name)) throw new DaytonaApiError(409, "duplicate");
      return view(add(body));
    },
    async get(idOrName) {
      calls.push({ op: "get", arg: idOrName });
      const f = faults.get.shift();
      if (f) throw f;
      const box = find(idOrName);
      if (!box) return null;
      if (box.state === "creating" && box.reads++ >= (o.startAfterGets ?? 1)) box.state = "started";
      return view(box);
    },
    async list(labels) {
      calls.push({ op: "list", arg: labels });
      return [...boxes.values()].filter((b) => !b.deleted && Object.entries(labels).every(([k, v]) => b.labels?.[k] === v)).map(view);
    },
    async stop(id, force) {
      calls.push({ op: "stop", arg: { id, force } });
      const box = find(id);
      if (box) box.deleted = true;
    },
    async remove(id) {
      calls.push({ op: "remove", arg: id });
      const f = faults.remove.shift();
      if (f) throw f;
      const box = find(id);
      if (box) box.deleted = true;
    },
    async exec(box, command, timeoutSec) {
      calls.push({ op: "exec", arg: command });
      execs.push({ box: box.id, command });
      if (!find(box.id)) throw new DaytonaApiError(404, "no such sandbox");
      const f = faults.exec.shift();
      if (f instanceof Error) throw f;
      if (f) return f;
      return shell(command, timeoutSec, o.cwd ?? "/");
    },
    async upload(box, path, content) {
      calls.push({ op: "upload", arg: path });
      const f = faults.upload.shift();
      if (f) throw f;
      uploads.push({ box: box.id, path, text: new TextDecoder().decode(content) });
      if (o.writeFiles !== false) writeFileSync(path, content);
    },
  };
  return { client, boxes, calls, creates, uploads, execs, faults, setState: (id: string, state: string) => void (boxes.get(id)!.state = state) };
}

/** A driver whose box is a scratch directory, its launcher this checkout's, its instance the fake one. */
function world(codes = "hold", over: Partial<Parameters<typeof daytonaHost>[0]> = {}) {
  const d = scratch("pda-dt-");
  const box = join(d, "box");
  const out = join(d, "instance.jsonl");
  const fake = fakeDaytona({ cwd: d });
  const host = daytonaHost({
    client: fake.client,
    snapshot: "pda-runtime-test",
    target: "us",
    fleet: "p9t",
    labels: { suite: "unit" },
    mountRoot: "/mnt/pda/p9",
    node: process.execPath,
    packageDir: REPO,
    launcher: join(REPO, "src/hosts/daytona-launch.ts"),
    command: [process.execPath, INSTANCE],
    runArgs: ["--app", "/opt/app.ts"],
    user: ME,
    boxDir: box,
    stageDir: join(d, "stage"),
    sudo: false,
    env: { PDA_TEST_OUT: out, PDA_TEST_CODES: codes },
    pollMs: 5,
    startTimeoutMs: 20_000,
    stopTimeoutMs: 5_000,
    ...over,
  });
  const lines = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...fake, host, box, out, lines };
}

// ---- start, status, stop end to end over the fake toolbox ----------------------------------------------------------------

test("start: one labeled box that deletes itself on stop and dies at its TTL; the token only in an upload into the root-only directory; the instance gets it on stdin", async () => {
  const prev = process.env.DAYTONA_API_KEY;
  process.env.DAYTONA_API_KEY = DAYTONA_KEY_SENTINEL;
  try {
    const w = world();
    const h = await w.host.start(REF, TOKEN);
    const name = String(h.name);
    assert.match(name, /^pda-r1-[0-9a-z]+$/);
    assert.deepEqual(h, { driver: "daytona", fleet: "p9t", target: "us", sandboxId: "sb-1", name, mountpoint: "/mnt/pda/p9/runs/r1" });
    assert.deepEqual(w.creates, [
      { name, snapshot: "pda-runtime-test", target: "us", labels: { suite: "unit", [LABEL_FLEET]: "p9t", [LABEL_RUN]: "r1" }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 1500 },
    ]);

    const withToken = w.uploads.filter((u) => u.text.includes(TOKEN));
    const stage = join(dirname(w.box), "stage");
    assert.deepEqual(withToken.map((u) => u.path), [join(stage, `${name}.token`)], "the token travels once, as an upload body, into the staging directory");
    assert.ok(!JSON.stringify(w.creates).includes(TOKEN) && !w.execs.some((e) => e.command.includes(TOKEN)), "never in the create body or a command");
    assert.equal(w.execs[0].command, `umask 077 && mkdir -p ${stage} && chmod 700 ${stage} && [ "$(stat -c %u ${stage})" = "$(id -u)" ] && mkdir -p ${w.box} && chmod 700 ${w.box}`, "both directories exist, 0700, before any upload");
    assert.equal(w.calls.findIndex((c) => c.op === "exec") < w.calls.findIndex((c) => c.op === "upload"), true);
    assert.equal(statSync(w.box).mode & 0o777, 0o700);
    assert.equal(statSync(stage).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(stage, `${name}.token`)) && !existsSync(join(stage, `${name}.json`)), "the launcher moved both files out of the staging directory");
    assert.ok(!existsSync(join(w.box, `${name}.token`)), "and unlinked the token once it read it");
    assert.match(w.execs[1].command, new RegExp(`daytona-launch\\.ts start ${name} --dir ${w.box} --stage ${stage} --timeout-ms \\d+$`));

    const spec = JSON.parse(readFileSync(join(w.box, `${name}.json`), "utf8")) as LaunchSpec;
    assert.equal(spec.user, ME);
    assert.deepEqual(spec.terminalExits, [65, 70, 75, 76]);

    const [first] = await waitFor("the instance", () => (w.lines().length ? w.lines() : null));
    assert.equal(first.token, TOKEN);
    assert.deepEqual(first.argv, ["run", "--disk", REF.disk, "--region", REF.region, "--id", "r1", "--mount-root", "/mnt/pda/p9", "--archil", "/usr/local/sbin/archil-scoped", "--app", "/opt/app.ts", "--token-stdin"]);
    assert.deepEqual(JSON.parse(first.holder), h, "run.json's holder is the driver's handle");
    assert.ok(!first.envKeys.some((k: string) => /^(DAYTONA|ARCHIL)_/.test(k)), "no API key reaches the instance");
    assert.deepEqual([...first.envKeys].sort(), ["HOME", "LANG", "PATH", "PDA_HOLDER", "PDA_TEST_CODES", "PDA_TEST_OUT"]);

    assert.equal(await w.host.status(h), "running");
    await w.host.stop(h);
    const s = launchStatus(w.box, name);
    assert.equal(s.status, "stopped", "stop drained the instance (SIGTERM, exit 0) before the box went");
    assert.equal(s.state?.reason, "stopped");
    assert.deepEqual(w.calls.filter((c) => c.op === "remove").map((c) => c.arg), ["sb-1"]);
    assert.equal(await w.host.status(h), "gone");
  } finally {
    if (prev === undefined) delete process.env.DAYTONA_API_KEY;
    else process.env.DAYTONA_API_KEY = prev;
  }
});

test("restart in place: a non-terminal exit restarts the instance after 1 s with an empty stdin (it reuses its live mount)", async () => {
  const w = world("3,hold");
  const h = await w.host.start(REF, TOKEN);
  const lines = await waitFor("two incarnations", () => (w.lines().length >= 2 ? w.lines() : null), 15_000);
  assert.equal(lines[0].token, TOKEN);
  assert.equal(lines[1].token, "", "only the first incarnation gets the token");
  // The launcher records a spawn after the child's spawn event, so the second line can come first.
  const state = await waitFor("the launcher's record of the second spawn", () => {
    const s = readState(w.box, String(h.name));
    return s && s.spawned >= 2 ? s : null;
  }, 15_000);
  assert.equal(state.restarts, 1);
  assert.equal(state.spawned, 2);
  assert.equal(await w.host.status(h), "running");
  await w.host.stop(h);
});

test("terminal exit: 75 is never restarted; the start still succeeded and status says failed", async () => {
  const w = world("75");
  const h = await w.host.start(REF, TOKEN);
  await waitFor("the launcher to end", () => readState(w.box, String(h.name))?.phase === "exited");
  await sleep(100);
  assert.equal(w.lines().length, 1);
  assert.equal(readState(w.box, String(h.name))!.reason, "terminal exit 75");
  assert.equal(await w.host.status(h), "failed");
});

test("a launcher that cannot run the instance (another user, not root) fails the start, and the box is deleted", async () => {
  const w = world("hold", { user: "nobody", group: "nogroup" });
  await assert.rejects(w.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED" && /needs root/.test(e.message));
  assert.deepEqual(w.calls.filter((c) => c.op === "remove").map((c) => c.arg), ["sb-1"]);
  assert.equal(w.lines().length, 0);
});

test("prepare runs once the box is started and before anything is uploaded; with sudo every launcher command goes through sudo -n", async () => {
  const order: string[] = [];
  const w = world("hold", {
    prepare: async (box, client) => {
      order.push(`prepare ${box.state} after ${w.calls.filter((c) => c.op === "upload").length} uploads`);
      assert.equal((await client.exec(box, "true", 5)).exitCode, 0);
    },
  });
  const h = await w.host.start(REF, TOKEN);
  assert.deepEqual(order, ["prepare started after 0 uploads"]);
  await w.host.stop(h);

  const s = fakeDaytona({ writeFiles: false });
  s.faults.exec.push({ exitCode: 0, result: "" }, { exitCode: 0, result: '{"spawned":1,"phase":"running","instance":2}' }, { exitCode: 0, result: '{"status":"running"}' });
  const host = daytonaHost({ client: s.client, snapshot: "s", fleet: "p9t", pollMs: 1 });
  const hh = await host.start(REF, TOKEN);
  await host.status(hh);
  assert.match(s.execs[0].command, /&& sudo -n mkdir -p \/run\/pda && sudo -n chmod 700 \/run\/pda$/);
  assert.match(s.execs[1].command, /^sudo -n \/usr\/local\/bin\/node \/usr\/local\/lib\/pi-durable-disk\/dist\/hosts\/daytona-launch\.js start pda-r1-\w+ --dir \/run\/pda --stage \/tmp\/pda-stage --timeout-ms \d+$/);
  assert.match(s.execs[2].command, /^sudo -n \/usr\/local\/bin\/node \S+ status pda-r1-\w+ --dir \/run\/pda$/);
  assert.deepEqual(s.uploads.map((u) => u.path.replace(/pda-r1-\w+/, "N")), ["/tmp/pda-stage/N.json", "/tmp/pda-stage/N.token"]);
});

// ---- the launcher alone --------------------------------------------------------------------------------------------------

function launchDir(spec: LaunchSpec, token = TOKEN) {
  const d = scratch("pda-launch-");
  const box = join(d, "box");
  mkdirSync(box, { mode: 0o700 });
  writeFileSync(join(box, "x.json"), JSON.stringify(spec));
  writeFileSync(join(box, "x.token"), token);
  return box;
}

test("launcher: past the restart limit it stops restarting (systemd's start limit), and says why", async () => {
  const d = scratch("pda-launch-out-");
  const out = join(d, "out.jsonl");
  const box = launchDir({ argv: [process.execPath, INSTANCE], env: { PDA_TEST_OUT: out, PDA_TEST_CODES: "3" }, restartDelayMs: 10, restartLimit: { burst: 2, intervalMs: 60_000 } });
  const end = await serve(box, "x");
  assert.equal(end.phase, "exited");
  assert.equal(end.reason, "restart limit (2 in 60000 ms)");
  assert.equal(end.spawned, 3);
  assert.equal(end.restarts, 2);
  assert.equal(end.exit, 3);
});

test("launcher: never root; another user only as root; nothing runs on a refusal; a missing state is failed", async () => {
  const root = await serve(launchDir({ argv: [process.execPath, INSTANCE], env: {}, user: "root" }), "x");
  assert.equal(root.spawned, 0);
  assert.match(root.reason!, /never runs as root/);
  const box = launchDir({ argv: [process.execPath, INSTANCE], env: {}, user: "nobody", group: "nogroup" });
  const end = await serve(box, "x");
  assert.equal(end.spawned, 0);
  assert.match(end.reason!, /needs root/);
  assert.ok(!existsSync(join(box, "x.token")), "a refused launch still unlinks the token");
  assert.equal(launchStatus(box, "never-started").status, "failed");
  assert.throws(() => launchStatus(box, "../escape"), /safe path segment/);
});

// ---- status ------------------------------------------------------------------------------------------------------------

test("sandboxStatus: every Daytona state", () => {
  const want: Record<string, string> = {
    started: "check",
    creating: "running", pulling_snapshot: "running", pending_build: "running", building_snapshot: "running", starting: "running",
    restoring: "running", resuming: "running", resizing: "running", snapshotting: "running", forking: "running",
    stopping: "running", pausing: "running", paused: "running",
    stopped: "stopped", archived: "stopped", archiving: "stopped", destroying: "stopped",
    destroyed: "gone",
    error: "failed", build_failed: "failed",
    unknown: "unknown",
  };
  for (const [state, status] of Object.entries(want)) assert.equal(sandboxStatus(state), status, state);
  assert.equal(sandboxStatus(undefined), "unknown");
});

test("status: another fleet's or driver's handle is unknown without an API call; a deleted box is gone; box states map; the box's own word decides a started one", async () => {
  const w = world();
  const h = await w.host.start(REF, TOKEN);
  const before = w.calls.length;
  assert.equal(await w.host.status({ ...h, fleet: "other" }), "unknown");
  assert.equal(await w.host.status({ driver: "local", unit: "x" }), "unknown");
  assert.equal(w.calls.length, before, "a handle that is not this fleet's costs no call");

  w.faults.exec.push(new DaytonaApiError(null, "toolbox timed out"));
  assert.equal(await w.host.status(h), "running", "a started box that does not answer may still hold its claim");
  w.faults.exec.push({ exitCode: 127, result: "node: not found" });
  assert.equal(await w.host.status(h), "running");

  await w.host.stop(h);
  assert.equal(await w.host.status(h), "gone");

  const boxed = (state: string): HostHandle => {
    const b = { id: `sb-x-${state}`, name: `pda-x-${state}`, state, labels: { [LABEL_FLEET]: "p9t" }, reads: 0 };
    w.boxes.set(b.id, b);
    return { ...h, sandboxId: b.id, name: b.name };
  };
  assert.equal(await w.host.status(boxed("stopping")), "running");
  assert.equal(await w.host.status(boxed("error")), "failed");
  assert.equal(await w.host.status(boxed("archived")), "stopped");

  // A started box whose launcher ended: a clean exit is stopped, anything else (or no record at all) is failed.
  const ended = (exit: number | null, phase: LaunchState["phase"]) => {
    const hh = boxed("started");
    const s: LaunchState = { launcher: 999_999_999, launcherTicks: 1, phase, instance: null, instanceTicks: null, spawned: 1, restarts: 0, exit, signal: null, reason: null, at: "" };
    writeFileSync(join(w.box, `${hh.name}.state`), JSON.stringify(s));
    return hh;
  };
  assert.equal(await w.host.status(ended(0, "exited")), "stopped");
  assert.equal(await w.host.status(ended(75, "exited")), "failed");
  assert.equal(await w.host.status(ended(null, "running")), "failed", "both processes gone without an exit record");
  assert.equal(await w.host.status(boxed("started")), "failed", "no launcher state at all");

  w.faults.get.push(new DaytonaApiError(502, "bad gateway"));
  await assert.rejects(w.host.status(h), (e: unknown) => e instanceof DaytonaHostError && e.code === "DAYTONA_API_FAILED");
});

// ---- create retries and failed starts ------------------------------------------------------------------------------------

test("create: a retryable failure that landed is adopted by name; one that did not is retried; a 409 adopts this start's own box only", async () => {
  const landed = world();
  landed.faults.create.push("landed-503");
  const h1 = await landed.host.start(REF, TOKEN);
  assert.equal(landed.creates.length, 1, "the box that landed is found by name, not created twice");
  assert.equal(h1.sandboxId, "sb-1");
  await landed.host.stop(h1);

  const lost = world();
  lost.faults.create.push(new DaytonaApiError(null, "socket hang up"));
  const h2 = await lost.host.start(REF, TOKEN);
  assert.equal(lost.creates.length, 2);
  assert.equal(lost.creates[0].name, lost.creates[1].name, "a retry keeps the name, which makes it idempotent");
  await lost.host.stop(h2);

  const own = world();
  own.faults.create.push("409-own");
  const h3 = await own.host.start(REF, TOKEN);
  assert.equal(h3.sandboxId, "sb-1");
  await own.host.stop(h3);

  const foreign = world();
  foreign.faults.create.push("409-foreign");
  await assert.rejects(foreign.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED" && /not this start's/.test(e.message));
  assert.equal(foreign.calls.filter((c) => c.op === "remove").length, 0, "a box that is not ours is never deleted");
});

test("create: a refusal is not retried; retries stop after the attempt limit", async () => {
  const refused = world();
  refused.faults.create.push(new DaytonaApiError(400, "POST /sandbox: 400 snapshot not found"));
  await assert.rejects(refused.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED" && /snapshot not found/.test(e.message));
  assert.equal(refused.creates.length, 1);

  const busy = world();
  for (let i = 0; i < 3; i++) busy.faults.create.push(new DaytonaApiError(503, "no capacity"));
  await assert.rejects(busy.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED");
  assert.equal(busy.creates.length, 3);
  assert.equal(busy.uploads.length, 0);
});

test("a box that fails, never starts, or refuses an upload is deleted, and the error is typed", async () => {
  const broken = world();
  broken.client.get = (orig => async (id: string) => {
    const b = await orig(id);
    if (b) broken.setState(b.id, "error");
    return b && { ...b, state: "error", errorReason: "runner lost" };
  })(broken.client.get.bind(broken.client));
  await assert.rejects(broken.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED" && /error while starting: runner lost/.test(e.message));
  assert.deepEqual(broken.calls.filter((c) => c.op === "remove").map((c) => c.arg), ["sb-1"]);
  assert.equal(broken.uploads.length, 0, "no token left a box that never started");

  const slow = world("hold", { startTimeoutMs: 40 });
  slow.client.get = async (id) => ({ id, name: "n", state: "pulling_snapshot", labels: {} });
  await assert.rejects(slow.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && /did not start in 40 ms/.test(e.message));
  assert.deepEqual(slow.calls.filter((c) => c.op === "remove").map((c) => c.arg), ["sb-1"]);

  const upload = world();
  upload.faults.upload.push(new DaytonaApiError(500, "disk full"));
  await assert.rejects(upload.host.start(REF, TOKEN), (e: unknown) => e instanceof DaytonaHostError && e.code === "START_FAILED");
  assert.deepEqual(upload.calls.filter((c) => c.op === "remove").map((c) => c.arg), ["sb-1"]);
});

// ---- stop ----------------------------------------------------------------------------------------------------------------

test("stop: another fleet's handle and a gone box are no-ops; a refused delete powers the box off and deletes again; a second refusal is typed", async () => {
  const w = world();
  const h = await w.host.start(REF, TOKEN);
  const n = w.calls.length;
  await w.host.stop({ ...h, fleet: "other" });
  assert.equal(w.calls.length, n);

  w.faults.remove.push(new DaytonaApiError(409, "state change in progress"));
  await w.host.stop(h);
  const tail = w.calls.slice(n).map((c) => c.op);
  assert.deepEqual(tail, ["get", "exec", "remove", "stop", "remove"]);
  assert.deepEqual(w.calls.find((c) => c.op === "stop")!.arg, { id: "sb-1", force: true });

  await w.host.stop(h);
  assert.deepEqual(w.calls.slice(-1).map((c) => c.op), ["get"], "a gone box costs one read");

  const v = world();
  const hv = await v.host.start(REF, TOKEN);
  v.faults.remove.push(new DaytonaApiError(500, "a"), new DaytonaApiError(500, "b"));
  v.client.stop = async () => {};
  await assert.rejects(v.host.stop(hv), (e: unknown) => e instanceof DaytonaHostError && e.code === "STOP_FAILED");
  v.faults.remove.length = 0;
  await v.host.stop(hv);
});

test("the label decides: a handle pointing at a box of another fleet gets unknown and a no-op stop; a stop that cannot read the box deletes nothing", async () => {
  const w = world();
  w.boxes.set("sb-foreign", { id: "sb-foreign", name: "other-job", state: "started", labels: { user_id: "u1" }, reads: 0 });
  const forged: HostHandle = { driver: "daytona", fleet: "p9t", target: "us", sandboxId: "sb-foreign", name: "other-job", mountpoint: "/mnt/pda/p9/runs/r1" };
  assert.equal(await w.host.status(forged), "unknown");
  await w.host.stop(forged);
  assert.ok(!w.calls.some((c) => c.op === "exec" || c.op === "remove" || c.op === "stop"), "nothing but reads touched the other box");

  const h = await w.host.start(REF, TOKEN);
  w.faults.get.push(new DaytonaApiError(null, "timeout"));
  await assert.rejects(w.host.stop(h), (e: unknown) => e instanceof DaytonaHostError && e.code === "STOP_FAILED");
  assert.equal(w.calls.filter((c) => c.op === "remove").length, 0);
  await w.host.stop(h);
});

test("stop: a box that is not started is deleted without asking it anything", async () => {
  const w = world();
  const h = await w.host.start(REF, TOKEN);
  await waitFor("the instance", () => w.lines().length > 0);
  w.setState("sb-1", "stopping");
  const n = w.calls.length;
  await w.host.stop(h);
  assert.deepEqual(w.calls.slice(n).map((c) => c.op), ["get", "remove"]);
  process.kill(readState(w.box, String(h.name))!.launcher, "SIGTERM");
});

// ---- options, names, the janitor -------------------------------------------------------------------------------------------

test("options: the instance never runs as root; box paths are plain; the fleet is a label value; a snapshot is required", () => {
  const client = fakeDaytona().client;
  const bad = (o: Partial<Parameters<typeof daytonaHost>[0]>) => assert.throws(() => daytonaHost({ client, snapshot: "s", ...o }), (e: unknown) => e instanceof DaytonaHostError && e.code === "INVALID_ARGUMENT");
  bad({ user: "root" });
  bad({ user: "0" });
  bad({ user: "a b" });
  bad({ mountRoot: "relative/path" });
  bad({ boxDir: "/run/pda; rm -rf /" });
  bad({ node: "/usr/bin/node $(id)" });
  bad({ fleet: "Upper" });
  bad({ snapshot: "" });
  assert.equal(daytonaHost({ client, snapshot: "s" }).mountRoot, "/mnt/archil");
});

test("sandboxName: lowercase, at most 63 characters, safe for any run id", () => {
  assert.match(sandboxName("pda-", "Run_ID.with.Dots", 1), /^pda-run-id-with-dots-1[0-9a-z]{2}$/);
  assert.ok(sandboxName("pda-", "x".repeat(128), Date.now()).length <= 63);
  assert.match(sandboxName("pda-", "___", 1), /^pda-run-1/);
});

test("sweepSandboxes: deletes every box of the fleet and nothing else; refuses without a fleet label", async () => {
  const f = fakeDaytona();
  const mk = (name: string, fleet: string) => f.boxes.set(name, { id: name, name, state: "started", labels: { [LABEL_FLEET]: fleet }, reads: 0 });
  mk("a", "p9");
  mk("b", "p9");
  mk("c", "other-prod");
  f.faults.remove.push(new DaytonaApiError(500, "later"));
  const r = await sweepSandboxes(f.client, { [LABEL_FLEET]: "p9" });
  assert.deepEqual(r.deleted, ["b"]);
  assert.deepEqual(r.failed.map((x) => x.id), ["a"]);
  assert.equal(f.boxes.get("c")!.deleted, undefined);
  await assert.rejects(sweepSandboxes(f.client, {}), (e: unknown) => e instanceof DaytonaHostError);
});

// ---- the REST client ------------------------------------------------------------------------------------------------------

function fakeFetch(answer: (url: URL, init: RequestInit) => { status: number; body?: unknown } | Error) {
  const seen: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body });
    const a = answer(url, init);
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { f, seen };
}

test("REST: Bearer key on every call, JSON bodies, 404 as absent for get, stop and delete, force as a query flag", async () => {
  const KEY = "dtn_secret_key_value";
  const { f, seen } = fakeFetch((url, init) => {
    if (url.pathname === "/api/sandbox" && init.method === "POST") return { status: 200, body: { id: "sb-1", name: "n", state: "creating" } };
    if (url.pathname === "/api/sandbox/missing") return { status: 404, body: { message: "not found" } };
    if (url.pathname === "/api/sandbox/sb-1") return { status: 200, body: { id: "sb-1", name: "n", state: "started" } };
    if (url.pathname === "/api/sandbox/sb-1/stop") return { status: 200 };
    if (url.pathname === "/api/sandbox/gone/stop" || url.pathname === "/api/sandbox/gone") return { status: 404 };
    return { status: 500, body: "unexpected" };
  });
  const c = daytonaRest({ apiKey: KEY, apiUrl: "https://api.test/api/", fetch: f });
  const body: CreateSandboxBody = { name: "n", snapshot: "s", labels: { [LABEL_FLEET]: "p9" }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 90 };
  assert.equal((await c.create(body)).id, "sb-1");
  assert.deepEqual(JSON.parse(String(seen[0].body)), body);
  assert.equal(seen[0].headers["Content-Type"], "application/json");
  assert.equal(await c.get("missing"), null);
  assert.equal((await c.get("sb-1"))?.state, "started");
  await c.stop("sb-1", true);
  assert.equal(seen.at(-1)!.url.search, "?force=true");
  await c.stop("gone", false);
  await c.remove("gone");
  assert.equal(seen.at(-1)!.method, "DELETE");
  assert.ok(seen.every((s) => s.headers.Authorization === `Bearer ${KEY}`));
  assert.throws(() => daytonaRest({ apiKey: "" }), (e: unknown) => e instanceof DaytonaHostError && e.code === "INVALID_ARGUMENT");
});

test("REST: list sends the labels as JSON and follows the cursor", async () => {
  const { f, seen } = fakeFetch((url) =>
    url.searchParams.get("cursor") === "p2"
      ? { status: 200, body: { items: [{ id: "b", name: "b" }], nextCursor: null } }
      : { status: 200, body: { items: [{ id: "a", name: "a" }], nextCursor: "p2" } },
  );
  const c = daytonaRest({ apiKey: "k", apiUrl: "https://api.test/api", fetch: f });
  assert.deepEqual((await c.list({ [LABEL_FLEET]: "p9" })).map((b) => b.id), ["a", "b"]);
  assert.deepEqual(JSON.parse(seen[0].url.searchParams.get("labels")!), { [LABEL_FLEET]: "p9" });
  assert.equal(seen.length, 2);
});

test("REST: toolbox calls go to the box's proxy (looked up once when the box does not carry it); upload is multipart to upload-v2 with the path", async () => {
  const { f, seen } = fakeFetch((url) => {
    if (url.pathname === "/api/sandbox/sb-1/toolbox-proxy-url") return { status: 200, body: { url: "https://proxy.test/toolbox/" } };
    if (url.pathname === "/toolbox/sb-1/process/execute") return { status: 200, body: { exitCode: 0, result: "ok\n" } };
    if (url.pathname === "/toolbox/sb-1/files/upload-v2") return { status: 200 };
    return { status: 500 };
  });
  const c = daytonaRest({ apiKey: "k", apiUrl: "https://api.test/api", fetch: f });
  const box = { id: "sb-1", name: "n" };
  assert.deepEqual(await c.exec(box, "echo ok", 10), { exitCode: 0, result: "ok\n" });
  assert.deepEqual(JSON.parse(String(seen[1].body)), { command: "echo ok", timeout: 10 });
  await c.exec(box, "true", 5);
  assert.equal(seen.filter((s) => s.url.pathname.endsWith("toolbox-proxy-url")).length, 1, "the proxy URL is cached");
  await c.upload(box, "/run/pda/x.token", new TextEncoder().encode(TOKEN));
  const up = seen.at(-1)!;
  assert.equal(up.url.searchParams.get("path"), "/run/pda/x.token");
  const file = (up.body as FormData).get("file") as Blob;
  assert.equal(await file.text(), TOKEN);
  await c.exec({ id: "sb-2", name: "m", toolboxProxyUrl: "https://elsewhere.test/tb" }, "true", 1).catch(() => {});
  assert.equal(seen.at(-1)!.url.href, "https://elsewhere.test/tb/sb-2/process/execute");
});

test("REST: failures are typed with status and retryability; messages carry the path and status, never the key or a body sent", async () => {
  const KEY = "dtn_secret_key_value";
  let mode: "503" | "400" | "net" | "429" = "503";
  const { f } = fakeFetch(() =>
    mode === "net" ? new TypeError("fetch failed")
    : { status: Number(mode), body: { message: "nope" } },
  );
  const c = daytonaRest({ apiKey: KEY, apiUrl: "https://api.test/api", fetch: f });
  const box = { id: "sb-1", name: "n", toolboxProxyUrl: "https://proxy.test/tb" };
  const check = async (status: number | null, retryable: boolean) => {
    const err = await c.upload(box, "/run/pda/x.token", new TextEncoder().encode(TOKEN)).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof DaytonaApiError);
    assert.equal(err.status, status);
    assert.equal(err.retryable, retryable);
    assert.equal(err.code, "DAYTONA_API_FAILED");
    assert.ok(!err.message.includes(KEY) && !err.message.includes(TOKEN), err.message);
    assert.match(err.message, /POST \/tb\/sb-1\/files\/upload-v2/);
  };
  await check(503, true);
  mode = "429";
  await check(429, true);
  mode = "400";
  await check(400, false);
  mode = "net";
  await check(null, true);
});
