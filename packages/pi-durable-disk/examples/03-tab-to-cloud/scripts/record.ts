// Record the story as a video: two devices side by side (a laptop, then another device), under a strip that shows who
// holds the run's disk, driven in headless Chrome against a running `serve.ts --cloud ...` whose log is `serverLog`.
//   node scripts/record.ts <run link> <server log> [--out DIR] [--ffmpeg BIN] [--kill ADMIN_TOKEN_FILE]
// With --kill, the cloud machine is powered off mid-task while the other device watches, and another one resumes.
// Writes DIR/frames/{ops,a,b}/<ms>.jpg, DIR/story.json (steps and timings) and DIR/tab-to-cloud.mp4 (when ffmpeg is given).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Cdp, type Page } from "./cdp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string", default: "recording" }, ffmpeg: { type: "string" }, kill: { type: "string" } } });
const [link, serverLog] = positionals as [string, string];
const out = values.out!;
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const sec = () => Number(((Date.now() - t0) / 1000).toFixed(2));
const steps: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANE = { width: 960, height: 860 };
const OPS = { width: 1920, height: 220 };
const slate = (title: string, sub: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1d1d1b;color:#ecebe6;font:16px -apple-system,system-ui,sans-serif"><div style="text-align:center"><div style="font-size:30px;font-weight:650">${title}</div><div style="margin-top:10px;color:#9a9890">${sub}</div></div></body></html>`)}`;

/** Every frame Chrome paints for a page, as JPEG files named by their time in ms since the recording started. */
async function screencast(page: Page, dir: string): Promise<() => Promise<void>> {
  mkdirSync(dir, { recursive: true });
  let count = 0;
  page.cdp.on("Page.screencastFrame", (params, session) => {
    if (session !== page.sessionId) return;
    const meta = params.metadata as { timestamp?: number };
    const at = meta.timestamp ? Math.round(meta.timestamp * 1000 - t0) : Date.now() - t0;
    writeFileSync(join(dir, `${String(Math.max(0, at)).padStart(8, "0")}.jpg`), Buffer.from(String(params.data), "base64"));
    count++;
    void page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
  });
  await page.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
  // A navigation can move the page to another renderer, which ends its screencast: start it again after each one.
  const navigate = page.navigate.bind(page);
  page.navigate = async (url: string) => {
    await navigate(url);
    await page.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 }).catch(() => undefined);
  };
  return async () => {
    await page.send("Page.stopScreencast").catch(() => undefined);
    steps.push({ at: sec(), name: `frames ${dir}`, count });
  };
}

const label = (page: Page, text: string) =>
  page.evaluate(`(() => { let el = document.getElementById("device-label"); if (!el) { el = document.createElement("div"); el.id = "device-label"; el.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9;background:#1d1d1b;color:#ecebe6;font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:8px;opacity:.88"; document.body.append(el); } el.textContent = ${JSON.stringify(text)}; return true; })()`).catch(() => false);
const say = (ops: Page, title: string, sub = "") => {
  steps.push({ at: sec(), name: title, sub });
  console.log(JSON.stringify({ at: sec(), step: title, sub }));
  return ops.evaluate(`ops.step(${JSON.stringify(title)}, ${JSON.stringify(sub)})`).catch(() => undefined);
};
const send = (page: Page, text: string) => page.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);

