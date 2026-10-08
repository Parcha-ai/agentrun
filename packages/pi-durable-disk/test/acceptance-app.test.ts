// The acceptance app (test/acceptance/_app.ts) on a local directory, no Archil: its jobs are deterministic, finish with
// every paid effect dispatched once, and keep pi's promises across a crash: a paid effect cut mid-dispatch comes back
// interrupted and is never sent again, and a model turn in flight at the crash is the only one asked twice. The live
// suite (test/acceptance/) asserts the same across two FUSE hosts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { finalAnswer, fileText, lateRows, parseJob, plan, storeRows, type Job, type JobResult, type StoreRows } from "./acceptance/_app.ts";
import { openArchilStore } from "../src/store.ts";
import { ctx, scratchRoot } from "./_run-support.ts";
import { startPaidApi, type PaidApi } from "./fixtures/paid-api.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/accept-local.ts", import.meta.url));
const RUN = "local-accept";

type Event = Record<string, unknown> & { event: string };

/** The job in a child process on `root`; resolves with its events and exit once it ends (or is killed). */
function runChild(root: string, api: PaidApi, job: Job) {
  const child = spawn(process.execPath, [FIXTURE, root, api.url, JSON.stringify(job)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  const events: Event[] = [];
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  createInterface({ input: child.stdout! }).on("line", (l) => events.push(JSON.parse(l) as Event));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, events, exited, stderr: () => stderr };
}

const resultOf = (events: Event[]) => events.findLast((e) => e.event === "settled")?.result as JobResult;

/** The job's rows as the store on `root` holds them, read after the run released it. */
async function rowsOn(root: string): Promise<StoreRows> {
  const store = await openArchilStore(join(root, "store", "run.sqlite"));
  try {
    return await storeRows(store.storage);
  } finally {
    await store.storage.close(ctx);
  }
}

describe("the acceptance app's jobs", () => {
  it("are deterministic: the paid job is N charges, the agentic job five tool calls per cycle plus its charges", () => {
    assert.deepEqual(plan(parseJob('{"kind":"paid","charges":3}')).map((s) => s.id), ["charge-1", "charge-2", "charge-3"]);
    const agentic: Job = { kind: "agentic", cycles: 6, charges: 2, fileBytes: 1_000 };
    const steps = plan(agentic);
    assert.equal(steps.length, 6 * 5 + 2);
    assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, "call ids are unique");
    assert.deepEqual(steps.filter((s) => s.name === "paid_charge").map((s) => s.id), ["charge-1", "charge-2"]);
    assert.equal(fileText(3, 1_000), fileText(3, 1_000));
    assert.ok(fileText(3, 1_000).length >= 1_000 && fileText(3, 1_000).startsWith("edit-marker-3\n"));
    assert.equal(finalAnswer(agentic), "done 32 steps");
    assert.throws(() => parseJob('{"kind":"paid","charges":0}'));
  });

  for (const job of [{ kind: "paid", charges: 3 }, { kind: "agentic", cycles: 3, charges: 2, fileBytes: 2_000 }] satisfies Job[]) {
    it(`a clean ${job.kind} run finishes with every paid effect dispatched once and no model turn asked twice`, async () => {
      const api = await startPaidApi();
      const dir = scratchRoot("accept");
      try {
        const run = runChild(dir.root, api, job);
        assert.deepEqual(await run.exited, { code: 0, signal: null }, run.stderr());
        const result = resultOf(run.events);
        assert.equal(result.status, "done");
        assert.equal(result.final, finalAnswer(job));
        assert.deepEqual(result.calls.map((c) => c.id), plan(job).map((s) => s.id));
        assert.ok(result.results.every((r) => !r.isError), JSON.stringify(result.results.filter((r) => r.isError)));
        assert.deepEqual(Object.values(api.counts("charge")), Array(job.charges).fill(1));
        assert.equal(api.requests("model").length, plan(job).length + 1);
        assert.ok(Object.values(api.counts("model")).every((n) => n === 1));
        assert.equal(typeof run.events.find((e) => e.event === "done")?.sealedSeq, "number");
      } finally {
        await api.close();
        dir.remove();
      }
    });
  }

  it("a crash in the middle of a paid effect's dispatch: the effect comes back interrupted on the next open and is never sent again", async () => {
    const api = await startPaidApi();
    const dir = scratchRoot("accept-cut");
    const job: Job = { kind: "paid", charges: 3 };
    try {
      const hold = api.hold({ route: "charge", key: `${RUN}:charge-2` });
      const first = runChild(dir.root, api, job);
      const held = await hold.first;
      const lostWriter = `local:${first.child.pid}`;
      const lossAt = Date.now();
      first.child.kill("SIGKILL");
      await first.exited;
      for (let i = 0; i < 200 && held.state === "held"; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(held.state, "cut");
      const second = runChild(dir.root, api, job);
      assert.deepEqual(await second.exited, { code: 0, signal: null }, second.stderr());
      const result = resultOf(second.events);
      assert.deepEqual(result.results.filter((r) => r.interrupted).map((r) => r.id), ["charge-2"]);
      assert.deepEqual(result.calls.map((c) => c.id), ["charge-1", "charge-2", "charge-3"]);
      assert.equal(result.final, "charged 3");
      assert.deepEqual(api.counts("charge"), { [`${RUN}:charge-1`]: 1, [`${RUN}:charge-2`]: 1, [`${RUN}:charge-3`]: 1 });
      assert.deepEqual(Object.values(api.counts("model")).filter((n) => n > 1), [], "nothing was in flight at the model");
      // The store: the cut call's row is the interrupted result; the lost process's rows all come from before its loss.
      const rows = await rowsOn(dir.root);
      assert.deepEqual(rows.results.filter((r) => r.id === "charge-2").map((r) => [r.interrupted, r.receipt, r.writer]), [[true, null, null]]);
      assert.ok(rows.assistants.some((a) => a.writer === lostWriter) && rows.results.some((r) => r.writer === lostWriter));
      assert.deepEqual(lateRows(rows, api.requests(), lossAt, (w) => w === lostWriter), []);
      // Negative control: a paid result the lost process would have committed from the cut answer is caught.
      const forged: StoreRows = { ...rows, results: [...rows.results, { id: "charge-2", name: "paid_charge", isError: false, interrupted: false, receipt: held.seq, writer: lostWriter }] };
      assert.deepEqual(lateRows(forged, api.requests(), lossAt, (w) => w === lostWriter), [`result row charge-2 receipt ${held.seq}`]);
    } finally {
      await api.close();
      dir.remove();
    }
  });

  it("a crash with a model turn in flight after a paid effect: only that turn is asked again, and no paid effect twice", async () => {
    const api = await startPaidApi();
    const dir = scratchRoot("accept-turn");
    const job: Job = { kind: "paid", charges: 3 };
    try {
      const hold = api.hold({ route: "model", match: (r) => (r.body as { paid?: number }).paid === 1 });
      const first = runChild(dir.root, api, job);
      const held = await hold.first;
      const lostWriter = `local:${first.child.pid}`;
      const lossAt = Date.now();
      first.child.kill("SIGKILL");
      await first.exited;
      const second = runChild(dir.root, api, job);
      assert.deepEqual(await second.exited, { code: 0, signal: null }, second.stderr());
      const result = resultOf(second.events);
      assert.ok(result.results.every((r) => !r.isError));
      assert.equal(result.final, "charged 3");
      assert.ok(Object.values(api.counts("charge")).every((n) => n === 1));
      const repeated = Object.entries(api.counts("model")).filter(([, n]) => n > 1);
      assert.deepEqual(repeated, [[held.key, 2]]);
      // The turn in flight has one row, written by the process that resumed; the lost process wrote nothing after it.
      const rows = await rowsOn(dir.root);
      assert.deepEqual(rows.assistants.filter((a) => a.turn === held.key).map((a) => a.writer === lostWriter), [false]);
      assert.deepEqual(lateRows(rows, api.requests(), lossAt, (w) => w === lostWriter), []);
      // Negative control: a row for that turn from the lost process (whose answer never arrived) is caught.
      const forged: StoreRows = { ...rows, assistants: [...rows.assistants, { calls: ["charge-2"], writer: lostWriter, turn: held.key }] };
      assert.equal(lateRows(forged, api.requests(), lossAt, (w) => w === lostWriter).length, 1);
    } finally {
      await api.close();
      dir.remove();
    }
  });
});
