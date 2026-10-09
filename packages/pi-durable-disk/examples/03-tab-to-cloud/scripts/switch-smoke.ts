// The switch, driven in headless Chrome against a running `serve.ts` with a cloud host: one page runs the agent, asks
// it where it runs, switches it to a cloud environment, asks again, switches it back into the tab, asks again. Each
// switch is timed from the click to the agent's notice of the move on screen. Evidence goes to $OUT (default
// ./switch-results.json); screenshots to $SHOTS.
//   node scripts/switch-smoke.ts <run link> <cloud environment id> [--back]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type Page } from "./cdp.ts";

const link = process.argv[2]!;
const target = process.argv[3] ?? "local";
const back = process.argv.includes("--back");
const out = process.env.OUT ?? "switch-results.json";
const shots = process.env.SHOTS ?? "switch-shots";
mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const at = () => Number(((Date.now() - t0) / 1000).toFixed(2));
const results: Record<string, unknown> = { link: link.replace(/#.*/, "#<secret>"), target, startedAt: new Date().toISOString(), steps: [] as unknown[] };
const step = (name: string, data: Record<string, unknown> = {}) => {
  const row = { at: at(), name, ...data };
  (results.steps as unknown[]).push(row);
  console.log(JSON.stringify(row));
};
let shot = 0;
const snap = async (page: Page, name: string) => page.screenshot(join(shots, `${String(++shot).padStart(2, "0")}-${name}.png`)).catch(() => undefined);
const send = (page: Page, text: string) => page.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);

const QUESTION = "Which machine are you on right now? Check with bash (uname -a, nproc, and nvidia-smi if it exists) and answer in two short lines.";

/** Ask, then wait for a finished answer after every item there is now. */
async function ask(page: Page, label: string): Promise<string> {
  const before = await page.evaluate<number>("demo.items().length");
  await send(page, QUESTION);
  await page.until(`demo.items().length > ${before} && demo.items().slice(${before}).some(i => i.kind === "user")`, 30_000, 200);
  const answered = `(() => { const items = demo.items().slice(${before}); const u = items.findIndex(i => i.kind === "user"); const a = items.slice(u + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return !demo.state.chat.busy && last && !last.streaming && last.text.length > 0 && !items.slice(u + 1).some(i => i.kind === "tool" && i.status === "running"); })()`;
  await page.until(answered, 240_000, 500);
  const answer = await page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`);
  const tools = await page.evaluate<string[]>(`demo.items().slice(${before}).filter(i => i.kind === "tool").map(i => i.args.slice(0, 120))`);
  step(`${label}: answered`, { answer, tools });
  return answer;
}

async function switchTo(page: Page, env: string, label: string): Promise<number> {
  const n = await page.evaluate<number>("demo.handovers().length");
  await page.evaluate(`demo.switchTo(${JSON.stringify(env)})`);
  await page.until(`demo.handovers().length > ${n}`, 120_000, 100);
  const handover = await page.evaluate<{ switchId: string; to: string; ms: number }>("demo.handovers().at(-1)");
  const notice = await page.evaluate<string>(`demo.items().filter(i => i.kind === "switch").at(-1).text`);
  step(`${label}: switched`, { ...handover, ms: Math.round(handover.ms), notice });
  return handover.ms;
}

const cdp = await Cdp.connect();
const device = await cdp.device();
try {
  const page = await device.open(link);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 500);
  step("running in this tab", { computerMs: await page.evaluate("Math.round(demo.state.computerMs)"), attachMs: await page.evaluate("Math.round(demo.state.bootMs)"), environments: await page.evaluate("demo.state.environments.map(e => e.id)") });
  await ask(page, "tab");
  await snap(page, "tab-answer");

  await switchTo(page, target, `to ${target}`);
  await page.until("demo.state.mode === 'viewer' && demo.state.placement && demo.state.placement.where === 'cloud'", 60_000, 200);
  await snap(page, "cloud-notice");
  await ask(page, target);
  await snap(page, "cloud-answer");

  if (back) {
    await switchTo(page, "tab", "back to the tab");
    await page.until("demo.state.mode === 'writer'", 60_000, 200);
    await snap(page, "tab-notice");
    await ask(page, "tab again");
    await snap(page, "tab-again-answer");
  }
  results.handovers = await page.evaluate("demo.handovers()");
  results.items = await page.evaluate("demo.items().map(i => ({ kind: i.kind, text: (i.text ?? i.args ?? '').slice(0, 300), ...(i.switchId ? { switchId: i.switchId } : {}) }))");
} catch (error) {
  step("failed", { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  writeFileSync(out, JSON.stringify(results, null, 2));
  await device.close().catch(() => undefined);
  cdp.close();
}
