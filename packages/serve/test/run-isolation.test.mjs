// What keeps one run's process from another's and from the server, as far as this host can show without the image's
// helper (image-custody.sh shows the rest, as the image's users): each slot a uid of its own in the helper's range, the
// isolation a host gives chosen and refused in words, the channel's store bound to the claim, a frame the channel never
// sends ending the run, and the store's files the server's alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { serialize } from "node:v8";
import { SECRET_NAMES } from "../dist/secrets.js";
import { Channel, ChannelClosed, MAX_FRAME } from "../dist/runner/run-channel.js";
import { FIRST_RUN_ID, RUN_SLOTS, RunIsolationRefused, runIsolationOf, slotId, Slots, storeCall } from "../dist/runner/run-child-host.js";
import { client, printed } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const BREAKER = new URL("./fixtures/faux-channel.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratchDir = (t, prefix) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------------------------------------------------
// Slots and the isolation a host gives.

test("every slot of a runner is a uid of its own in the helper's range, and a slot given back is the next one taken", () => {
  for (const [first, count] of [[0, RUN_SLOTS], [128, 128], [3, 5]]) {
    const slots = new Slots(first, count);
    const taken = Array.from({ length: count }, () => slots.take());
    const uids = taken.map(slotId);
    assert.equal(new Set(uids).size, count, `slots ${first}..${first + count - 1} share a uid: ${uids.join(" ")}`);
    assert.deepEqual([...taken].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => first + i), "a runner takes exactly its own slots");
    for (const uid of uids) assert.ok(uid >= FIRST_RUN_ID && uid < FIRST_RUN_ID + RUN_SLOTS, `uid ${uid} is outside the helper's ${FIRST_RUN_ID}-${FIRST_RUN_ID + RUN_SLOTS - 1}`);
    assert.throws(() => slots.take(), /every run slot of this runner is held/);
    slots.give(taken[1]);
    assert.equal(slots.take(), taken[1]);
  }
  // Two runners on one data directory, from first slots of their own (deploy/compose.yaml: 0 and 128), never share a uid.
  const one = new Slots(0, 15);
  const two = new Slots(128, 15);
  const ones = Array.from({ length: 15 }, () => slotId(one.take()));
  const twos = Array.from({ length: 15 }, () => slotId(two.take()));
  assert.deepEqual(ones.filter((uid) => twos.includes(uid)), []);
});

