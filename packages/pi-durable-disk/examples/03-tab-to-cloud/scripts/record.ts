// Record the story as a video: two devices side by side (a laptop, then another device), under a strip that shows who
// holds the run's disk, driven in headless Chrome against a running `serve.ts --cloud ...` whose log is `serverLog`.
//   node scripts/record.ts <run link> <server log> [--out DIR] [--ffmpeg BIN] [--kill ADMIN_TOKEN_FILE]
// With --kill, the cloud machine is powered off mid-task while the other device watches, and another one resumes.
// Writes DIR/frames/{ops,a,b}/<ms>.jpg, DIR/story.json (steps and timings) and DIR/tab-to-cloud.mp4 (when ffmpeg is given).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Cdp, type Page } from "./cdp.ts";
import { followHolders, label, Recording, send, slate } from "./recording.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string", default: "recording" }, ffmpeg: { type: "string" }, kill: { type: "string" } } });
const [link, serverLog] = positionals as [string, string];
const rec = new Recording(values.out!);
const sec = () => rec.sec();
const steps = rec.steps;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANE = { width: 960, height: 860 };
const OPS = { width: 1920, height: 220 };

const say = (ops: Page, title: string, sub = "") => {
  rec.step(title, { sub });
  return ops.evaluate(`ops.step(${JSON.stringify(title)}, ${JSON.stringify(sub)})`).catch(() => undefined);
};

