// The agent moves itself, driven in headless Chrome against a running `serve.ts --cloud-module 04-walks-home/vm/cloud-module.ts`: one page runs the agent in its
// tab, the user asks for something the tab cannot do, the agent calls switch_environment on its own, and the rest of the task
// is answered from the new computer. The move is timed from the agent's tool call to the notice on screen.
//   node scripts/agent-switch-smoke.ts <run link> [environment id, default modal-vm]
// Evidence goes to $OUT (default ./agent-switch-results.json); screenshots to $SHOTS.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type Page } from "../../../03-tab-to-cloud/scripts/cdp.ts";

const link = process.argv[2]!;
const target = process.argv[3] ?? "modal-vm";
const out = process.env.OUT ?? "agent-switch-results.json";
const shots = process.env.SHOTS ?? "agent-switch-shots";
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

const TASK = `This tab is a small WebAssembly computer. I need to know what a real Linux machine looks like, and you cannot see one from here. Move yourself with your switch_environment tool to ${target}, giving a one-sentence reason. Once you are there, run uname -a and nproc with bash, tell me which machine you are on in two short lines, and say whether you moved yourself or I did.`;

const cdp = await Cdp.connect();
const device = await cdp.device();
try {
  const page = await device.open(link);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 500);
  step("running in this tab", { environments: await page.evaluate("demo.state.environments.map(e => e.id)") });
  const before = await page.evaluate<number>("demo.items().length");
  await send(page, TASK);
  await page.until(`demo.items().slice(${before}).some(i => i.kind === "tool" && /switch_environment/.test(i.name ?? i.args ?? ""))`, 120_000, 100);
  const tCall = Date.now();
  step("the agent called switch_environment", { args: await page.evaluate(`demo.items().slice(${before}).filter(i => i.kind === "tool").map(i => (i.name ?? "") + " " + (i.args ?? "").slice(0, 200))`) });
  await page.until(`demo.items().slice(${before}).some(i => i.kind === "switch")`, 180_000, 100);
  const notice = await page.evaluate<string>(`demo.items().filter(i => i.kind === "switch").at(-1).text`);
  step("the notice on screen", { ms: Date.now() - tCall, notice });
  await snap(page, "notice");
  const answered = `(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); const a = items.slice(s + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return s >= 0 && !demo.state.chat.busy && last && !last.streaming && last.text.length > 0; })()`;
  await page.until(answered, 300_000, 500);
  const answer = await page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`);
  step("answered from the new computer", { answer, placement: await page.evaluate("demo.state.placement") });
  await snap(page, "answer");
  results.items = await page.evaluate("demo.items().map(i => ({ kind: i.kind, text: (i.text ?? i.args ?? '').slice(0, 400) }))");
} catch (error) {
  step("failed", { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  writeFileSync(out, JSON.stringify(results, null, 2));
  await device.close().catch(() => undefined);
  cdp.close();
}
