// Record the switch as a video: one page, under the strip that shows who holds the run's disk, driven in headless
// Chrome against a running `serve.ts --cloud daytona` whose log is `serverLog`. The agent is asked where it runs in
// the tab, switched to each cloud environment and asked again, then switched back into the tab and asked once more.
//   node scripts/record-switch.ts <run link> <server log> [--out DIR] [--ffmpeg BIN] [--envs daytona-basic,daytona-gpu]
// Writes DIR/frames/{ops,page}/<ms>.jpg, DIR/story.json (steps and timings) and DIR/switch.mp4 (when ffmpeg is given).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Cdp, type Page } from "./cdp.ts";
import { followHolders, label, Recording, send, slate } from "./recording.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string", default: "recording" }, ffmpeg: { type: "string" }, envs: { type: "string", default: "daytona-basic" } } });
const [link, serverLog] = positionals as [string, string];
const rec = new Recording(values.out!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAGE = { width: 1600, height: 900 };
const OPS = { width: 1600, height: 200 };

const QUESTIONS: Record<string, string> = {
  tab: "Where are you running right now? Check with bash (uname -a, nproc, and nvidia-smi if it exists), then answer in two short lines.",
  "daytona-basic": "And now? Same check, two short lines.",
  "daytona-gpu": "Run nvidia-smi and tell me in two short lines what machine this is.",
  back: "And now? Same check, two short lines.",
};

const say = (ops: Page, title: string, sub = "") => {
  rec.step(title, { sub });
  return ops.evaluate(`ops.step(${JSON.stringify(title)}, ${JSON.stringify(sub)})`).catch(() => undefined);
};

/** Ask, then wait for a finished answer after everything there is now. */
async function ask(page: Page, text: string): Promise<string> {
  const before = await page.evaluate<number>("demo.items().length");
  await send(page, text);
  await page.until(`demo.items().slice(${before}).some(i => i.kind === "user")`, 60_000, 200);
  const done = `(() => { const items = demo.items().slice(${before}); const u = items.findIndex(i => i.kind === "user"); const rest = items.slice(u + 1); const a = rest.filter(i => i.kind === "assistant"); const last = a.at(-1); return !demo.state.chat.busy && last && !last.streaming && last.text.length > 0 && !rest.some(i => i.kind === "tool" && i.status === "running"); })()`;
  await page.until(done, 300_000, 400);
  return page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`);
}

/** Click an environment in the switcher; resolves with the handover the page measured (click to notice on screen). */
async function switchTo(page: Page, env: string): Promise<number> {
  const n = await page.evaluate<number>("demo.handovers().length");
  await page.evaluate(`document.querySelector('#switcher [data-env="${env}"]').click(), true`);
  await page.until(`demo.handovers().length > ${n}`, 600_000, 100);
  return page.evaluate<number>("demo.handovers().at(-1).ms");
}

const cdp = await Cdp.connect();
const opsDevice = await cdp.device();
const device = await cdp.device();
const stops: (() => Promise<void>)[] = [];
let unfollow = () => undefined as void;
try {
  const ops = await opsDevice.open(`file://${join(here, "ops-page.html")}`, OPS);
  stops.push(await rec.screencast(ops, "ops"));
  const page = await device.open(slate("Your browser", "opening the link…"), PAGE);
  stops.push(await rec.screencast(page, "page"));
  const tabs = new Map<string, string>();
  unfollow = followHolders(ops, serverLog, tabs);

  await say(ops, "Open the link", "the agent's whole computer starts in the tab: pi in page JavaScript, bash and node in Wasmer");
  await page.navigate(link);
  tabs.set(await page.until<string>("sessionStorage.getItem('tab-id')", 30_000, 50), "your browser");
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 300);
  await label(page, "Your browser");
  await say(ops, "Running in this tab", `computer ready in ${((await page.evaluate<number>("demo.state.computerMs")) / 1000).toFixed(1)} s · attached to the disk in ${Math.round(await page.evaluate<number>("demo.state.bootMs"))} ms`);
  await sleep(1200);
  rec.step("tab answer", { answer: await ask(page, QUESTIONS.tab!) });
  await sleep(2000);

  for (const env of values.envs!.split(",").filter(Boolean)) {
    const name = await page.evaluate<string>(`demo.state.environments.find(e => e.id === ${JSON.stringify(env)}).label`);
    await say(ops, `Switch to ${name}`, "the agent finishes its step where it is and lets go of the disk; the next machine takes it and tells the agent where it is now");
    const ms = await switchTo(page, env);
    await say(ops, `Running in ${name}`, `moved in ${(ms / 1000).toFixed(1)} s, from the click to the agent's notice on screen`);
    rec.step(`switched to ${env}`, { ms: Math.round(ms), notice: await page.evaluate(`demo.items().filter(i => i.kind === "switch").at(-1).text`) });
    await sleep(1500);
    rec.step(`${env} answer`, { answer: await ask(page, QUESTIONS[env] ?? QUESTIONS["daytona-basic"]!) });
    await sleep(2000);
  }

  await say(ops, "Switch back to this tab", "the sandbox drains and releases; the tab claims the disk and restores the workspace");
  const ms = await switchTo(page, "tab");
  await page.until("demo.state.mode === 'writer'", 60_000, 200);
  await label(page, "Your browser");
  await say(ops, "Running in this tab again", `moved in ${(ms / 1000).toFixed(1)} s, from the click to the agent's notice on screen`);
  rec.step("switched to tab", { ms: Math.round(ms) });
  await sleep(1500);
  rec.step("tab again answer", { answer: await ask(page, QUESTIONS.back!) });
  await say(ops, "One agent, every machine", "one transcript, one workspace, one writer at a time; each move is a notice the agent keeps");
  rec.step("end", { handovers: await page.evaluate("demo.handovers()"), notices: await page.evaluate("demo.items().filter(i => i.kind === 'switch').length") });
  await sleep(4000);
} catch (error) {
  rec.step("failed", { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  unfollow();
  for (const stop of stops) await stop();
  rec.save();
  for (const d of [opsDevice, device]) await d.close().catch(() => undefined);
  cdp.close();
  if (values.ffmpeg) rec.assemble(values.ffmpeg, [["ops", OPS], ["page", PAGE]], "[0:v][1:v]vstack=inputs=2,fps=15[v]", "switch.mp4");
}
