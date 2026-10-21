// The stop's sweep by label: every RUNNING box of a run (pda-run=<run>, pda-role=gpu) found through pi-transport's provider.list and destroyed through it, then listed again until none is left.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sweepBoxes } from "../sweep-boxes.ts";

type Ref = { id: string; labels: Record<string, string> };
function fake(running: Ref[], options: { stuck?: string[]; lingerLists?: number } = {}) {
  const destroyed: string[] = [];
  const asked: Record<string, string>[] = [];
  let lingering = 0;
  const provider = {
    name: "modal",
    list: async (labels: Record<string, string>) => {
      asked.push(labels);
      const live = running.filter((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v) && !(destroyed.includes(r.id) && lingering++ >= (options.lingerLists ?? 0)));
      return { ok: true, value: live };
    },
    attach: async (id: string) => ({ ok: true, value: { id, destroy: async () => (options.stuck?.includes(id) ? { ok: false, error: { code: "unknown", message: "modal is having a moment" } } : (destroyed.push(id), { ok: true, value: undefined })) } }),
  };
  return { provider, destroyed, asked };
}
const ref = (id: string, run: string, role = "gpu"): Ref => ({ id, labels: { "pda-run": run, "pda-role": role, "pda-slot": id.slice(-1) } });

test("it destroys every running box of the run and of nothing else, and says so", async () => {
  const f = fake([ref("sb-1", "walks-home"), ref("sb-2", "walks-home"), ref("sb-3", "another-run"), ref("sb-4", "walks-home", "vm")]);
  const out = await sweepBoxes(f.provider as never, "walks-home", { waitMs: 500, pollMs: 10 });
  assert.deepEqual(f.destroyed.sort(), ["sb-1", "sb-2"]);
  assert.deepEqual(f.asked[0], { "pda-run": "walks-home", "pda-role": "gpu" });
  assert.deepEqual(out, { found: 2, destroyed: 2, left: 0, leftIds: [] });
});

test("a box that Modal still lists right after its destroy (it can read running for about 30 s) is waited for, and counted left only if it is still listed when the wait ends", async () => {
  const lingering = fake([ref("sb-1", "r")], { lingerLists: 2 });
  assert.deepEqual(await sweepBoxes(lingering.provider as never, "r", { waitMs: 1_000, pollMs: 10 }), { found: 1, destroyed: 1, left: 0, leftIds: [] });
  const stuck = fake([ref("sb-9", "r")], { stuck: ["sb-9"] });
  assert.deepEqual(await sweepBoxes(stuck.provider as never, "r", { waitMs: 80, pollMs: 10 }), { found: 1, destroyed: 0, left: 1, leftIds: ["sb-9"] });
});

test("a run with nothing running sweeps to zero", async () => {
  assert.deepEqual(await sweepBoxes(fake([]).provider as never, "r", { waitMs: 50, pollMs: 10 }), { found: 0, destroyed: 0, left: 0, leftIds: [] });
});

test("scripts/sweep-boxes.mjs loads, its imports resolve, and --check says what it would do without calling Modal", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sweep-boxes.mjs");
  const run = spawnSync(process.execPath, [script, "--run", "walks-home", "--check"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /sweep-boxes: would list running boxes with pda-run=walks-home and pda-role=gpu in app pda-demo-d4/);
});
