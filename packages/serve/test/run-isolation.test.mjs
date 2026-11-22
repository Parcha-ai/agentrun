// What keeps one run's process from another's and from the server, as far as this host can show without the image's
// helper (image-custody.sh shows the rest, as the image's users): each slot a uid of its own in the helper's range, the
// isolation a host gives chosen and refused in words, the channel's store bound to the claim, a frame the channel never
// sends ending the run, and the store's files the server's alone.
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { serialize } from "node:v8";
import { SECRET_NAMES } from "../dist/secrets.js";
import { shadowRunId } from "../dist/learn/audit.js";
import { Channel, ChannelClosed, MAX_FRAME } from "../dist/runner/run-channel.js";
import { FIRST_RUN_ID, reapSlot, RUN_SLOTS, RunIsolationRefused, runIsolationOf, SlotHold, slotId, Slots, storeCall } from "../dist/runner/run-child-host.js";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, client, printed } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const BREAKER = new URL("./fixtures/faux-channel.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readFileSafe = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const scratchDir = (t, prefix) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------------------------------------------------
// Slots and the isolation a host gives.

test("every slot of a runner is a uid of its own in the helper's range, and a slot given back is the next one taken", async () => {
  for (const [first, count] of [[0, RUN_SLOTS], [128, 128], [3, 5]]) {
    const slots = new Slots(first, count);
    const taken = [];
    for (let i = 0; i < count; i++) taken.push(await slots.take());
    const uids = taken.map(slotId);
    assert.equal(new Set(uids).size, count, `slots ${first}..${first + count - 1} share a uid: ${uids.join(" ")}`);
    assert.deepEqual([...taken].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => first + i), "a runner takes exactly its own slots");
    for (const uid of uids) assert.ok(uid >= FIRST_RUN_ID && uid < FIRST_RUN_ID + RUN_SLOTS, `uid ${uid} is outside the helper's ${FIRST_RUN_ID}-${FIRST_RUN_ID + RUN_SLOTS - 1}`);
    await assert.rejects(async () => slots.take(), /every run slot of this runner is held/);
    await slots.give(taken[1]);
    assert.equal(await slots.take(), taken[1]);
  }
});

