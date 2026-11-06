// What a run's Docker box mounts of the agent's disk, with a fake `docker` first on PATH (fixtures/fake-docker.mjs; no
// daemon is reached): exactly its run's work/ (`disk/agents/<key>/runs/<run>/work`), read-write, at /workspace; never
// another run's folder, the agent's learning, the run's store or the server's store.sqlite. A box carries the epoch of
// the run's claim its process holds (agentrun.epoch): a later process destroys every box of the run of an earlier epoch
// before it makes its own, never takes one over, and its model is told once that the box was replaced.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BOX_REPLACED_NOTE, EPOCH_LABEL, fenceRunBoxes, RUN_LABEL } from "../dist/run-box.js";
import { follow, jsonLines, runDir, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const IMAGE = "debian:bookworm-slim";
const SANDBOX = { mode: "sandbox", box: "docker" };
/** The note a run's model gets once its box was replaced, written out: the words are the contract. */
const NOTE = "this run's box was replaced after a restart: /workspace is kept; packages installed outside it and /tmp are gone; reinstall what you need";

/** A fake docker first on PATH, docker listed with an image it has, and no network list (no egress mount). */
async function fakeDocker(t) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(join(state, "containers"), { recursive: true });
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: IMAGE, AGENTRUN_BOX_ALLOW: "none" });
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const argv = () => jsonLines(join(state, "argv.jsonl"));
  return { state, runs: () => argv().filter((args) => args[0] === "run"), removed: () => argv().filter((args) => args[0] === "rm").map((args) => args.at(-1)), argv };
}

