// The multiverse against a scripted disk and fleet: what the stage sees (the fold of the emitted events) through a
// fan-out, a kill and its takeover, a second kill, and the collapse; and the feed's replay rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnsureResult, HostDriver, HostHandle, RunRecord, RunRef } from "@parcha/pi-durable-disk";
import { directPlacement } from "../direct.ts";
import { Feed, serveFeed } from "../feed.ts";
import { KILLED_HOLD_MS, Multiverse, PROGRESS_FILE, type Control, type Fleet, type Machine, type Progress } from "../multiverse.ts";
import type { ShowEvent } from "../show/types.ts";

const REF: RunRef = { disk: "dsk-test", region: "test", id: "src" };

/** A disk of run records and progress files, and a fleet whose instances write a resume checkpoint when they start. */
function world() {
  const records = new Map<string, RunRecord>();
  const progress = new Map<string, Progress>();
  const dead = new Set<string>();
  const calls: string[] = [];
  const record = (run: string, patch: Partial<RunRecord>): RunRecord => {
    const r = { run, status: "paused", generation: 0, sealedSeq: 3, wakeAt: null, holder: null, heartbeatAt: null, updatedAt: new Date().toISOString(), detail: null, ...records.get(run), ...patch } as RunRecord;
    records.set(run, r);
    return r;
  };
  record("src", {});
  const control = {
    async getObject(key: string) {
      const [, run, ...rest] = key.split("/");
      const file = rest.join("/");
      const value = file === "run.json" ? records.get(run!) : file === PROGRESS_FILE ? progress.get(run!) : undefined;
      if (!value) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
      return new TextEncoder().encode(JSON.stringify(value));
    },
  } as unknown as Control;
  /** What the trainer would write: a checkpoint by the current generation on the current machine. */
  const checkpoint = (run: string, step: number, score: number) => {
    const r = records.get(run)!;
    progress.set(run, { step, total: 20, score, progress: step / 20, done: step >= 20, generation: r.generation, host: String((r.holder as { label?: string } | null)?.label), at: new Date().toISOString() });
  };
  let made = 0;
  const driver = (machine: Machine): HostDriver => {
      return {
        async start(ref) {
          calls.push(`start ${ref.id} on ${machine.id}`);
          const before = records.get(ref.id)!;
          record(ref.id, { status: "running", generation: before.generation + 1, holder: { driver: "test", label: machine.label } as never });
          // A resumed trainer reports at once from its last checkpoint (trainer.ts).
          const last = progress.get(ref.id);
          setTimeout(() => checkpoint(ref.id, last?.step ?? 0, last?.score ?? 0), 20);
          return { driver: "test", machine: machine.id } as HostHandle;
        },
        async status(h) {
          return dead.has(String(h.machine)) ? "gone" : "running";
        },
        async stop(h) {
          calls.push(`stop ${h.machine}`);
          for (const [id, r] of records) if ((r.holder as { label?: string } | null)?.label === machine.label && r.status === "running") record(id, { status: "paused", sealedSeq: 9 });
        },
      };
  };
  const ops = {
    ensureRunning: async (ref: RunRef, d: HostDriver): Promise<EnsureResult> => {
      const handle = await d.start(ref, "token");
      return { action: "started", reason: "none", woke: false, revoked: [], handle, token: { identifier: `tok-${ref.id}`, nickname: "n" }, startMs: 1, generation: 1 } as unknown as EnsureResult;
    },
    revoke: async (_c: unknown, id: string) => {
      calls.push(`revoke ${id}`);
      return [];
    },
    readRunStatus: async (_c: unknown, id: string) => records.get(id) ?? null,
  };
  const fleet: Fleet = {
    ...directPlacement({ control, driver, ops: ops as never }),
    async warm(name) {
      made++;
      return { id: `box-${name}`, label: `box ${name}`, kind: "sandbox", ratePerHour: 0.36, since: Date.now() };
    },
    async kill(m) {
      calls.push(`kill ${m.id}`);
      dead.add(m.id);
    },
    async retire(m) {
      calls.push(`retire ${m.id}`);
    },
  };
  /** Sequential forks, as `fork` one by one would make them. */
  const forkAll = async (ref: RunRef, ids: readonly string[]) =>
    ids.map((id) => {
      calls.push(`fork ${ref.id} -> ${id}`);
      record(id, { generation: 0, sealedSeq: records.get(ref.id)!.sealedSeq });
      return { run: id, ms: 1, files: 2, bytes: 10 };
    });
  return { control, fleet, forkAll, checkpoint, records, calls, made: () => made };
}

