// A session's box slot, on a scripted box (its start and its reap): one box at a time, refused at once while the last
// is live or not counted empty; the box reaped as soon as its process exits or never gets going, its latest record the
// one reaped; and the reap's own count the only evidence. Real boxes are proved where they run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxError, boxSlot } from "../dist/host/index.js";

/** A named box error: its code, and the message led by it. */
const named = (code, check = () => true) => (error) => error instanceof BoxError && error.code === code && error.message.startsWith(`${code}: `) && check(error);

/** A promise and its settle functions. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** A box scripted for one test: what happened, in order, and its reap's verdict per call. */
function scripted({ verdicts = [], throwAfterAhead, skipAhead } = {}) {
  const log = [];
  const ready = deferred();
  const exited = deferred();
  const reaps = [...verdicts];
  const recorder = {
    ahead: (r) => log.push(`ahead ${r.id}`),
    started: async (r) => log.push(`started ${r.id} pid ${r.pid}`),
  };
  const start = (rec) => {
    if (!skipAhead) rec.ahead({ id: "box-1" });
    log.push("spawned");
    if (throwAfterAhead) throw new Error(throwAfterAhead);
    void rec.started({ id: "box-1", pid: 4242 }).then(() => log.push("released"));
    return { ready: ready.promise, exited: exited.promise };
  };
  const reap = async (r) => {
    log.push(`reap ${r.id}${r.pid ? ` pid ${r.pid}` : ""}`);
    return reaps.shift() ?? { empty: true, left: 0, by: "pidns" };
  };
  return { log, ready, exited, recorder, start, reap };
}

test("start is synchronous: the box's process comes back at once, its ahead record written before its spawn", () => {
  const box = scripted();
  const slot = boxSlot({ reap: box.reap });
  const { process } = slot.start(box.start, box.recorder);
  assert.equal(typeof process.then, "undefined", "the process itself, never a promise of it");
  assert.deepEqual(box.log.slice(0, 2), ["ahead box-1", "spawned"]);
  assert.equal(slot.state, "live");
});

test("a second start while the box is live, being reaped, or not counted empty is refused at once, named", async () => {
  const box = scripted({ verdicts: [{ empty: false, left: 1, by: "pidns" }] });
  const slot = boxSlot({ reap: box.reap });
  const { reaped } = slot.start(box.start, box.recorder);
  const again = () => slot.start(scripted().start, box.recorder);
  assert.throws(again, named("box_busy", (e) => /is live/.test(e.message)), "while live");
  box.exited.resolve({ code: 0 });
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(reaped, named("box_not_empty"));
  assert.throws(again, named("box_busy", (e) => /is full/.test(e.message)), "while not counted empty");
  assert.equal(box.log.filter((e) => e === "spawned").length, 1, "nothing more spawned");
});

test("the box is reaped as soon as its process exits, by its latest record, and a forged \"exit 0\" is not believed: the reap's count is", async () => {
  const box = scripted({ verdicts: [{ empty: false, left: 1, by: "pidns" }] });
  const slot = boxSlot({ reap: box.reap });
  const { reaped } = slot.start(box.start, box.recorder);
  await new Promise((resolve) => setImmediate(resolve));
  box.ready.resolve({ id: "box-1", pid: 4242 });
  // What a box can forge: a clean exit and a line saying it reaped itself.
  box.exited.resolve({ code: 0, signal: null, stderr: "box: reaped 0" });
  await assert.rejects(reaped, named("box_not_empty", (e) => e.left === 1 && e.record.pid === 4242));
  assert.equal(box.log.at(-1), "reap box-1 pid 4242");
  assert.equal(slot.state, "full");
});

test("only a reap that counts the box empty frees the slot for the next start", async () => {
  const box = scripted();
  const slot = boxSlot({ reap: box.reap });
  const { reaped } = slot.start(box.start, box.recorder);
  box.exited.resolve({ code: null, signal: "SIGKILL" });
  await reaped;
  assert.equal(slot.state, "empty");
  const next = scripted();
  slot.start(next.start, next.recorder);
  assert.equal(slot.state, "live");
});

test("a box that is never let go (ready rejects) is reaped like an exit, and the slot is empty only on the reap's count", async () => {
  const full = scripted({ verdicts: [{ empty: false, left: 0, by: "none" }] });
  const slot = boxSlot({ reap: full.reap });
  const { reaped } = slot.start(full.start, full.recorder);
  full.ready.reject(new Error("the started record failed: the box was killed"));
  await assert.rejects(reaped, named("box_not_empty"));
  assert.equal(slot.state, "full", "a record nothing could count is never empty");
  const ok = scripted();
  const other = boxSlot({ reap: ok.reap });
  const second = other.start(ok.start, ok.recorder);
  ok.ready.reject(new Error("bwrap exited before its child's pid"));
  await second.reaped;
  assert.equal(other.state, "empty");
  assert.match(ok.log.at(-1), /^reap box-1/);
});