test("two runners on one data directory never run two runs on one slot at once, their ranges overlapping or not: a slot another runner holds is skipped, and none free is no slot", async (t) => {
  const locks = scratchDir(t, "run-slots-");
  const held = [];
  t.after(async () => {
    for (const [slots, slot] of held) await slots.give(slot);
  });
  const takeAll = async (slots, n) => {
    const got = [];
    for (let i = 0; i < n; i++) {
      const slot = await slots.take();
      got.push(slot);
      if (slot !== undefined) held.push([slots, slot]);
    }
    return got;
  };
  // runner-1 from 0 holding 4, runner-2 from 2 holding 4: 2 and 3 are both runners'.
  const one = new Slots(0, 4, locks);
  const two = new Slots(2, 4, locks);
  const ones = await takeAll(one, 4);
  assert.deepEqual([...ones].sort(), [0, 1, 2, 3]);
  const twos = await takeAll(two, 4);
  assert.deepEqual(twos.filter((slot) => ones.includes(slot)), [], `runner-2 took ${twos.join(" ")} while runner-1 held ${ones.join(" ")}`);
  assert.deepEqual(twos.filter((slot) => slot !== undefined).sort(), [4, 5]);
  assert.equal(twos.filter((slot) => slot === undefined).length, 2, "with every free slot of its held by the other, a runner has none to take");
  // Given back by runner-1 (after its run's reap), the slot is runner-2's to take.
  await one.give(2);
  held.splice(held.findIndex(([slots, slot]) => slots === one && slot === 2), 1);
  const after = await two.take();
  assert.equal(after, 2);
  held.push([two, after]);
  // A runner that dies (SIGKILL: no give-back) holds no slot: its lock ends with it.
  const module = new URL("../dist/runner/run-child-host.js", import.meta.url).href;
  // (Its interval first: a runner's own work keeps it alive; the lock's holder does not.)
  const dying = spawn(process.execPath, ["--input-type=module", "-e", `setInterval(() => {}, 1000); import { Slots } from ${JSON.stringify(module)}; console.log(await new Slots(6, 1, ${JSON.stringify(locks)}).take());`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => void dying.kill("SIGKILL"));
  const took = await new Promise((resolve) => {
    dying.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    dying.once("exit", (code) => resolve(`exited ${code}`));
  });
  assert.equal(took, "6");
  const three = new Slots(6, 1, locks);
  assert.equal(await three.take(), undefined, "a slot a live runner holds is no other's");
  dying.kill("SIGKILL");
  let again;
  for (const end = Date.now() + 5_000; (again = await three.take()) === undefined; await sleep(50)) assert.ok(Date.now() < end, "the dead runner's slot stayed locked");
  assert.equal(again, 6);
  held.push([three, again]);
});

test("a slot's reap sweeps every folder of the host its uid can leave a file in (/tmp, /var/tmp, /dev/shm, /run/lock, /var/lock and /dev/mqueue), then gives the run's folders back to the server's user", async (t) => {
  const file = join(scratchDir(t, "runas-"), "agentrun-runas");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$0.calls"\n`);
  chmodSync(file, 0o755);
  const top = scratchDir(t, "top-");
  const scratch = scratchDir(t, "scratch-");
  assert.equal(await reapSlot({ kind: "uid", helper: file, first: 0, slots: 1 }, 0, [top, scratch], () => undefined), true);
  const [reap, own, ...rest] = readFileSync(`${file}.calls`, "utf8").trim().split("\n").map((line) => line.split(" "));
  assert.deepEqual(rest, [], "two calls: the reap, then the give-back");
  assert.deepEqual(reap.slice(0, 2), ["reap", "0"]);
  const swept = reap.flatMap((arg, i) => (arg === "--sweep" ? [reap[i + 1]] : []));
  assert.deepEqual(swept.sort(), ["/dev/mqueue", "/dev/shm", "/run/lock", "/tmp", "/var/lock", "/var/tmp"]);
  assert.ok(!reap.includes("--fix"), "the reap no longer takes the runner's group to fix modes: the give-back does");
  assert.deepEqual(own, ["own", "runner", top, scratch]);
});

test("a reap whose give-back fails does not hold: the slot is retired, never run on again with its last run's folders still its own", async (t) => {
  const file = join(scratchDir(t, "runas-"), "agentrun-runas");
  writeFileSync(file, `#!/bin/sh\n[ "$1" = own ] && { echo "own /x: operation not permitted" >&2; exit 1; }\nexit 0\n`);
  chmodSync(file, 0o755);
  const said = [];
  assert.equal(await reapSlot({ kind: "uid", helper: file, first: 0, slots: 1 }, 2, [scratchDir(t, "top-")], (line) => said.push(line)), false);
  assert.match(said.join("\n"), /slot 2's folders were not all given back to the server: own \/x: operation not permitted/);
  // A reap with no folders (the one before a slot's first run) gives nothing back.
  assert.equal(await reapSlot({ kind: "uid", helper: file, first: 0, slots: 1 }, 2, [], () => undefined), true);
});

test("a run's kill reaps its slot only while the run holds it: a kill still reaping holds the give-back, and a kill after it leaves the slot's next run alive", async (t) => {
  const dir = scratchDir(t, "hold-");
  const helper = join(dir, "agentrun-runas");
  // `run`: records its pid as its slot's, then becomes the program. `reap`: half a second in, kills the slot's recorded
  // process, as the helper's reap kills every process of the slot's uid.
  writeFileSync(helper, `#!/bin/sh\nd=$(dirname "$0")\ncase "$1" in\nrun) echo $$ > "$d/slot-$2.pid"; shift 2; [ "$1" = -- ] && shift; exec "$@" ;;\nreap) echo "reap $2 start" >> "$d/log"; sleep 0.5; kill -9 "$(cat "$d/slot-$2.pid")" 2>/dev/null; echo "reap $2 end" >> "$d/log" ;;\nesac\n`);
  chmodSync(helper, 0o755);
  const log = () => readFileSync(join(dir, "log"), "utf8");
  const runOn = async (slot) => {
    const child = spawn(helper, ["run", String(slot), "--", "sleep", "30"], { stdio: "ignore" });
    t.after(() => void child.kill("SIGKILL"));
    for (const end = Date.now() + 5_000; readFileSafe(join(dir, `slot-${slot}.pid`)).trim() !== String(child.pid); await sleep(20)) assert.ok(Date.now() < end, "the stand-in run never started");
    return child;
  };
  const alive = (child) => child.exitCode === null && child.signalCode === null;
  // The slot's first run, its kill (a stop's, late) still reaping as its run ends and gives the slot back.
  await runOn(0);
  const hold = new SlotHold(0, helper, () => undefined);
  const killing = hold.kill();
  await sleep(100);
  await hold.settle();
  assert.match(log(), /reap 0 end/, "the slot went back while its run's kill was still reaping it");
  await killing;
  // The slot's next run, then the first run's kill once more, after the give-back.
  const next = await runOn(0);
  await hold.kill();
  await sleep(800);
  assert.ok(alive(next), "a kill after the give-back killed the slot's next run");
  assert.equal(log().match(/reap 0 start/g).length, 1, log());
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
  // Runs it was told to hold past the helper's last slot: refused in words, never quietly fewer (runner-1 at 0 with 200
  // loops would take runner-2's 128 and up); with no number given it holds the slots from its first.
  await assert.rejects(runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "250" }, 8, log, able), (error) => error instanceof RunIsolationRefused && /slots 250\.\.257/.test(error.message) && /at most 6/.test(error.message) && /AGENTRUN_RUN_SLOT_FIRST/.test(error.message));
  assert.deepEqual(await runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "250" }, 6, log, able), { kind: "uid", helper: able, first: 250, slots: 6 });
  assert.deepEqual(await runIsolationOf({ AGENTRUN_RUN_SLOT_FIRST: "250" }, undefined, log, able), { kind: "uid", helper: able, first: 250, slots: 6 });
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

