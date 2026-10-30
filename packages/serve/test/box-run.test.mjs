// The box a run's own process builds for its harness (box/run-box.ts), from the settings serve hands it at launch, and
// the one place serve decides whether a run gets its harness's own tools (native-tools.ts). The real-box half needs a
// bwrap that can make a user namespace: without one it skips, naming the probe's answer, unless AGENTRUN_BOX_REAL=1
// (the CI job that installs it) makes it fail.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BOX_FORWARD, boxListens, buildBoxArgv, checkBoxArgv, forwardChild, probeBox } from "@parcha/agentrun-kernel/host";
import { checkUnderData, hiddenFor, RUN_BOX_ENV, runBox, runBoxOf } from "../dist/box/run-box.js";
import { nativeTools, UNSANDBOXED_NATIVE_TOOLS } from "../dist/native-tools.js";
import { agent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const REQUIRED = process.env.AGENTRUN_BOX_REAL === "1";
const probed = await (async () => {
  const scratch = mkdtempSync(join(tmpdir(), "serve-box-probe-"));
  try {
    return await probeBox({ scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();
const skip = probed.mode === "bwrap" ? false : REQUIRED ? false : `no usable bwrap here: ${JSON.stringify(probed)}`;

/** A data root as serve keeps one: its token files and store, and two runs, each with its own journal, log, records and
 *  the harness directory it is lent (harness/work its workspace, harness/home a home). */
function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "serve-box-run-"));
  const data = join(root, "agents");
  mkdirSync(data);
  for (const [name, text] of [[".token", "the server's token"], [".door-token", "the door's token"], ["store.sqlite", "the agent store"]]) writeFileSync(join(data, name), text);
  const runs = {};
  for (const id of ["run-a", "run-b"]) {
    const dir = join(data, "runs", id);
    mkdirSync(join(dir, "store"), { recursive: true });
    mkdirSync(join(dir, "harness", "work"), { recursive: true });
    mkdirSync(join(dir, "harness", "home"), { recursive: true });
    writeFileSync(join(dir, "store", "run.sqlite"), `${id}'s journal`);
    for (const name of ["process.log", "box.json", "serve.json"]) writeFileSync(join(dir, name), `${id}'s ${name}`);
    writeFileSync(join(dir, "harness", "work", "mine.txt"), `${id}'s file`);
    runs[id] = { id, dir };
  }
  const sockets = mkdtempSync(join(tmpdir(), "serve-box-sock-"));
  const modelSocket = join(sockets, "model.sock");
  writeFileSync(modelSocket, "");
  /** The spec the machine builds for a run lent `<run>/harness` (machine.ts): its workspace, a home, node, the forwarder. */
  const spec = (run, extra = {}) => ({
    session: join(run.dir, "harness"),
    workspace: join(run.dir, "harness", "work"),
    homes: { HOME: join(run.dir, "harness", "home") },
    readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD],
    modelSocket,
    modelPort: 8123,
    env: { PATH: "/usr/bin:/bin" },
    ...extra,
  });
  return { data, runs, spec, remove: () => (rmSync(root, { recursive: true, force: true }), rmSync(sockets, { recursive: true, force: true })) };
}

test("native tools: only claude-agent, only in a box whose probe passed, only on a run whose workspace is its harness's; unsandboxed keeps them off", () => {
  assert.equal(UNSANDBOXED_NATIVE_TOOLS, false);
  const table = [];
  for (const harness of ["pi", "claude-agent", "codex"]) for (const mode of [undefined, "bwrap", "seatbelt", "provider", "unsandboxed", "unavailable"]) if (nativeTools(harness, mode)) table.push(`${harness}:${mode}`);
  assert.deepEqual(table, ["claude-agent:bwrap", "claude-agent:seatbelt", "claude-agent:provider"]);
  assert.equal(nativeTools("claude-agent", "bwrap", "work"), false, "a run on work/ keeps them off: its harness's tools would write a second tree");
});

test("the launch settings are read strictly: none is no box; no data root, a relative one, or a malformed value is refused by name", () => {
  assert.equal(runBoxOf({}), undefined);
  const isolation = { mode: "bwrap", cgroup: false };
  assert.deepEqual(runBoxOf({ [RUN_BOX_ENV]: JSON.stringify({ data: "/var/lib/agentrun/agents", isolation }) }), { data: "/var/lib/agentrun/agents", isolation });
  for (const [value, why] of [
    [JSON.stringify({ isolation }), /this run's box is refused: serve gave it no data root \(an absolute path\), so nothing of the server's would be hidden from it/],
    [JSON.stringify({ data: "data", isolation }), /gave it no data root/],
    [JSON.stringify({ data: "/var/lib/agentrun/agents" }), /names no isolation/],
    ["{", /is not JSON/],
    [JSON.stringify({ data: "/var/lib/agentrun/agents", isolation, cgroupRoot: "rel" }), /cgroup root is not an absolute path/],
  ]) assert.throws(() => runBoxOf({ [RUN_BOX_ENV]: value }), (error) => error.code === "box_refused" && why.test(error.message), value);
});

test("a run whose own directory is not under the data root it was handed builds no box, by name, through a link too", async () => {
  const d = dataRoot();
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), "serve-box-else-"));
    const linked = join(d.data, "runs", "linked");
    symlinkSync(elsewhere, linked);
    try {
      assert.doesNotThrow(() => checkUnderData(d.data, d.runs["run-a"].dir));
      for (const dir of [elsewhere, linked]) {
        assert.throws(() => checkUnderData(d.data, dir), /this run's box is refused: its own directory .* is not under the data root .* it was handed/);
        await assert.rejects(runBox({ data: d.data, isolation: { mode: "bwrap", cgroup: false } }, { id: "x", dir }, {}), /is not under the data root/);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    d.remove();
  }
});

test("each run's hidden list holds the data root and its own journal and log, never another run's; its argv refuses its own store, and a session at its run's directory", () => {
  const d = dataRoot();
  try {
    const a = d.runs["run-a"];
    const b = d.runs["run-b"];
    assert.deepEqual(hiddenFor(d.data, a.dir, {}), [d.data, join(a.dir, "store"), join(a.dir, "process.log")]);
    assert.deepEqual(hiddenFor(d.data, b.dir, {}), [d.data, join(b.dir, "store"), join(b.dir, "process.log")]);
    assert.deepEqual(hiddenFor(d.data, a.dir, { CLAUDE_CONFIG_DIR: "/opt/claude-config", CODEX_HOME: "relative" }).slice(3), ["/opt/claude-config"], "a credential directory the operator named, absolute");
    const check = (spec, hidden) => checkBoxArgv(buildBoxArgv(spec, forwardChild({ command: "/bin/true", args: [] }, boxListens(spec))), spec, { hidden });
    assert.doesNotThrow(() => check(d.spec(a), hiddenFor(d.data, a.dir, {})), "its own session binds");
    assert.throws(() => check(d.spec(a, { homes: { HOME: join(a.dir, "store") } }), hiddenFor(d.data, a.dir, {})), (error) => error.code === "box_refused" && error.message.includes(join(a.dir, "store")), "a home at its own store");
    assert.throws(() => check(d.spec(a, { session: a.dir, workspace: join(a.dir, "harness", "work") }), hiddenFor(d.data, a.dir, {})), (error) => error.code === "box_refused" && /the session .* is or holds .*store, which a box never sees/.test(error.message), "a session at the run's own directory holds its store");
    mkdirSync(join(d.data, "shared"));
    assert.throws(() => check(d.spec(a, { readOnly: [...d.spec(a).readOnly, join(d.data, "shared")] }), hiddenFor(d.data, a.dir, {})), (error) => error.code === "box_refused" && /a read-only path .*agents\/shared is under .*agents, where a run's files live/.test(error.message), "a read-only source under the data root");
  } finally {
    d.remove();
  }
});

test("the box the run's process builds refuses, before anything starts, a home at its own store, a session at its own directory and a read-only source under the data root", async () => {
  const d = dataRoot();
  try {
    const a = d.runs["run-a"];
    const made = await runBox({ data: d.data, isolation: { mode: "bwrap", cgroup: false } }, a, {});
    mkdirSync(join(d.data, "shared"));
    const recorded = [];
    const start = (spec) => made.box.start(spec, forwardChild({ command: "/bin/true", args: [] }, boxListens(spec)), { ahead: (r) => recorded.push(r), started: async () => {} });
    for (const [spec, why] of [
      [d.spec(a, { homes: { HOME: join(a.dir, "store") } }), /store/],
      [d.spec(a, { session: a.dir }), /the session .* is or holds .*store, which a box never sees/],
      [d.spec(a, { readOnly: [...d.spec(a).readOnly, join(d.data, "shared")] }), /a read-only path .*agents\/shared is under .*agents, where a run's files live/],
    ]) assert.throws(() => start(spec), (error) => error.code === "box_refused" && why.test(error.message));
    assert.deepEqual(recorded, [], "nothing was recorded: no box was started");
  } finally {
    d.remove();
  }
});

test("in the run's real box: its own workspace reads and writes; the server's tokens and store, another run's work, and its own journal, log, box.json and serve.json are not there", { skip }, async () => {
  const d = dataRoot();
  try {
    const a = d.runs["run-a"];
    const made = await runBox({ data: d.data, isolation: probed }, a, {});
    const spec = d.spec(a);
    const absent = [join(d.data, ".token"), join(d.data, ".door-token"), join(d.data, "store.sqlite"), join(d.runs["run-b"].dir, "harness", "work", "mine.txt"), join(a.dir, "store", "run.sqlite"), join(a.dir, "process.log"), join(a.dir, "box.json"), join(a.dir, "serve.json")];
    const script = [
      `echo written > '${join(spec.workspace, "new.txt")}' && cat '${join(spec.workspace, "new.txt")}'`,
      `cat '${join(spec.workspace, "mine.txt")}'; echo`,
      ...absent.map((path) => `cat '${path}' 2>&1; echo`),
      // A write to either lands, if at all, in the box's own scratch for the path to its session: never on the host.
      `echo forged > '${join(a.dir, "box.json")}' 2>/dev/null; true`,
      `echo forged > '${join(a.dir, "process.log")}' 2>/dev/null; true`,
    ].join("; ");
    const recorded = [];
    const boxed = made.box.start(spec, forwardChild({ command: "/bin/sh", args: ["-c", script] }, boxListens(spec)), { ahead: (r) => recorded.push(r), started: async () => {} });
    let out = "";
    boxed.child.stdout.on("data", (chunk) => (out += chunk));
    await boxed.ready.catch((error) => assert.fail(`the box did not start: ${error.message}; bwrap said: ${boxed.stderrTail()}`));
    await boxed.exited;
    assert.match(out, /^written$/m, out);
    assert.match(out, /^run-a's file$/m, out);
    for (const path of absent) assert.match(out, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: No such file or directory`), `${path} is not in the box: ${out}`);
    assert.doesNotMatch(out, /the server's token|the door's token|the agent store|run-b's file|run-a's journal|run-a's process\.log|run-a's box\.json|run-a's serve\.json/, out);
    assert.equal(await readFile(join(a.dir, "box.json"), "utf8"), "run-a's box.json", "box.json is never written from the box: a forged one would aim the sweep's reap");
    assert.equal(await readFile(join(a.dir, "process.log"), "utf8"), "run-a's process.log");
    await made.box.reap(boxed.record);
  } finally {
    d.remove();
  }
});

test("serve hands a harness run's process its box settings in one non-secret variable: its data root and what its probe proved; none when its box is unavailable", { timeout: 90_000 }, async (t) => {
  const boxed = { isolation: { mode: "bwrap", cgroup: false }, start() { throw new Error("not in this test"); }, reap: async () => ({ empty: true, left: 0, by: "none" }) };
  for (const [factory, expected] of [[async () => boxed, (data) => ({ data, isolation: { mode: "bwrap", cgroup: false } })], [undefined, () => undefined]]) {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, ...(factory ? { boxFactory: factory } : {}) });
    assert.equal((await api("POST", "/agents", agent("boxed", { harness: "claude-agent", instructions: `Wait for ${join(data, "never")} before the answer.`, tools: [] }))).status, 201);
    const run = await api("POST", "/agents/boxed/runs", { input: { content: "hi" } });
    const dir = join(data, "runs", run.body.run_id);
    let holder;
    for (let i = 0; !(holder = await readFile(join(dir, "run.json"), "utf8").then((text) => JSON.parse(text).holder, () => undefined)); i++) {
      assert.ok(i < 300, "the run's process is up");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const environ = Object.fromEntries((await readFile(`/proc/${holder.pid}/environ`, "utf8")).split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    assert.deepEqual(environ[RUN_BOX_ENV] === undefined ? undefined : JSON.parse(environ[RUN_BOX_ENV]), expected(data));
    const caps = (await api("GET", "/capabilities")).body;
    assert.deepEqual(caps.harnesses.map((h) => [h.id, h.native_tools]), [["pi", false], ["claude-agent", factory !== undefined], ["codex", false]], "capabilities say it from the same function");
    assert.equal((await api("POST", `/runs/${run.body.run_id}/cancel`)).status, 202);
    await follow(api, run.body.run_id, ["cancelled"], { deadlineMs: 30_000 });
  }
});
