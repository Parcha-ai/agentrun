// What a boxed Claude run needs to resume, on serve's side: a temporary directory of each launch's own in the run's
// harness directory (box/launch-tmp.ts), the box lent only that spawn's own directories from it (run-box.ts's
// bindsChecked), the session's sockets kept short outside it, one boxed Claude session per run process, and no reader
// of the run's files reaching any of it. No model and no real box: the box here is a recording stand-in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLocalMachine } from "@parcha/agentrun-kernel/host";
import { oneBoxedClaude } from "../dist/app.js";
import { bootId, newLaunchDir, ownLaunchDir, PROC_TMP, provenGone } from "../dist/box/launch-tmp.js";
import { bindsChecked, runBox } from "../dist/box/run-box.js";
import { startTimeOf } from "../dist/box/sweep.js";
import { agent, follow, serve } from "./support.mjs";

const scratch = (t, name) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `claude-resume-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const linux = { skip: process.platform !== "linux" && "reads /proc" };

/** A process that runs until killed, and its exit. */
function sleeper(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  return { child, exited, ready: new Promise((resolve) => child.once("spawn", resolve)) };
}

test("each launch gets a new 0700 directory of its own; one whose process still runs is kept, a new launch beside it", linux, async (t) => {
  const run = join(scratch(t, "alive"), "runs", "r1");
  mkdirSync(join(run, "harness"), { recursive: true, mode: 0o700 });
  const live = sleeper(t);
  await live.ready;
  const first = newLaunchDir(run);
  ownLaunchDir(first, live.child.pid);
  writeFileSync(join(first, "dh-claude-x"), "the first launch's");
  const second = newLaunchDir(run);
  assert.notEqual(second, first, "a launch never shares an earlier one's directory");
  assert.equal(join(second, ".."), join(run, "harness", PROC_TMP), "each launch's directory is directly under proc-tmp");
  assert.match(second.slice(second.lastIndexOf("/") + 1), /^[0-9a-f]{6}$/, "and short");
  assert.ok(existsSync(join(first, "dh-claude-x")), "the earlier launch's directory, its process alive, is kept whole");
});

test("an earlier launch's directory is removed once its process is proven gone, by boot id and start ticks; unknown is kept", linux, async (t) => {
  const run = join(scratch(t, "gone"), "runs", "r1");
  mkdirSync(join(run, "harness"), { recursive: true, mode: 0o700 });
  const ended = sleeper(t);
  await ended.ready;
  const gone = newLaunchDir(run);
  ownLaunchDir(gone, ended.child.pid);
  ended.child.kill("SIGKILL");
  await ended.exited;
  const unknown = newLaunchDir(run);
  writeFileSync(join(unknown, ".owner.json"), "not json");
  const unrecorded = newLaunchDir(run);
  newLaunchDir(run);
  assert.equal(existsSync(gone), false, "its process is gone: removed");
  assert.ok(existsSync(unknown) && existsSync(unrecorded), "an unreadable or missing record is unknown: kept");
  // The proof itself: another boot is gone; this boot, the same pid with other start ticks, is gone; unreadable is not.
  const owner = { pid: process.pid, startTicks: startTimeOf(process.pid), bootId: bootId() };
  assert.equal(provenGone(owner), false, "this process, alive");
  assert.equal(provenGone({ ...owner, bootId: "another-boot" }), true);
  assert.equal(provenGone({ ...owner, startTicks: "1" }), true, "a reused pid");
  assert.equal(provenGone(owner, { bootId: undefined }), false, "a boot that cannot be read proves nothing");
  assert.equal(provenGone({ ...owner, startTicks: "" }), false);
});

test("proc-tmp is outside every reader: not in the run's files, not readable by any path, and no pack holds it", async (t) => {
  const { api, data, baseUrl, token } = await serve(t, { fauxHarness: new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("boxed", { harness: "claude-agent", instructions: "Answer the question.", tools: [] }))).status, 201);
  const runId = (await api("POST", "/agents/boxed/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"]);
  const run = join(data, "runs", runId);
  const launch = newLaunchDir(run);
  writeFileSync(join(launch, "secret.txt"), "a browser profile's cookie");
  writeFileSync(join(run, "harness", "work", "mine.txt"), "the run's");
  assert.deepEqual((await api("GET", `/runs/${runId}/files`)).body.files.map((f) => f.path), ["mine.txt"], "the walk reads the workspace only");
  for (const path of [`${PROC_TMP}/secret.txt`, `..%2F${PROC_TMP}%2F${launch.slice(launch.lastIndexOf("/") + 1)}%2Fsecret.txt`, `../${PROC_TMP}/secret.txt`]) {
    const res = await fetch(`${baseUrl}/runs/${runId}/files/${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.ok([400, 403, 404].includes(res.status), `${path}: ${res.status}`);
    assert.doesNotMatch(await res.text(), /cookie/);
  }
  assert.equal((await api("GET", "/agents/boxed/home")).status, 501, "serve exports no home, so no pack can hold it");
});

