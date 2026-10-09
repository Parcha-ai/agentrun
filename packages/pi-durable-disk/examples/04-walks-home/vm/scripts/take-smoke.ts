// The whole beat, driven in headless Chrome against a running `serve.ts --cloud-module ... --cloud-arg desktop=true --cloud-arg gpu-image=...`:
// the user says it once in the tab's chat and the agent decides every move: tab -> the Modal VM (a desktop it drives, showing the
// creature's body.json), -> the Modal GPU (it trains with the command its notice gives), -> home to the tab, where it says its closing
// words after the notice. Each move is timed from the agent's tool call to the notice on screen. The creature's files must be in the
// run's workspace (the creature tab writes them; `scripts/seed-creature.ts` does for a rehearsal).
//   node scripts/take-smoke.ts <run link>
// Evidence goes to $OUT (default ./take-results.json); screenshots to $SHOTS.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModalClient } from "modal";
import { SCREENSHOT_COMMAND } from "../desktop.ts";
import { Cdp, type Page } from "../../../03-tab-to-cloud/scripts/cdp.ts";

const link = process.argv[2]!;

const out = process.env.OUT ?? "take-results.json";
const shots = process.env.SHOTS ?? "take-shots";

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
const send = (page: Page, text: string) => page.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);

const POLICY_HOME = "home/policy.json";
const TASK = `I just sketched a creature: its files are in your workspace under creature/. This tab cannot show me a real browser or train anything, so do all of this yourself, in one go, without waiting for me between steps. Step 1: move yourself with your switch_environment tool to modal-vm (one-sentence reason). As soon as you arrive, with your computer tool: write creature.html in your workspace, a page that reads creature/body.json and draws on a canvas, in very large type, the number of legs, the joints per leg and the stand height; serve the workspace on port 8099 with python3 -m http.server, detached; open http://localhost:8099/creature.html in Chromium on the desktop and take a screenshot. No scrolling. Step 2: move yourself with switch_environment to modal-gpu (one-sentence reason); as soon as you arrive, run the training command that your notice there gives you. Step 3: when ${POLICY_HOME} exists, move home with switch_environment (target "tab", a one-sentence reason). Do not write any closing words until you are home and have read the notice there; then tell me in two short lines where you went and what you trained.`;

let dumpPage: () => Promise<void> = async () => undefined;
const cdp = await Cdp.connect();
const device = await cdp.device();
try {
  const page = await device.open(link);
  dumpPage = async () => {
    results.items = await page.evaluate("demo.items().map(i => ({ kind: i.kind, status: i.status, text: (i.text ?? i.args ?? '').slice(0, 300), out: String(i.output ?? '').slice(0, 300) }))");
    results.state = await page.evaluate("({ mode: demo.state.mode, busy: demo.state.chat.busy, placement: demo.state.placement, progress: demo.state.progress })");
    await snap(page, "failure");
  };
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 240_000, 500);
  step("running in this tab", { environments: await page.evaluate("demo.state.environments.map(e => e.id)") });
  const before = await page.evaluate<number>("demo.items().length");
  await send(page, TASK);
  const switches = (kind: string) => `demo.items().slice(${before}).filter(i => i.kind === ${JSON.stringify(kind)})`;
  const moves = (n: number) => `${switches("switch")}.length >= ${n}`;
  const tools = (re: string) => `${switches("tool")}.filter(i => /${re}/.test(i.name ?? i.args ?? "")).length`;
  const tStart = Date.now();
  for (const [n, where] of [[1, "the Modal VM"], [2, "the Modal GPU"], [3, "home"]] as const) {
    await page.until(`${tools("switch_environment")} >= ${n}`, 900_000, 100);
    const tCall = Date.now();
    step(`the agent called switch_environment (${where})`, { args: await page.evaluate(`${switches("tool")}.filter(i => /switch_environment/.test(i.name ?? i.args ?? "")).at(${n - 1}).args.slice(0, 220)`) });
    await page.until(moves(n), 600_000, 100);
    step(`${where}: the notice on screen`, { ms: Date.now() - tCall, notice: (await page.evaluate<string>(`${switches("switch")}.at(${n - 1}).text`)).slice(0, 360) });
    await snap(page, `notice-${n}`);
    if (n === 1) {
      await page.until(`${tools("computer")} >= 1`, 300_000, 200);
      step("on the VM desktop: the agent drives it", { computerCalls: await page.evaluate<number>(tools("computer")) });
      // What the desktop shows, taken from outside the agent (MODAL_TOKEN_* in the environment): the creature page, as the stage will see it.
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const modal = new ModalClient();
        const app = await modal.apps.fromName(process.env.MODAL_APP ?? "pda-demo-d4", { createIfMissing: false });
        for await (const sb of modal.sandboxes.list({ appId: app.appId, tags: {} })) {
          const p = await sb.exec(["bash", "-c", `${SCREENSHOT_COMMAND} | base64 -w0`], { timeoutMs: 30_000 });
          const jpeg = Buffer.from((await p.stdout.readText()).trim(), "base64");
          writeFileSync(join(shots, "vm-desktop-creature.jpg"), jpeg);
          step("the VM's desktop, from outside", { jpegBytes: jpeg.length });
          break;
        }
      } catch (error) {
        step("desktop screenshot failed", { error: (error as Error).message });
      }
    }
  }
  await page.until("demo.state.mode === 'writer'", 120_000, 200);
  const files = await page.evaluate<string[]>("demo.files()");
  step("the tab's workspace", { hasPolicy: files.includes(POLICY_HOME), creatureHtml: files.includes("creature.html") });
  // The story ends at home: the closing words come after the notice the agent gets there (it was asked to wait for it).
  const answered = `(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); const a = items.slice(s + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return s >= 0 && demo.state.mode === "writer" && !demo.state.chat.busy && last && !last.streaming && last.text.length > 0; })()`;
  await page.until(answered, 300_000, 500);
  step("answered at home", { answer: await page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`), totalMs: Date.now() - tStart });
  await snap(page, "answer");
  results.items = await page.evaluate("demo.items().map(i => ({ kind: i.kind, text: (i.text ?? i.args ?? '').slice(0, 400) }))");
} catch (error) {
  step("failed", { error: (error as Error).message });
  // What the page showed when it stopped: the last items and where the run was.
  process.exitCode = 1;
  await dumpPage().catch(() => undefined);
  results.failedWith = (error as Error).message;
} finally {
  writeFileSync(out, JSON.stringify(results, null, 2));
  await device.close().catch(() => undefined);
  cdp.close();
}
