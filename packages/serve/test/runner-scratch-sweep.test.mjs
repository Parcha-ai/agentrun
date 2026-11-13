// A runner's start sweep of ended runs' scratch folders (runner/scratch-sweep.ts): a CLI run whose runner died and that
// ended with no later claim keeps its harness folders until a runner starts on the data directory. Only runs the store
// says are final are swept, and only the claims at or below the row's epoch. Rows are a stand-in store's: no timing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { sweepEndedScratch } = await import("../dist/runner/scratch-sweep.js");

const rows = {
  "run-ended": { state: "ended", epoch: 2 },
  "run-failed": { state: "failed", epoch: 1 },
  "run-running": { state: "running", epoch: 1 },
  "run-reopened": { state: "ended", epoch: 1 },
};
const store = { runs: { get: async (id) => rows[id] } };

function laid(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-scratch-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = (agent, run, epoch) => join(dir, "scratch", agent, run, "harness", String(epoch), "home");
  const lay = (agent, run, epoch) => {
    mkdirSync(home(agent, run, epoch), { recursive: true });
    writeFileSync(join(home(agent, run, epoch), "session.json"), "{}");
  };
  return { dir, lay, folder: (agent, run) => join(dir, "scratch", agent, run) };
}

test("a runner's start sweeps the scratch folders of final runs, never a live run's, an unknown run's or a later claim's", async (t) => {
  const { dir, lay, folder } = laid(t);
  lay("agent-a", "run-ended", 1);
  lay("agent-a", "run-ended", 2);
  lay("agent-a", "run-failed", 1);
  lay("agent-b", "run-running", 1);
  lay("agent-b", "run-unknown", 1);
  // A follow-up reopened this run after its row was read at epoch 1: its claim 2 is above the row's epoch.
  lay("agent-b", "run-reopened", 1);
  lay("agent-b", "run-reopened", 2);
  const said = [];
  const result = await sweepEndedScratch(store, dir, { log: (line) => said.push(line) });
  assert.equal(existsSync(folder("agent-a", "run-ended")), false, "an ended run's folders are gone, every claim's");
  assert.equal(existsSync(folder("agent-a", "run-failed")), false, "a failed run's too");
  assert.equal(existsSync(join(dir, "scratch", "agent-a")), false, "and the agent's emptied folder");
  assert.equal(existsSync(folder("agent-b", "run-running")), true, "a run that is not final keeps its folder");
  assert.equal(existsSync(folder("agent-b", "run-unknown")), true, "a run the store has no row for keeps its folder");
  assert.deepEqual(readdirSync(join(folder("agent-b", "run-reopened"), "harness")), ["2"], "a claim above the row's epoch is never touched");
  assert.deepEqual(result, { examined: 5, swept: 3, kept: 2, failed: 0 });
  assert.ok(said.some((line) => /3 ended runs' folders swept, 2 kept, 0 failed/.test(line)), `said: ${said.join(" | ")}`);
});

test("the start sweep is bounded by its limit and says so, and a second start finishes what the first left", async (t) => {
  const { dir, lay, folder } = laid(t);
  for (const run of ["run-ended", "run-failed"]) lay("agent-a", run, 1);
  const said = [];
  const first = await sweepEndedScratch(store, dir, { log: (line) => said.push(line), limit: 1 });
  assert.equal(first.examined, 1);
  assert.ok(said.some((line) => /stopped after 1 run folders swept/.test(line)), `said: ${said.join(" | ")}`);
  const left = ["run-ended", "run-failed"].filter((run) => existsSync(folder("agent-a", run)));
  assert.equal(left.length, 1, "one run's folder is left by the bounded sweep");
  await sweepEndedScratch(store, dir, {});
  assert.equal(existsSync(join(dir, "scratch")), true, "the scratch root itself is never removed");
  assert.deepEqual(readdirSync(join(dir, "scratch")), [], "the next start swept the rest");
});

test("more retained folders than the limit in front of an ended run never hide it, and none of them is deleted", async (t) => {
  const { dir, lay, folder } = laid(t);
  // "a-" sorts before "z-": the retained folders (running and unknown rows) come first in the scan.
  const retained = [];
  for (let i = 0; i < 520; i += 1) {
    const run = i % 2 === 0 ? "run-running" : `run-unknown-${i}`;
    const agent = `a-${String(i).padStart(3, "0")}`;
    lay(agent, run, 1);
    retained.push(folder(agent, run));
  }
  lay("z-agent", "run-ended", 1);
  const result = await sweepEndedScratch(store, dir, { limit: 500 });
  assert.equal(existsSync(folder("z-agent", "run-ended")), false, "the ended run behind 520 retained folders is swept");
  assert.equal(result.swept, 1);
  assert.equal(result.kept, 520);
  assert.ok(retained.every((path) => existsSync(path)), "no retained folder is deleted");
});

test("a data directory with no scratch folder, or a store that fails on a row, never stops the start", async (t) => {
  const { dir, lay } = laid(t);
  assert.deepEqual(await sweepEndedScratch(store, dir, {}), { examined: 0, swept: 0, kept: 0, failed: 0 });
  lay("agent-a", "run-ended", 1);
  const said = [];
  const broken = { runs: { get: async () => { throw new Error("store busy"); } } };
  const result = await sweepEndedScratch(broken, dir, { log: (line) => said.push(line) });
  assert.equal(result.failed, 1);
  assert.ok(said.some((line) => /store busy/.test(line)), "the failure is said");
  assert.equal(existsSync(join(dir, "scratch", "agent-a", "run-ended")), true, "nothing is deleted on a failed read");
});