/** A stand-in helper whose `check` exits `code`, saying `said` on stderr. */
const helperOf = (t, code, said = "") => {
  const file = join(scratchDir(t, "runas-"), "agentrun-runas");
  writeFileSync(file, `#!/bin/sh\n[ "$1" = check ] || exit 2\nprintf '%s\\n' '${said}' >&2\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
};

test("a host gives uid isolation when the helper can switch, process isolation when it has none or is told same, and refuses in words naming the setting otherwise", async (t) => {
  const lines = [];
  const log = (line) => void lines.push(line);
  const able = helperOf(t, 0);
  assert.deepEqual(await runIsolationOf({}, 8, log, able), { kind: "uid", helper: able, first: 0, slots: 8 });
  assert.deepEqual(await runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "250" }, 8, log, able), { kind: "uid", helper: able, first: 250, slots: 6 });
  assert.match(lines.at(-1), /holds at most 6 runs at once/);
  assert.equal((await runIsolationOf({}, 8, log, join(scratchDir(t, "none-"), "agentrun-runas"))).kind, "process");
  assert.deepEqual(await runIsolationOf({ AGENTRUN_RUN_USER: "same" }, 8, log, able), { kind: "process", why: "AGENTRUN_RUN_USER=same" });
  assert.match(lines.at(-1), /AGENTRUN_RUN_USER=same: every run runs as this runner's own user/);
  const unable = helperOf(t, 1, "missing cap_setuid in the effective set");
  await assert.rejects(runIsolationOf({}, 8, log, unable), (error) => error instanceof RunIsolationRefused && /will not claim runs/.test(error.message) && /missing cap_setuid/.test(error.message) && /AGENTRUN_RUN_USER=same/.test(error.message) && /no-new-privileges/.test(error.message));
  await assert.rejects(runIsolationOf({ AGENTRUN_RUN_USER: "slot" }, 8, log, join(scratchDir(t, "none-"), "agentrun-runas")), (error) => error instanceof RunIsolationRefused && /AGENTRUN_RUN_USER=slot/.test(error.message));
  await assert.rejects(runIsolationOf({ AGENTRUN_RUN_USER: "root" }, 8, log, able), (error) => error instanceof RunIsolationRefused && /AGENTRUN_RUN_USER=root is not a setting/.test(error.message));
  await assert.rejects(runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "256" }, 8, log, able), (error) => error instanceof RunIsolationRefused && /AGENTRUN_RUN_SLOT_FIRST=256/.test(error.message));
  await assert.rejects(runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "-1" }, 8, log, able), RunIsolationRefused);
});

// ---------------------------------------------------------------------------------------------------------------------
// The store, as a run's process reaches it: bound to its claim.

test("the store a run's process reaches is bound to its claim: another run's journal, run or claim, another agent's revision, and a call off the list are refused unread", async () => {
  const called = [];
  const store = {
    readJournal: (runId) => void called.push(`readJournal ${runId}`),
    runs: {
      get: async (runId) => (called.push(`runs.get ${runId}`), { id: runId }),
      update: async (claim) => void called.push(`runs.update ${claim.runId}`),
    },
    agents: { revision: async (id) => (called.push(`agents.revision ${id}`), { id, agentId: id === "rev-own" ? "agent-own" : "agent-other" }) },
    settings: { set: async () => void called.push("settings.set") },
  };
  const bound = { claim: { runId: "run-own", epoch: 3 }, agentId: "agent-own", revisionId: "rev-own" };
  const lines = [];
  const call = (method, args) => storeCall(store, method, args, bound, (line) => void lines.push(line));
  await assert.rejects(call("readJournal", ["run-other", "conversation", ["c"]]), /may not call the store's readJournal of another run or agent/);
  await assert.rejects(call("runs.get", ["run-other"]), /of another run or agent/);
  await assert.rejects(call("runs.update", [{ runId: "run-own", epoch: 2 }, {}]), /of another run or agent/);
  await assert.rejects(call("settings.set", ["k", "v"]), /may not call the store's settings\.set/);
  assert.deepEqual(called, [], "a refused call reached the store");
  await assert.rejects(call("agents.revision", ["rev-other"]), /only its own agent's revisions/);
  assert.deepEqual(await call("runs.get", ["run-own"]), { id: "run-own" });
  assert.deepEqual(await call("agents.revision", ["rev-own"]), { id: "rev-own", agentId: "agent-own" });
  assert.ok(lines.some((line) => /asked the store for readJournal, which a run's process may not/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /asked for another agent's revision/.test(line)), lines.join("\n"));
});

// ---------------------------------------------------------------------------------------------------------------------
// The channel: a frame it never sends ends it.

const pair = (maxFrame) => {
  const [a, b] = duplexPair();
  const closed = [];
  const runner = new Channel(a, { ...(maxFrame ? { maxFrame } : {}), onClose: (why) => void closed.push(why) });
  return { runner, raw: b, closed };
};

test("a frame that does not read, one past the cap, or one that is no message of the channel ends the channel, failing every call in flight", async () => {
  const cases = [
    ["does not read", (raw) => raw.write(Buffer.from([0, 0, 0, 5, 0xff, 0x0f, 1, 2, 3])), /a frame did not read/],
    ["past the cap", (raw) => raw.write(Buffer.from([0x7f, 0xff, 0xff, 0xff])), new RegExp(`past the channel's ${MAX_FRAME}`)],
    ["no message", (raw) => {
      const body = serialize({ t: "stranger", id: 1 });
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      raw.write(Buffer.concat([head, body]));
    }, /not a message of the channel/],
  ];
  for (const [name, send, why] of cases) {
    const { runner, raw, closed } = pair();
    raw.on("data", () => {});
    const inFlight = runner.call("loop", "start", [{}]);
    send(raw);
    await assert.rejects(inFlight, (error) => error instanceof ChannelClosed && why.test(error.message), name);
    assert.equal(runner.closed, true, name);
    assert.equal(closed.length, 1, name);
    assert.match(closed[0].message, why, name);
    await assert.rejects(runner.call("loop", "command", [{}]), ChannelClosed, `${name}: a call after the end`);
  }
});

