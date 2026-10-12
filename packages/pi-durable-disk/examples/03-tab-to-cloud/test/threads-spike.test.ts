// The thread view against D1's real spike (04-walks-home/cluster/spike/spike_plan.ts): the cluster plans three threads, a host is killed mid-run and a second finishes it, and the spike writes what threadsOf returned
// mid-run (mid.json) and after (report.json). Those are the real listings the relay will be given: they are fed through the relay and the page's thread set.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACTIVE, ThreadSet, type ThreadMsg, type ThreadRef } from "../tab/threads.ts";
import { ThreadRelay } from "../thread-relay.ts";
import type { ThreadsOf } from "../cloud-link.ts";
import type { TeachThread } from "../../04-walks-home/cluster/teach-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "..", "..", "04-walks-home", "cluster", "spike", "spike_plan.ts");

test("D1's real threadsOf output drives the relay and the page's thread set: three threads in plan order, running mid-run, then their results, the settled ones no longer watched", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-spike-"));
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "200"], { encoding: "utf8", timeout: 150_000 });
  assert.equal(r.status, 0, r.stderr);
  const mid = (JSON.parse(readFileSync(join(dir, "mid.json"), "utf8")) as { threads: TeachThread[] }).threads;
  const after = (JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { threads_of: TeachThread[] }).threads_of;
  assert.deepEqual(mid.map((t) => t.name), ["walk", "spin", "wave"]);
  assert.deepEqual(after.map((t) => t.name), ["walk", "spin", "wave"]);

  // threadsOf's own type is what the link takes: no adapter in between.
  const asLink: (list: TeachThread[]) => ThreadRef[] = (list) => list;
  let listing: readonly ThreadRef[] = asLink(mid);
  const sent: ThreadMsg[] = [];
  const stops: number[] = [];
  const watch = async (_h: unknown, id: number) => ({ snapshot: { type: "snapshot", entries: [], tools: [], generation: undefined, run: undefined } as never, start: () => undefined, stop: async () => void stops.push(id) }) as never;
  const relay = new ThreadRelay({} as never, {} as never, async () => listing, (m) => sent.push(m), { watch: watch as never, pollMs: 0 });
  await relay.poll();
  assert.deepEqual(sent.map((m) => [m.conversation, m.name, m.gpu, m.status]), mid.map((t) => [t.conversation, t.name, t.gpu, t.status]), "every thread of the real mid-run listing is followed, once");
  listing = asLink(after);
  await relay.poll();
  await relay.poll();
  assert.deepEqual([...stops].sort(), after.filter((t) => t.settled).map((t) => t.conversation).sort(), "the settled threads' watches end");

  const set = new ThreadSet();
  for (const m of sent) set.apply(m);
  assert.deepEqual(set.list().map((t) => [t.gpu, t.name, t.status]), after.map((t) => [t.gpu, t.name, t.status]));
  assert.equal(set.list().some((t) => ACTIVE.has(t.status)), false, "after the run no thread is shown as working");
  await relay.stop();
});