const cdp = await Cdp.connect();
const opsDevice = await cdp.device();
const a = await cdp.device();
const b = await cdp.device();
const stops: (() => Promise<void>)[] = [];
let unfollow = () => undefined as void;
try {
  const ops = await opsDevice.open(`file://${join(here, "ops-page.html")}`, OPS);
  stops.push(await rec.screencast(ops, "ops"));
  const pa = await a.open(slate("Laptop", "opening the link…"), PANE);
  stops.push(await rec.screencast(pa, "a"));
  const pb = await b.open(slate("Another device", "not open yet"), PANE);
  stops.push(await rec.screencast(pb, "b"));
  const tabs = new Map<string, string>();
  unfollow = followHolders(ops, serverLog, tabs);

  // 1. The laptop opens the link: the agent's computer boots in the tab.
  await say(ops, "1 · Open the link on a laptop", "the agent's whole computer starts in the tab: pi in page JavaScript, bash and node in Wasmer");
  await pa.navigate(link);
  tabs.set(await pa.until<string>("sessionStorage.getItem('tab-id')", 30_000, 50), "the laptop");
  await pa.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 300);
  await label(pa, "Laptop");
  await say(ops, "1 · Running in this tab", `computer ready in ${(await pa.evaluate<number>("demo.state.computerMs") / 1000).toFixed(1)} s · attached to the disk in ${Math.round(await pa.evaluate<number>("demo.state.bootMs"))} ms`);
  await sleep(1500);
  await send(pa, "Write a four-line poem about clouds to poem.md. Then write count.js, a node script that prints how many words poem.md has, and run it.");
  await pa.until("demo.state.chat.busy === false && demo.files().includes('count.js')", 300_000, 500);
  await say(ops, "1 · It writes files", "each tool's files are on the disk before its result is committed");
  await sleep(2500);

  // 2. A longer task; the laptop's lid closes mid-task.
  await send(pa, "Now build a tiny static site, one file per tool call: site/index.html, site/style.css, site/about.html, site/contact.html, and site/build.js (node) that lists the pages into site/pages.json; run build.js last. After each file, run `ls site` with bash.");
  await pa.until("demo.files().filter(f => f.startsWith('site/')).length >= 2", 300_000, 300);
  await say(ops, "2 · Close the laptop", "the tab disappears mid-task, with no goodbye");
  const before = { files: await pa.evaluate<string[]>("demo.files()"), ackedDigest: await pa.evaluate<string>("demo.ackedDigest()") };
  steps.push({ at: sec(), name: "laptop closed", ...before });
  await pa.navigate(slate("Laptop", "lid closed: the tab is gone"));
  await sleep(5000);
  await say(ops, "2 · The tab's lease lapses", "the pipe releases the run, sealed; a cloud host claims the disk and resumes mid-task");

  // 3. Another device opens the link: a live, read-only view of the cloud.
  await sleep(4000);
  await say(ops, "3 · Open the link on another device", "it watches the cloud run live: the chat, and the files on the disk");
  await pb.navigate(link);
  tabs.set(await pb.until<string>("sessionStorage.getItem('tab-id')", 30_000, 50), "the other device");
  await pb.until("globalThis.demo && demo.state.mode === 'viewer' && demo.state.placement && demo.state.placement.where === 'cloud' && demo.state.placement.generation", 180_000, 300);
  await label(pb, "Another device");
  if (values.kill) {
    // Optional: pull the plug on the cloud machine mid-task; the supervisor finds its claim orphaned and another
    // machine claims the disk and continues.
    await pb.until("demo.files().filter(f => f.startsWith('site/')).length >= 3", 300_000, 500);
    await say(ops, "3 · Pull the plug on the cloud machine", "its instance and its disk client die together, mid-task");
    const token = readFileSync(values.kill, "utf8").trim();
    const run = new URL(link).pathname.split("/").pop();
    const origin = new URL(link).origin;
    const killedAt = Date.now();
    const r = await fetch(`${origin}/admin/kill-cloud?run=${run}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    steps.push({ at: sec(), name: "cloud killed", status: r.status });
    const before = await pb.evaluate<number>("demo.state.placement && demo.state.placement.generation || 0");
    await pb.until(`demo.state.placement && demo.state.placement.where === 'cloud' && demo.state.placement.generation > ${before}`, 120_000, 250);
    steps.push({ at: sec(), name: "cloud replaced", ms: Date.now() - killedAt, placement: await pb.evaluate("demo.state.placement") });
    await say(ops, "3 · Another machine took over", `${((Date.now() - killedAt) / 1000).toFixed(1)} s after the power cut: the claim was orphaned, revoked, and re-taken; the task goes on`);
  }
  await pb.until("demo.files().filter(f => f.startsWith('site/')).length >= 4", 300_000, 500);
  await sleep(2000);

  // 4. Take over here: the run moves into this tab; the cloud host is fenced.
  await say(ops, "4 · Take over here", "the cloud's claim is revoked; its next write fails at the disk, and it stops");
  const tTake = Date.now();
  await pb.evaluate("document.getElementById('takeover').click(), true");
  await pb.until("demo.state.mode === 'writer'", 120_000, 200);
  await label(pb, "Another device");
  steps.push({ at: sec(), name: "takeover", ms: Date.now() - tTake });
  await say(ops, "4 · Running in this tab again", `moved in ${((Date.now() - tTake) / 1000).toFixed(1)} s · the files the cloud wrote came back from the disk`);
  await pb.until("demo.state.chat.busy === false && demo.files().includes('site/pages.json')", 600_000, 1000).catch(() => undefined);
  await sleep(1500);
  await send(pb, "Which files are in your workspace now? One line each.");
  await pb.until("demo.state.chat.busy === true", 30_000).catch(() => undefined);
  await pb.until("demo.state.chat.busy === false", 300_000, 1000).catch(() => undefined);
  await say(ops, "One agent, three machines", "a laptop tab, a cloud host, another tab: one transcript, one workspace, one writer at a time");
  steps.push({ at: sec(), name: "end", files: await pb.evaluate("demo.files()"), ackedDigest: await pb.evaluate("demo.ackedDigest()") });
  await sleep(4000);
} catch (error) {
  steps.push({ at: sec(), name: "failed", error: (error as Error).message });
  console.log(JSON.stringify({ failed: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 6) }));
  process.exitCode = 1;
} finally {
  unfollow();
  for (const stop of stops) await stop();
  rec.save();
  for (const d of [opsDevice, a, b]) await d.close().catch(() => undefined);
  cdp.close();
  if (values.ffmpeg) rec.assemble(values.ffmpeg, [["ops", OPS], ["a", PANE], ["b", PANE]], "[1:v][2:v]hstack=inputs=2[ab];[0:v][ab]vstack=inputs=2,fps=15[v]", "tab-to-cloud.mp4");
}
