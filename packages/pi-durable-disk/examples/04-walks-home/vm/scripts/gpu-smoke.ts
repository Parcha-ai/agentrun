// The agent trains on a GPU and comes home, driven in headless Chrome against a running `serve.ts --cloud-module ... --cloud-arg gpu-image=...`:
// the user asks for a trained walker, the agent moves itself to the GPU machine, runs the training command its notice gives, and
// when the policy file exists moves home to the tab that is watching the run. Checked from the tab's side: the policy is in the
// tab's workspace after the move home. Moves are timed from the agent's tool call to the notice on screen.
//   node scripts/gpu-smoke.ts <run link> [environment id, default modal-gpu]
// Evidence goes to $OUT (default ./gpu-results.json); screenshots to $SHOTS.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type Page } from "../../../03-tab-to-cloud/scripts/cdp.ts";

const link = process.argv[2]!;
const target = process.argv[3] ?? "modal-gpu";
const out = process.env.OUT ?? "gpu-results.json";
const shots = process.env.SHOTS ?? "gpu-shots";
const POLICY = process.env.POLICY ?? "train/gpu/policy.json";
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

const TASK = `I want a walking creature trained. This tab cannot train anything. Move yourself with your switch_environment tool to ${target} (one-sentence reason), run the training command that your notice there gives you, and wait for it to finish. When ${POLICY} exists, check its size with bash, then move home with switch_environment (target "tab", a one-sentence reason). Once you are home, tell me in two short lines where you trained and how big the policy file is.`;

const cdp = await Cdp.connect();
const device = await cdp.device();
try {
  const page = await device.open(link);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 500);
  step("running in this tab", { environments: await page.evaluate("demo.state.environments.map(e => e.id)") });
  const before = await page.evaluate<number>("demo.items().length");
  await send(page, TASK);
  const switches = (kind: string) => `demo.items().slice(${before}).filter(i => i.kind === ${JSON.stringify(kind)})`;
  await page.until(`${switches("tool")}.some(i => /switch_environment/.test(i.name ?? i.args ?? ""))`, 180_000, 100);
  const tOut = Date.now();
  step("the agent called switch_environment to the GPU", { args: await page.evaluate(`${switches("tool")}.filter(i => /switch_environment/.test(i.name ?? i.args ?? "")).map(i => (i.args ?? "").slice(0, 200))`) });
  await page.until(`${switches("switch")}.length >= 1`, 300_000, 100);
  step("the notice on screen", { ms: Date.now() - tOut, notice: await page.evaluate<string>(`${switches("switch")}.at(0).text`) });
  await snap(page, "gpu-notice");
  // The training runs on the GPU box; the tab watches. Home is the next switch notice.
  const tTrain = Date.now();
  await page.until(`${switches("switch")}.length >= 2`, 1_200_000, 500);
  const tHome = Date.now();
  step("home: the notice on screen", { trainedForMs: tHome - tTrain, notice: await page.evaluate<string>(`${switches("switch")}.at(1).text`) });
  await page.until("demo.state.mode === 'writer'", 120_000, 200);
  await snap(page, "home");
  const files = await page.evaluate<string[]>("demo.files()");
  step("the tab's workspace", { hasPolicy: files.includes(POLICY), files: files.filter((f) => f.startsWith("train/")).slice(0, 12) });
  const answered = `(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); const a = items.slice(s + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return s >= 0 && !demo.state.chat.busy && last && !last.streaming && last.text.length > 0; })()`;
  await page.until(answered, 300_000, 500);
  step("answered at home", { answer: await page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`), ms: Date.now() - tOut });
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