test("a call past the channel's cap fails alone, and the channel goes on", async () => {
  const [a, b] = duplexPair();
  const runner = new Channel(a, { maxFrame: 4096 });
  const child = new Channel(b, { maxFrame: 4096 });
  child.expose("echo", (_method, args) => args[0]);
  await assert.rejects(runner.call("echo", "it", ["x".repeat(8192)]), /past the channel's 4096/);
  assert.equal(runner.closed, false);
  assert.equal(await runner.call("echo", "it", ["small"]), "small");
  runner.close();
  child.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole server: a run whose process breaks its channel fails, and the store's files are the server's alone.

async function launched(t) {
  const dir = scratchDir(t, "run-isolation-");
  const canary = `nak-${process.pid}-${Date.now().toString(36)}`;
  const secrets = Object.fromEntries(SECRET_NAMES.map((name, i) => [name, name === "AGENTRUN_TOKEN" ? `${canary}-token-0123456789abcdef` : name === "AGENTRUN_TOKENS" ? `custody:${canary}-tokens-0123456789abcdef0123456789` : name === "AGENTRUN_SEAL_KEY" ? randomBytes(32).toString("base64") : name === "AGENTRUN_STORE_URL" ? undefined : `${canary}-${i}`]));
  const env = { ...process.env, ...secrets, XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: dir };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  delete env.AGENTRUN_RUN_USER;
  const data = join(dir, "data");
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", "--faux", BREAKER], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  let said = "";
  child.stderr.on("data", (chunk) => void (said += chunk));
  child.stdout.on("data", (chunk) => void (said += chunk));
  t.after(async () => {
    if (alive) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await Promise.race([exited, sleep(10_000)]);
  });
  const out = await printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  return { api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], secrets.AGENTRUN_TOKEN), data, said: () => said };
}

test("a run whose process writes a frame its channel never sends fails, in words, and the server goes on; the store's files are the server's alone (0600)", { timeout: 180_000 }, async (t) => {
  const { api, data, said } = await launched(t);
  assert.equal((await api("GET", "/capabilities")).body.run_isolation, "process", "a host with no helper says process");
  assert.equal((await api("POST", "/agents", { definition: { id: "breaker", version: 1, name: "breaker", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-6.1-sol" } })).status, 201);
  const ended = async (content) => {
    const { status, body: run } = await api("POST", "/agents/breaker/runs", { input: { content } });
    assert.equal(status, 202, JSON.stringify(run));
    let view;
    for (const end = Date.now() + 90_000; !["completed", "failed", "cancelled"].includes((view = (await api("GET", `/runs/${run.run_id}`)).body).status); await sleep(200)) {
      assert.ok(Date.now() < end, `${content} never ended: ${JSON.stringify(view)}\nthe server said: ${said().split("\n").filter((line) => !line.includes("event=request")).join("\n").slice(-3000)}`);
    }
    return view;
  };
  for (const [content, why] of [["Garbled.", /a frame did not read/], ["Oversized.", /past the channel's/], ["Stranger.", /not a message of the channel/]]) {
    const view = await ended(content);
    assert.equal(view.status, "failed", `${content}: ${JSON.stringify(view)}`);
    assert.match(view.error?.message ?? "", /the run's process ended with its run: it broke its channel/, `${content}: ${JSON.stringify(view)}`);
    assert.match(JSON.stringify(view), why, `${content}: ${JSON.stringify(view)}`);
  }
  // The runner goes on: the next run completes, in a process of its own (not the server's).
  const fine = await ended("Answer.");
  assert.equal(fine.status, "completed", JSON.stringify(fine));
  const answered = JSON.parse(fine.result.final_answer);
  assert.notEqual(answered.pid, undefined);
  t.diagnostic(`a run's process at its first turn: ${answered.rssMib} MiB resident`);
  const files = readdirSync(data).filter((name) => /^store\.sqlite/.test(name) || /^runner-.*\.alive$/.test(name));
  assert.ok(files.includes("store.sqlite"), `no store in ${readdirSync(data).join(" ")}`);
  for (const name of files) assert.equal((statSync(join(data, name)).mode & 0o777).toString(8), "600", `${name} is ${(statSync(join(data, name)).mode & 0o777).toString(8)}: ${said().slice(-400)}`);
});
