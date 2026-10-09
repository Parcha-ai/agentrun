// The demo's story, driven in headless Chrome against a running `serve.ts` (with a cloud host), with timings:
//   1. device A opens the link: the agent's computer boots in the tab; one task writes files.
//   2. a longer task starts; device A's tab closes mid-task (no goodbye, like a laptop lid). The pipe's lease on the tab
//      lapses, the run is released and sealed, and the cloud host claims it and resumes the task.
//   3. device B opens the link: a live read-only view of the cloud run (chat and the disk's files).
//   4. device B takes the run over: the cloud's claim is revoked, the run moves into B's tab, and B finishes.
// Evidence goes to $OUT (default ./story-results.json); screenshots to $SHOTS.
//   node scripts/story.ts <run link> [--skip-takeover]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type Page } from "./cdp.ts";

const link = process.argv[2]!;
const out = process.env.OUT ?? "story-results.json";
const shots = process.env.SHOTS ?? "story-shots";
mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const at = () => Number(((Date.now() - t0) / 1000).toFixed(2));
const results: Record<string, unknown> = { link: link.replace(/#.*/, "#<secret>"), startedAt: new Date().toISOString(), steps: [] as unknown[] };
const step = (name: string, data: Record<string, unknown> = {}) => {
  const row = { at: at(), name, ...data };
  (results.steps as unknown[]).push(row);
  console.log(JSON.stringify(row));
};
let shot = 0;
const snap = async (page: Page, name: string) => page.screenshot(join(shots, `${String(++shot).padStart(2, "0")}-${name}.png`)).catch(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (page: Page, text: string) => page.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);

const TASK_1 = "Create notes/todo.md with three short items for planning a picnic, and a script count.sh that prints how many lines notes/todo.md has. Run it.";
const TASK_2 =
  "Now do this slowly, one tool call per file: write steps/step1.txt through steps/step6.txt, each containing its number spelled out in words. After each file, run `ls steps | wc -l` with bash. When all six exist, write steps/DONE.txt saying which machine you think you ran on (check `uname -a`).";

const cdp = await Cdp.connect();
const devices = [] as Awaited<ReturnType<Cdp["device"]>>[];
try {
  // 1. Device A runs the agent in its tab.
  const a = await cdp.device();
  devices.push(a);
  const pa = await a.open(link);
  await pa.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 500);
  step("A: running in this tab", { computerMs: await pa.evaluate("Math.round(demo.state.computerMs)"), attachMs: await pa.evaluate("Math.round(demo.state.bootMs)") });
  await snap(pa, "a-booted");
  await send(pa, TASK_1);
  await pa.until("demo.state.chat.busy === true", 30_000);
  await pa.until("demo.state.chat.busy === false", 300_000, 1000);
  await sleep(1000);
  step("A: task 1 done", { files: await pa.evaluate("demo.files()") });
  await snap(pa, "a-task1");

  // 2. A longer task; A's tab closes after the second file.
  await send(pa, TASK_2);
  await pa.until("demo.files().filter(f => /^steps\\/step\\d\\.txt$/.test(f)).length >= 2", 300_000, 300);
  const before = {
    files: await pa.evaluate<string[]>("demo.files()"),
    ackedDigest: await pa.evaluate<string>("demo.ackedDigest()"),
    acks: await pa.evaluate<number>("demo.acks()"),
    commits: await pa.evaluate<number>("demo.timings().commit.length"),
  };
  await snap(pa, "a-before-close");
  const closedAt = Date.now();
  await a.close();
  devices.splice(devices.indexOf(a), 1);
  step("A: tab closed mid-task", before);
  results.tabClosedAt = new Date(closedAt).toISOString();
  results.tabBeforeClose = before;

  // 3. Device B watches the cloud run.
  const b = await cdp.device();
  devices.push(b);
  const pb = await b.open(link);
  await pb.until("globalThis.demo && demo.state.mode === 'viewer' && demo.state.placement && demo.state.placement.where === 'cloud' && demo.state.placement.generation", 120_000, 250);
  step("B: watching, running in the cloud", { placement: await pb.evaluate("demo.state.placement") });
  await snap(pb, "b-viewer-cloud");
  await pb.until("demo.files().filter(f => /^steps\\/step\\d\\.txt$/.test(f)).length >= 4", 300_000, 500);
  step("B: the cloud keeps working", { files: await pb.evaluate("demo.files()") });
  await snap(pb, "b-viewer-cloud-progress");

  if (!process.argv.includes("--skip-takeover")) {
    // 4. B takes the run over from the cloud.
    const tb = Date.now();
    await pb.evaluate("document.getElementById('takeover').click(), true");
    await pb.until("demo.state.mode === 'writer'", 120_000, 200);
    step("B: took over, running in this tab", { ms: Date.now() - tb, files: await pb.evaluate("demo.files()"), generation: await pb.evaluate("demo.state.generation") });
    await snap(pb, "b-took-over");
    await pb.until("demo.state.chat.busy === false && demo.files().includes('steps/DONE.txt')", 600_000, 1000).catch(async () => {
      // The cloud may have finished the task before the takeover; then B is idle with DONE.txt already there.
      step("B: waiting for the task ended without DONE.txt", { files: await pb.evaluate("demo.files()") });
    });
    step("B: done", { files: await pb.evaluate("demo.files()"), ackedDigest: await pb.evaluate("demo.ackedDigest()") });
    await snap(pb, "b-done");
    results.chatB = await pb.evaluate("demo.items().map(i => ({ kind: i.kind, id: i.id, name: i.name, status: i.status, text: (i.text || '').slice(0, 160) }))");
    results.entriesB = await pb.evaluate("demo.entries()");
  }
} catch (error) {
  step("failed", { error: (error as Error).message });
  for (const d of devices) for (const p of d.pages) console.log(p.console.slice(-15).join("\n"));
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`);
  for (const d of devices) await d.close().catch(() => undefined);
  cdp.close();
}