/** Follow the server's log and show who holds the disk. */
function followHolders(ops: Page, tabs: Map<string, string>): () => void {
  let offset = existsSync(serverLog) ? statSync(serverLog).size : 0;
  let generation = 0;
  const timer = setInterval(() => {
    const text = readFileSync(serverLog, "utf8");
    const fresh = text.slice(offset);
    offset = text.length;
    for (const line of fresh.split("\n")) {
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line) as Record<string, unknown>;
      let call: string | undefined;
      if (e.event === "pipe.open") generation = Number(e.generation);
      if (e.event === "pipe.attach") call = `ops.holder("tab", ${JSON.stringify(`Tab on ${tabs.get(String(e.tab)) ?? "a device"}`)}, ${JSON.stringify(`generation ${generation} · the pipe holds the claim`)})`;
      else if (e.event === "placement" && e.where === "moving") call = `ops.holder("moving", ${JSON.stringify(e.to === "cloud" ? "Moving to the cloud" : "Moving into a tab")}, ${JSON.stringify(String(e.detail ?? ""))})`;
      else if (e.event === "pipe.released") call = `ops.note(${JSON.stringify(`released and sealed in ${e.ms} ms`)})`;
      else if (e.event === "cloud.started") call = `ops.holder("cloud", ${JSON.stringify(String(e.host))}, ${JSON.stringify(`generation ${generation + 1} · claimed the disk, resuming`)})`;
      else if (e.event === "cloud.exited") call = `ops.holder("fenced", "Cloud host fenced", ${JSON.stringify(`its claim revoked · ${String(e.unit ?? e.status)}`)})`;
      if (call) void ops.evaluate(call).catch(() => undefined);
    }
  }, 300);
  return () => clearInterval(timer);
}

const cdp = await Cdp.connect();
const opsDevice = await cdp.device();
const a = await cdp.device();
const b = await cdp.device();
const stops: (() => Promise<void>)[] = [];
let unfollow = () => undefined as void;
try {
  const ops = await opsDevice.open(`file://${join(here, "ops-page.html")}`, OPS);
  stops.push(await screencast(ops, join(out, "frames", "ops")));
  const pa = await a.open(slate("Laptop", "opening the link…"), PANE);
  stops.push(await screencast(pa, join(out, "frames", "a")));
  const pb = await b.open(slate("Another device", "not open yet"), PANE);
  stops.push(await screencast(pb, join(out, "frames", "b")));
  const tabs = new Map<string, string>();
  unfollow = followHolders(ops, tabs);

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
  const endMs = Date.now() - t0;
  writeFileSync(join(out, "story.json"), `${JSON.stringify({ startedAt: new Date(t0).toISOString(), endMs, steps }, null, 1)}\n`);
  for (const d of [opsDevice, a, b]) await d.close().catch(() => undefined);
  cdp.close();
  if (values.ffmpeg) assemble(values.ffmpeg, endMs);
}

/** One video per stream (each frame shown until the next), then the strip on top of the two panes. */
function assemble(ffmpeg: string, endMs: number): void {
  const streams: [string, { width: number; height: number }][] = [["ops", OPS], ["a", PANE], ["b", PANE]];
  for (const [name, size] of streams) {
    const dir = join(out, "frames", name);
    const frames = spawnSync("ls", [dir], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.endsWith(".jpg")).sort();
    if (frames.length === 0) throw new Error(`no frames for ${name}`);
    const times = frames.map((f) => Number(f.slice(0, -4)));
    const lines: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const from = i === 0 ? 0 : times[i]!;
      const to = i + 1 < frames.length ? times[i + 1]! : endMs;
      lines.push(`file '${join(dir, frames[i]!)}'`, `duration ${Math.max(0.001, (to - from) / 1000).toFixed(3)}`);
    }
    lines.push(`file '${join(dir, frames.at(-1)!)}'`);
    writeFileSync(join(out, `${name}.txt`), `${lines.join("\n")}\n`);
    const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(out, `${name}.txt`), "-vf", `fps=15,scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", join(out, `${name}.mp4`)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
  }
  const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", join(out, "ops.mp4"), "-i", join(out, "a.mp4"), "-i", join(out, "b.mp4"), "-filter_complex", "[1:v][2:v]hstack=inputs=2[ab];[0:v][ab]vstack=inputs=2,fps=15[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", join(out, "tab-to-cloud.mp4")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg compose: ${r.stderr}`);
  console.log(JSON.stringify({ video: join(out, "tab-to-cloud.mp4"), seconds: endMs / 1000 }));
}