test("a host that won't let the runner start its helper (spawn EPERM, thrown at once) is refused in words naming the error and AGENTRUN_RUN_USER=same, never a raw throw, and with same the helper is never started", async (t) => {
  const helper = helperOf(t, 0);
  const started = [];
  // Node throws a spawn error other than EACCES, EAGAIN, EMFILE, ENFILE and ENOENT from execFile itself, before any
  // callback: a Render container's EPERM is one.
  const mocked = t.mock.method(childProcess, "execFile", (file) => {
    started.push(file);
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM", errno: -1, syscall: "spawn", path: file });
  });
  syncBuiltinESMExports();
  t.after(() => (mocked.mock.restore(), syncBuiltinESMExports()));
  const refused = await runIsolationOf({}, 8, () => {}, helper).then(() => null, (error) => error);
  assert.ok(refused instanceof RunIsolationRefused, `refused in words, not thrown: ${refused?.stack ?? refused}`);
  assert.match(refused.message, /^This runner will not claim runs: it cannot start a run as a user of its own \(spawn EPERM\)/);
  assert.match(refused.message, /set AGENTRUN_RUN_USER=same/);
  assert.deepEqual(started, [helper], "the check tried the helper once");
  started.length = 0;
  assert.deepEqual(await runIsolationOf({ AGENTRUN_RUN_USER: "same" }, 8, () => {}, helper), { kind: "process", why: "AGENTRUN_RUN_USER=same" });
  assert.deepEqual(started, [], "AGENTRUN_RUN_USER=same never starts the helper");
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

test("a capped run's process reads what was spent beside it, its own learning grades and its own audit's shadow run, and no other run's", async () => {
  const called = [];
  const store = {
    runs: {
      get: async (runId) => (called.push(`runs.get ${runId}`), { id: runId }),
      launch: async (runId) => (called.push(`runs.launch ${runId}`), { body: "{}" }),
    },
    learning: { spentBeside: async (runId) => (called.push(`learning.spentBeside ${runId}`), 0) },
  };
  const bound = { claim: { runId: "run-own", epoch: 1 }, agentId: "agent-own", revisionId: "rev-own" };
  const call = (method, args) => storeCall(store, method, args, bound, () => {});
  const own = shadowRunId("run-own");
  assert.equal(await call("learning.spentBeside", ["run-own", {}]), 0);
  assert.deepEqual(await call("runs.get", [own]), { id: own });
  assert.deepEqual(await call("runs.launch", [own]), { body: "{}" });
  await assert.rejects(call("learning.spentBeside", ["run-other", {}]), /of another run or agent/);
  await assert.rejects(call("runs.get", [shadowRunId("run-other")]), /of another run or agent/);
  await assert.rejects(call("runs.launch", [shadowRunId("run-other")]), /of another run or agent/);
  assert.deepEqual(called, ["learning.spentBeside run-own", `runs.get ${own}`, `runs.launch ${own}`]);
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

/** The launcher's server on a data directory of its own, its runs each a process of their own (no helper: process
 *  isolation). `faux`: its --faux module (false: none, the model the environment names). `keys`: false hands it no provider key,
 *  only its token and seal key. `extra`: more of its environment. No launch hook: its triggers start their runs here (the
 *  hook's secret's custody is secret-custody.test.mjs's and run-custody.test.mjs's). */
async function launched(t, { faux = BREAKER, keys = true, extra = {} } = {}) {
  const dir = scratchDir(t, "run-isolation-");
  const canary = `nak-${process.pid}-${Date.now().toString(36)}`;
  const own = (name) => name === "AGENTRUN_TOKEN" || name === "AGENTRUN_SEAL_KEY";
  const secrets = Object.fromEntries(SECRET_NAMES.map((name, i) => [name, name === "AGENTRUN_TOKEN" ? `${canary}-token-0123456789abcdef` : name === "AGENTRUN_TOKENS" ? `custody:${canary}-tokens-0123456789abcdef0123456789` : name === "AGENTRUN_SEAL_KEY" ? randomBytes(32).toString("base64") : name === "AGENTRUN_STORE_URL" || name === "AGENTRUN_LAUNCH_HOOK_SECRET" || (!keys && !own(name)) ? undefined : `${canary}-${i}`]));
  const env = { ...process.env, ...secrets, ...extra, XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: dir };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  delete env.AGENTRUN_RUN_USER;
  const data = join(dir, "data");
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", ...(faux ? ["--faux", faux] : [])], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
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

test("a run a schedule trigger started is told its trigger's zone in its own process, by its runner: the process reads no trigger's row", { timeout: 180_000 }, async (t) => {
  const { api, said } = await launched(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "zoned", version: 1, name: "zoned", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-6.1-sol" } })).status, 201);
  // A zone no CI host sits in, so the line names the trigger's and never the host's.
  const zone = "Pacific/Kiritimati";
  const created = await api("POST", "/triggers", { name: "zoned", enabled: false, source: { kind: "schedule", cron: "0 9 * * 1", timezone: zone }, target: { kind: "start_run", agent_id: "zoned", input: { content: "Today." }, max_cost_usd: 0.5 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fired = await api("POST", `/triggers/${created.body.id}/fire`, undefined, { "idempotency-key": "zoned-1" });
  assert.ok(fired.status < 300 && fired.body.run_id, JSON.stringify(fired.body));
  let view;
  for (const end = Date.now() + 90_000; !["completed", "failed", "cancelled"].includes((view = (await api("GET", `/runs/${fired.body.run_id}`)).body).status); await sleep(200)) {
    assert.ok(Date.now() < end, `the run never ended: ${JSON.stringify(view)}`);
  }
  const lines = said().split("\n").filter((line) => !line.includes("event=request"));
  assert.equal(view.status, "completed", `${JSON.stringify(view)}\nthe server said: ${lines.join("\n").slice(-3000)}`);
  assert.match(view.result.final_answer, new RegExp(`^Today is .*\\(${zone.replace("/", "\\/")}\\)\\.`));
  assert.deepEqual(lines.filter((line) => /which a run's process may not/.test(line)), [], "the run's process asked the store for what it may not");
});

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

// ---------------------------------------------------------------------------------------------------------------------
// A run's own model key (model_key), from a run's own process: the runner opens it from the claim's launch (Held
// runModelKey), at the claim and again for a message's key mid-turn (ClaimModelKey.fresh), and the process sends it.

const KEY_ONE = `not-a-secret-${"isolated-key-one"}-5b2e71`;
const KEY_TWO = `not-a-secret-${"isolated-key-two"}-d84c09`;

/** A front for gateway `gw` on loopback that records the bearer of each POST and holds the first until `release()`. Its
 *  connections are closed before it is (a box's port watcher holds one open). */
async function heldFront(t, gw) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const seen = [];
  const front = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST") seen.push(req.headers.authorization);
    if (req.method === "POST" && first) {
      first = false;
      await held;
    }
    try {
      const answer = await fetch(`${gw.url}${req.url}`, { method: req.method, headers: { "content-type": "application/json", authorization: req.headers.authorization ?? "" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (release(), front.closeAllConnections(), front.close(resolve))));
  return { url: `http://127.0.0.1:${front.address().port}`, seen, release: () => release() };
}

test("a run's own model key reaches its gateway from the run's own process: the key its start handed, then, mid-turn, a message's, on the very next request; the server holds no model key", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  const front = await heldFront(t, gw);
  const { api, data, said } = await launched(t, { faux: false, keys: false, extra: { AGENT_MODEL_BASE_URL: front.url, AGENT_MODEL: "claude-sonnet-5-5" } });
  assert.equal((await api("GET", "/capabilities")).body.run_isolation, "process");
  assert.equal((await api("POST", "/agents", agent("keyed"))).status, 201);
  const started = await api("POST", "/agents/keyed/runs", { input: { content: "Answer." }, model_key: KEY_ONE });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const until = async (check, what, ms = 60_000) => {
    for (const end = Date.now() + ms; !(await check()); await sleep(100)) assert.ok(Date.now() < end, `${what}, not within ${ms} ms\nthe server said: ${said().split("\n").filter((line) => !line.includes("event=request")).join("\n").slice(-3000)}`);
  };
  await until(() => front.seen.length >= 1, "the turn's first request reached the gateway's front");
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", model_key: KEY_TWO });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  // The message's row is taken once the run's process took it, its key read again first (the store, read-only here).
  const taken = () => {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT taken_at FROM commands WHERE run_id = ? AND kind = 'steer'").all(runId).some((row) => row.taken_at !== null);
    } finally {
      db.close();
    }
  };
  await until(taken, "the run took the message");
  front.release();
  let view;
  await until(async () => ["completed", "failed", "cancelled"].includes((view = (await api("GET", `/runs/${runId}`)).body).status), "the run ended", 90_000);
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(front.seen[0], `Bearer ${KEY_ONE}`, "the turn began on the key its start handed");
  assert.ok(front.seen.length >= 2, `a request after the message: ${front.seen.length}`);
  assert.deepEqual([...new Set(front.seen.slice(1))], [`Bearer ${KEY_TWO}`], "every request after the message carried its key");
  for (const key of [KEY_ONE, KEY_TWO]) assert.equal(said().includes(key), false, "no key in the server's or the runner's lines");
});