test("a start that throws after its ahead record has its box reaped; one that throws before it spawned nothing", async () => {
  const box = scripted({ throwAfterAhead: "the argv was refused" });
  const slot = boxSlot({ reap: box.reap });
  assert.throws(() => slot.start(box.start, box.recorder), /the argv was refused/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.log.at(-1), "reap box-1");
  assert.equal(slot.state, "empty");
});

test("a start that returns a box it never recorded is refused, and the session starts nothing more", () => {
  const box = scripted({ skipAhead: true });
  const slot = boxSlot({ reap: box.reap });
  assert.throws(() => slot.start(box.start, box.recorder), named("box_record_failed"));
  assert.equal(slot.state, "full");
});

test("at open, the session's last record is reaped first: a box not counted empty keeps the slot refusing", async () => {
  const box = scripted({ verdicts: [{ empty: false, left: 2, by: "cgroup" }] });
  const slot = boxSlot({ reap: box.reap });
  await assert.rejects(slot.adopt({ id: "box-0", cgroup: "/sys/fs/cgroup/agentrun/run-1" }), named("box_not_empty", (e) => e.left === 2));
  assert.throws(() => slot.start(scripted().start, box.recorder), named("box_busy"));
  const clean = scripted();
  const fresh = boxSlot({ reap: clean.reap });
  await fresh.adopt({ id: "box-0", pid: 7 });
  assert.equal(fresh.state, "empty");
});

test("a reap that could not count (it throws) never frees the slot: the next start is refused, and so after adopt", async () => {
  const failing = async () => {
    throw Object.assign(new Error("EPERM: the cgroup could not be read"), { code: "EPERM" });
  };
  const box = scripted();
  const slot = boxSlot({ reap: failing });
  const { reaped } = slot.start(box.start, box.recorder);
  box.exited.resolve({ code: 0 });
  await assert.rejects(reaped, /EPERM/);
  assert.equal(slot.state, "full");
  assert.throws(() => slot.start(scripted().start, box.recorder), named("box_busy", (e) => /is full/.test(e.message)));
  const opened = boxSlot({ reap: failing });
  await assert.rejects(opened.adopt({ id: "box-0", pid: 7 }), /EPERM/);
  assert.equal(opened.state, "full");
  assert.throws(() => opened.start(scripted().start, box.recorder), named("box_busy"));
});

test("a box that exits while its started record is still being written is reaped by that record, once written; nothing it records after lands", async () => {
  const log = [];
  const write = deferred();
  const reaps = [];
  const recorder = {
    ahead: (r) => log.push(`ahead ${r.id}`),
    started: async (r) => {
      log.push(`writing ${r.id} pid ${r.pid}`);
      if (r.id === "box-1") await write.promise;
      log.push(`written ${r.id} pid ${r.pid}`);
    },
  };
  const exited = deferred();
  let late;
  const slot = boxSlot({ reap: async (r) => (reaps.push(r), { empty: true, left: 0, by: r.pid ? "pidns" : "none" }) });
  const { reaped } = slot.start((rec) => {
    rec.ahead({ id: "box-1" });
    void rec.started({ id: "box-1", pid: 4242, pidns: "pid:[1]" }).catch(() => {});
    late = rec;
    return { ready: new Promise(() => {}), exited: exited.promise };
  }, recorder);
  // bwrap exits while the started record is still on its way to disk.
  exited.resolve({ code: 1 });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reaps, [], "no reap while a record write is in flight");
  assert.throws(() => slot.start(() => ({}), recorder), named("box_busy"), "and nothing else starts");
  write.resolve();
  await reaped;
  assert.deepEqual(reaps.map((r) => [r.id, r.pid]), [["box-1", 4242]], "reaped by the record that was written, its pid namespace counted");
  // A record the ended box tries to write now is refused, and never reaches the next box's file.
  await assert.rejects(late.started({ id: "box-1", pid: 9999 }), named("box_record_failed"));
  assert.throws(() => late.ahead({ id: "box-1" }), named("box_record_failed"));
  const next = deferred();
  slot.start((rec) => {
    rec.ahead({ id: "box-2" });
    void rec.started({ id: "box-2", pid: 5151 });
    return { ready: new Promise(() => {}), exited: next.promise };
  }, recorder);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!log.includes("writing box-1 pid 9999"), `the ended box wrote nothing more: ${log}`);
  next.resolve({ code: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reaps.map((r) => [r.id, r.pid]).at(-1), ["box-2", 5151], "the next box is reaped by its own record");
});