test("fan out, kill with a spare taking the slot, a second kill, collapse: what the stage folds", async () => {
  const w = world();
  const feed = new Feed();
  const events: ShowEvent[] = [];
  const mv = new Multiverse({
    control: w.control,
    fleet: w.fleet,
    source: REF,
    sourceLabel: "your browser tab",
    universes: [
      { id: "u1", reward: "forward speed" },
      { id: "u2", reward: "low foot slip" },
    ],
    spares: 1,
    mountRoot: "/mnt/test",
    runPrefix: "r-",
    machinePrefix: "",
    emit: (e) => (events.push(e), feed.emit(e)),
    origin: Date.now(),
    pollMs: 60_000,
    forkAll: w.forkAll,
  });
  const fan = await mv.fanOut();
  assert.deepEqual(fan.forks.map((f) => f.run), ["r-u1", "r-u2"]);
  // Forks are sequential and each universe starts on its own machine.
  assert.deepEqual(w.calls.filter((c) => c.startsWith("fork")), ["fork src -> r-u1", "fork src -> r-u2"]);
  assert.ok(w.calls.includes("start r-u1 on box-u1") && w.calls.includes("start r-u2 on box-u2"));
  let st = feed.state;
  assert.equal(st.universes.u1!.slot, 0);
  assert.equal(st.universes.u2!.slot, 1);
  assert.equal(st.universes.u1!.host, "box u1");
  assert.equal(st.universes.spare1!.status, "spare");
  assert.equal(st.universes.spare1!.slot, null);

  w.checkpoint("r-u1", 5, 0.5);
  w.checkpoint("r-u2", 5, 0.2);
  await mv.poll();
  st = feed.state;
  assert.equal(st.universes.u1!.status, "training");
  assert.deepEqual(st.universes.u1!.samples.map((s) => s.score), [0.5]);

  const t0 = Date.now();
  const killing = mv.kill("u1");
  // A second kill must not get the spare the first one reserved.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(feed.state.universes.spare1!.status, "takeover");
  assert.equal(feed.state.universes.spare1!.replaces, "u1");
  assert.equal(feed.state.universes.u1!.status, "killed");
  assert.equal(feed.state.universes.u1!.slot, 0, "the killed tile keeps its slot while it shows dead");
  const report = await killing;
  assert.ok(Date.now() - t0 >= KILLED_HOLD_MS);
  st = feed.state;
  assert.equal(st.universes.spare1!.slot, 0);
  assert.equal(st.universes.spare1!.status, "training");
  assert.equal(st.universes.spare1!.reward, "forward speed");
  assert.equal(st.universes.u1!.slot, null);
  assert.equal(st.universes.u1!.replacedBy, "spare1");
  assert.equal(w.records.get("r-u1")!.generation, 2, "the spare's instance opened the run at the next generation");
  assert.equal(report.transport, "direct");
  assert.deepEqual(w.calls.filter((c) => /kill|revoke/.test(c)), ["kill box-u1", "revoke r-u1"]);
  // The slot handover is shown only after the dead tile was readable.
  const slotMove = events.findIndex((e) => e.t === "universe" && e.id === "spare1" && e.patch.slot === 0);
  const dying = events.findIndex((e) => e.t === "universe" && e.id === "u1" && e.patch.status === "killed");
  assert.ok(events[slotMove]!.at - events[dying]!.at >= KILLED_HOLD_MS - 5);
  // The lost stay ends, the spare's begins with the handover.
  const handover = st.stays.find((s) => s.lane === "u:spare1")!.handover!;
  assert.equal(handover.fromHost, "box u1");
  assert.equal(handover.planned, false);
  assert.equal(st.stays.find((s) => s.lane === "u:u1")!.endedBy, "killed");
  // A new spare was made to replace the one used.
  assert.ok(st.universes.spare2);

  const second = await mv.kill("u2");
  assert.equal(second.by, "spare2");
  await assert.rejects(mv.kill("u1"), /killed/);

  w.checkpoint("r-u1", 20, 0.9);
  w.checkpoint("r-u2", 20, 0.4);
  await mv.poll();
  const collapse = await mv.collapse();
  assert.equal(collapse.winner, "spare1");
  st = feed.state;
  assert.equal(st.universes.spare1!.status, "winner");
  assert.equal(st.universes.spare2!.status, "sealed");
  assert.deepEqual(collapse.sealed.map((s) => s.run), ["r-u2"]);
  assert.equal(w.records.get("r-u2")!.status, "paused", "the loser drained and sealed");
  // Measured notes are flagged for the stage's captions: every takeover, the fan-out, the collapse.
  const measured = events.filter((e) => e.t === "note" && e.measured).map((e) => (e as { kind: string }).kind);
  assert.deepEqual(measured, ["story", "takeover", "takeover", "story"]);
  // The spare nobody used is deleted; the winner keeps its machine.
  const unused = Object.values(st.universes).filter((u) => u.id.startsWith("spare") && u.id !== "spare1" && u.id !== "spare2");
  for (const u of unused) assert.equal(u.status, "sealed");
  assert.ok(!w.calls.some((c) => c === "stop box-spare1"));
  await mv.close();
});

test("the feed: state carries the last event id, events replay after it, commands answer 409 when refused", async () => {
  const feed = new Feed();
  feed.emit({ t: "note", at: 1, kind: "story", text: "one" });
  feed.emit({ t: "note", at: 2, kind: "story", text: "two" });
  const server = await serveFeed({ feed, port: 0, command: async (c) => (c.t === "kill" ? { ok: false, error: "no such universe" } : { ok: true }) });
  try {
    const state = await fetch(`${server.url}/api/state`);
    assert.equal(state.headers.get("x-last-event-id"), "1");
    assert.equal(((await state.json()) as { notes: unknown[] }).notes.length, 2);
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events?after=0`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    feed.emit({ t: "note", at: 3, kind: "story", text: "three" });
    let text = "";
    while (!text.includes("three")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^id: 1\ndata: .*"two"/);
    assert.match(text, /id: 2\ndata: .*"three"/);
    assert.doesNotMatch(text, /"one"/);
    ctrl.abort();
    const refused = await fetch(`${server.url}/api/command`, { method: "POST", body: JSON.stringify({ t: "kill", universe: "u9" }) });
    assert.equal(refused.status, 409);
  } finally {
    feed.close();
    server.close();
  }
});