/** A sandbox run of the probe agent `agent`, its plan's steps one per turn. */
async function boxedRun(api, plan, agent = "boxed") {
  const made = await api("POST", "/agents", { definition: { id: agent, name: agent, instructions: "Probe.", place: SANDBOX, tools: ["bash"] } });
  assert.ok([201, 409].includes(made.status), JSON.stringify(made.body));
  const run = await api("POST", `/agents/${agent}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** The run's tool results, as its store holds them: each one's tool and text. */
function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("\n") }));
  } finally {
    db.close();
  }
}

/** The run's claim epoch, as its row holds it. */
function epochOf(data, runId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT claim_epoch FROM runs WHERE id = ?").get(runId)?.claim_epoch;
  } finally {
    db.close();
  }
}

const flags = (args, name) => args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));
const labelsOf = (args) => Object.fromEntries(flags(args, "--label").map((label) => [label.slice(0, label.indexOf("=")), label.slice(label.indexOf("=") + 1)]));
const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A file to hold a run's step on, made by the test (or at its end, so nothing waits on past it). */
async function holdFile(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "box-mounts-hold-"));
  const hold = join(dir, "hold");
  t.after(async () => {
    await writeFile(hold, "");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(dir, { recursive: true, force: true });
  });
  return { hold, release: () => writeFile(hold, "") };
}

/** A box an earlier process of the run left, as the fake daemon keeps it: running, with `labels` beside the run's. */
async function plantBox(docker, runId, id, labels, mounts = []) {
  const all = { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: "/workspace", isolation: "container" }), [RUN_LABEL]: runId, "agentrun.box": "run", ...labels };
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: all }, HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] }, env: ["LANG=C.UTF-8", "HOME=/tmp"], mounts, workdir: "/workspace" }));
}

test("a run's Docker box mounts exactly its run's work/ on the agent's disk, read-write, at /workspace: not the data root, the agent's folder, its runs, its learning, the run's store or store.sqlite", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf one > a.txt" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const root = realpathSync(data);
  const folder = runDir(root, runId);
  const work = join(folder, "work");
  assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "one", "the box's write is in the run's work/");
  const [run] = docker.runs();
  assert.deepEqual(flags(run, "--mount"), [`type=bind,source=${work},target=/workspace`]);
  assert.deepEqual(flags(run, "--workdir"), ["/workspace"]);
  // Nothing the box gets is, or holds, anything but the run's work/.
  const agentFolder = join(folder, "..", "..");
  assert.match(relative(root, agentFolder), /^disk\/agents\/[^/]+$/);
  for (const source of flags(run, "--mount").map((mount) => /source=([^,]+)/.exec(mount)[1])) {
    for (const outside of [root, join(root, "disk"), agentFolder, join(agentFolder, "runs"), join(agentFolder, "learning"), folder, join(folder, "store"), join(folder, "store", "run.sqlite"), join(root, "store.sqlite")]) {
      assert.ok(source !== outside && !outside.startsWith(`${source}${sep}`), `${source} is not ${outside}, nor holds it`);
    }
  }
  // Labelled with the epoch its process held: a positive whole number, no later than the run's last (its end bumps it).
  const label = Number(labelsOf(run)[EPOCH_LABEL]);
  assert.ok(Number.isSafeInteger(label) && label >= 1 && label <= epochOf(root, runId), `epoch label ${labelsOf(run)[EPOCH_LABEL]}`);
});

test("two runs of one agent: each box gets its own run's folder, and the second's sees none of the first's files", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const first = await boxedRun(api, [{ tool: "bash", args: { command: "printf secret > first-only.txt" } }]);
  await follow(api, first, ["completed"], { deadlineMs: 60_000 });
  const second = await boxedRun(api, [{ tool: "bash", args: { command: "ls -a /workspace; cat /workspace/first-only.txt 2>&1 || true" } }]);
  await follow(api, second, ["completed"], { deadlineMs: 60_000 });
  const root = realpathSync(data);
  const [one, two] = docker.runs();
  assert.deepEqual(flags(one, "--mount"), [`type=bind,source=${join(runDir(root, first), "work")},target=/workspace`]);
  assert.deepEqual(flags(two, "--mount"), [`type=bind,source=${join(runDir(root, second), "work")},target=/workspace`]);
  assert.ok(!two.some((arg) => arg.includes(first)), "the second box's docker run names nothing of the first run's");
  const [seen] = answers(root, second);
  assert.ok(!seen.text.includes("secret"), seen.text);
  assert.match(seen.text, /No such file/);
  assert.equal(readFileSync(join(runDir(root, first), "work", "first-only.txt"), "utf8"), "secret");
});

test("a box of an earlier epoch (or of none: made before boxes had one) is destroyed before the run's process makes its own, never taken over; the new one carries the run's epoch", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const go = await holdFile(t);
  const runId = await boxedRun(api, [{ wait: go.hold }, { tool: "bash", args: { command: "printf made > b.txt" } }]);
  const root = realpathSync(data);
  await until(() => epochOf(root, runId) >= 1, "the run's claim");
  const epoch = epochOf(root, runId);
  const unlabelled = "b".repeat(64);
  const earlier = "c".repeat(64);
  await plantBox(docker, runId, unlabelled, {});
  await plantBox(docker, runId, earlier, { [EPOCH_LABEL]: String(epoch - 1) });
  await go.release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const argv = docker.argv();
  const made = argv.findIndex((args) => args[0] === "run");
  assert.ok(made > 0, "a box was made");
  for (const id of [unlabelled, earlier]) {
    const gone = argv.findIndex((args) => args[0] === "rm" && args.at(-1) === id);
    assert.ok(gone >= 0 && gone < made, `${id.slice(0, 4)}… destroyed before the box was made`);
    assert.ok(!argv.some((args) => args[0] === "exec" && args.includes(id)), `${id.slice(0, 4)}… never ran a command`);
  }
  assert.equal(labelsOf(argv[made])[EPOCH_LABEL], String(epoch));
  assert.equal(readFileSync(join(runDir(root, runId), "work", "b.txt"), "utf8"), "made");
  // Its model is told once that its box was replaced.
  const said = answers(root, runId);
  assert.equal(said.filter((answer) => answer.text.includes(NOTE)).length, 1, JSON.stringify(said));
  assert.ok(said[0].text.startsWith(NOTE), said[0].text);
});

test("a relaunch after its process died: the old box is destroyed, the next call runs in a new box under the bumped epoch, and that call's answer alone starts with the note, exactly", { timeout: 180_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const go = await holdFile(t);
  const runId = await boxedRun(api, [
    { tool: "bash", args: { command: `printf before > before.txt; until [ -e ${go.hold} ]; do sleep 0.1; done` } },
    { tool: "bash", args: { command: "printf after > after.txt" } },
    { tool: "bash", args: { command: "printf again > again.txt" } },
  ]);
  const root = realpathSync(data);
  const folder = runDir(root, runId);
  await until(() => existsSync(join(folder, "work", "before.txt")), "the first call in the first box");
  const first = epochOf(root, runId);
  const [old] = docker.runs();
  assert.equal(labelsOf(old)[EPOCH_LABEL], String(first));
  // The first box, by its epoch label in the fake daemon's record, while it runs.
  const [oldId] = readdirSync(join(docker.state, "containers")).map((name) => JSON.parse(readFileSync(join(docker.state, "containers", name), "utf8"))).filter((c) => c.Config?.Labels?.[EPOCH_LABEL] === String(first)).map((c) => c.Id);
  assert.ok(oldId, "the first box is up");
  // The run's process dies; the server opens the run again under a later epoch.
  const pid = processOf(folder);
  assert.ok(pid, "the run's process");
  process.kill(pid, "SIGKILL");
  await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  const runs = docker.runs();
  assert.equal(runs.length, 2, "one box made again");
  assert.ok(Number(labelsOf(runs[1])[EPOCH_LABEL]) > first, "under the relaunch's later epoch");
  const argv = docker.argv();
  const removedAt = argv.findIndex((args) => args[0] === "rm" && args.at(-1) === oldId);
  const madeAgainAt = argv.findLastIndex((args) => args[0] === "run");
  assert.ok(removedAt >= 0 && removedAt < madeAgainAt, "the old box was destroyed before the new one was made");
  assert.equal(readFileSync(join(folder, "work", "after.txt"), "utf8"), "after", "/workspace kept");
  const said = answers(root, runId);
  const told = said.filter((answer) => answer.text.includes(NOTE));
  assert.equal(told.length, 1, JSON.stringify(said));
  assert.ok(told[0].text.startsWith(NOTE), told[0].text);
  assert.ok(!said.at(-1).text.includes(NOTE), "the call after it is told nothing");
});

test("a box of the process's own epoch is taken over, not destroyed, and its model is told nothing", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const go = await holdFile(t);
  const runId = await boxedRun(api, [{ wait: go.hold }, { tool: "bash", args: { command: "printf kept > k.txt" } }]);
  const root = realpathSync(data);
  await until(() => epochOf(root, runId) >= 1, "the run's claim");
  const id = "d".repeat(64);
  await plantBox(docker, runId, id, { [EPOCH_LABEL]: String(epochOf(root, runId)) }, [{ source: join(runDir(root, runId), "work"), target: "/workspace" }]);
  await go.release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(docker.runs(), [], "no box made");
  // Its command ran in it, and it went only after, at the run's end (every box does).
  const argv = docker.argv();
  const ran = argv.findLastIndex((args) => args[0] === "exec" && args.includes(id));
  const gone = argv.findIndex((args) => args[0] === "rm" && args.at(-1) === id);
  assert.ok(ran >= 0 && (gone === -1 || gone > ran), `its command ran there before any removal (exec ${ran}, rm ${gone})`);
  assert.equal(readFileSync(join(runDir(root, runId), "work", "k.txt"), "utf8"), "kept");
  assert.ok(!answers(root, runId).some((answer) => answer.text.includes(NOTE)));
});

test("fenceRunBoxes: lower epochs and none go, the same stays, and a later one means this process holds the run no more: it throws and destroys nothing", async () => {
  const boxes = (list) => {
    const destroyed = [];
    return {
      destroyed,
      list: async (labels) => ({ ok: true, value: list.filter((ref) => ref.labels[RUN_LABEL] === labels[RUN_LABEL]) }),
      attach: async (id) => ({ ok: true, value: { id, destroy: async () => (destroyed.push(id), { ok: true, value: undefined }) } }),
    };
  };
  const ref = (id, epoch) => ({ id, labels: { [RUN_LABEL]: "r", ...(epoch === undefined ? {} : { [EPOCH_LABEL]: String(epoch) }) } });
  const some = boxes([ref("none"), ref("one", 1), ref("two", 2), ref("other-run", 1)].map((r) => (r.id === "other-run" ? { ...r, labels: { ...r.labels, [RUN_LABEL]: "s" } } : r)));
  assert.equal(await fenceRunBoxes(some, { id: "r", epoch: 2 }, {}), 2);
  assert.deepEqual(some.destroyed.sort(), ["none", "one"]);
  const later = boxes([ref("one", 1), ref("three", 3)]);
  await assert.rejects(fenceRunBoxes(later, { id: "r", epoch: 2 }, {}), /later launch's \(epoch 3, this process's 2\)/);
  assert.deepEqual(later.destroyed, []);
});

/** The pid of the process running the run in `dir`, found by its command line (`run --dir <dir>`). */
function processOf(dir) {
  const lines = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n");
  const pids = lines.filter((line) => line.includes(" run --dir ") && line.includes(`--dir ${dir} `)).map((line) => Number(line.trim().split(/\s+/)[0]));
  return pids.length === 1 ? pids[0] : undefined;
}

test("the note goes before both of an answer's model fields, content and output (pi 1.2 reads output), once: a background tool's answer carries it too", async () => {
  const { withBoxNote } = await import("../dist/coding-tools.js");
  let told = false;
  const box = { replaced: () => (told ? undefined : ((told = true), NOTE)) };
  const blocks = [{ type: "text", text: "No background processes." }];
  const seen = [];
  const first = await withBoxNote(box, (chunk) => seen.push(chunk), async () => ({ content: blocks, output: blocks, details: { n: 0 } }));
  assert.deepEqual(first.content.map((b) => b.text), [NOTE, "No background processes."]);
  assert.deepEqual(first.output.map((b) => b.text), [NOTE, "No background processes."]);
  assert.deepEqual(first.details, { n: 0 });
  assert.deepEqual(seen, [`${NOTE}\n`], "and in the output stream, for an answer that gives neither");
  const second = await withBoxNote(box, () => {}, async () => ({ content: blocks, output: blocks }));
  assert.deepEqual(second.output.map((b) => b.text), ["No background processes."], "told once");
});