/** A box that records what it is asked to start. */
const recordingBox = () => {
  const started = [];
  return { started, box: { isolation: { mode: "bwrap", cgroup: false }, start: (spec) => (started.push(spec), { record: {} }), reap: async () => ({ empty: true, left: 0, by: "pidns" }) } };
};

test("a child's binds must be real directories directly under this launch's temporary directory, checked before the box starts", async (t) => {
  const root = scratch(t, "binds");
  const launch = join(root, "harness", PROC_TMP, "abc123");
  mkdirSync(launch, { recursive: true });
  const own = join(launch, "dh-claude-1");
  mkdirSync(own);
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(launch, "claude-resume-link"));
  mkdirSync(join(own, "nested"));
  const { started, box } = recordingBox();
  const checked = bindsChecked(box, () => launch);
  const spec = (bind) => ({ homes: { HOME: join(root, "harness", "home"), "bind:0": bind } });
  checked.start(spec(own), {}, {});
  assert.equal(started.length, 1, "its own directory, directly under the launch's: started");
  for (const [bind, why] of [[join(launch, "claude-resume-link"), "a link"], [join(launch, "missing"), "missing"], [join(own, "nested"), "nested deeper"], [elsewhere, "outside it"], [launch, "the launch's directory itself"]]) {
    assert.throws(() => checked.start(spec(bind), {}, {}), (error) => error.code === "box_refused" && error.message === `this run's box is refused: a child's bind ${bind} is not a directory directly under this launch's temporary directory ${launch} (a link, missing, or elsewhere)`, why);
  }
  assert.equal(started.length, 1, "nothing refused reached the box");
});

/** An adapter whose sessions record their close. */
const adapter = () => ({ check: () => [], open: async () => ({ state: "idle", closed: false, async close() { this.closed = true; } }) });

test("one boxed Claude session per run process: a second at once, through the same adapter or a second open's, is refused by name; its close frees it", async () => {
  const first = oneBoxedClaude(adapter());
  const session = await first.open({ key: "run:a" }, {});
  await assert.rejects(first.open({ key: "run:b" }, {}), (error) => error.code === "box_refused" && error.message === "this run's box is refused: a second boxed Claude session (run:b) in one run process while run:a is live: one run process holds one");
  // A second open of the run (pi-durable-disk's onOpen again) makes its adapter afresh: refused the same way.
  await assert.rejects(oneBoxedClaude(adapter()).open({ key: "run:a" }, {}), /a second boxed Claude session \(run:a\) in one run process while run:a is live/);
  assert.equal(session.state, "idle", "the session reads through");
  await session.close();
  const again = await oneBoxedClaude(adapter()).open({ key: "run:c" }, {});
  await again.close();
});

test("the session's sockets are short and outside the launch's directory, under the default data root in a home: the machine opens; its own default there is runtime_dir_too_long", linux, async (t) => {
  const home = scratch(t, "home");
  const data = join(home, ".local", "share", "agentrun", "agents");
  const run = join(data, "runs", "01a18d39-80ec-7db0-b1a7-9f75bd7b8a06");
  mkdirSync(join(run, "harness"), { recursive: true, mode: 0o700 });
  const launch = newLaunchDir(run);
  const serveTmp = mkdtempSync(join("/tmp", "agentrun-srv-"));
  t.after(() => rmSync(serveTmp, { recursive: true, force: true }));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = launch;
  t.after(() => (saved === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = saved)));
  const made = await runBox({ data, isolation: { mode: "bwrap", cgroup: false }, runtimeDir: serveTmp }, { id: "r", dir: run }, {});
  const policy = { id: "test", routes: [{ method: "POST", path: "/v1/test" }], keyOf: (h) => String(h.authorization ?? ""), authHeaders: (c) => ({ authorization: c }), apply: (b) => b, usageOf: () => undefined };
  const open = () => openLocalMachine({ name: "agentrun-test", dir: join(run, "harness"), dirs: ["home", "tmp"], sessionId: "s", from: { PATH: process.env.PATH }, proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: "m", origin: "https://provider.invalid", credential: () => "c" }, box: made });
  const machine = await open().catch((error) => assert.fail(`the machine with the run's box did not open: ${error.message}`));
  await machine.close();
  assert.ok(made.runtimeDir.startsWith(serveTmp) && Buffer.byteLength(made.runtimeDir) <= 81, `${made.runtimeDir}: under serve's own temporary directory, and short`);
  await assert.rejects(openLocalMachine({ name: "agentrun-test", dir: join(run, "harness"), dirs: ["home", "tmp"], sessionId: "s", from: {}, proxy: { policy, hooks: {}, model: "m", origin: "https://provider.invalid", credential: () => "c" }, box: { ...made, runtimeDir: undefined } }), /runtime_dir_too_long/, "the machine's default, in the launch's directory, is too long for a socket");
  assert.deepEqual(readdirSync(launch), [], "nothing of the machine's in the launch's directory");
});
