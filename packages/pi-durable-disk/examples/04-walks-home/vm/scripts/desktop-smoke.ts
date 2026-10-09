// The agent uses a real desktop, driven in headless Chrome against a running `serve.ts --cloud modal --modal-desktop`: the user
// asks for something only a GUI can answer, the agent moves itself to the VM, builds a page, opens it in Chromium on the VM's
// desktop and presses its button with the computer tool, reading the result off the screen. Independent evidence: after the
// answer, this script takes its own screenshot of the VM's desktop and checks that noVNC answers through its tunnel.
//   node scripts/desktop-smoke.ts <run link> [environment id, default modal-vm]   (MODAL_TOKEN_ID/SECRET in the environment)
// Evidence goes to $OUT (default ./desktop-results.json); screenshots to $SHOTS.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModalClient } from "modal";
import { Cdp, type Page } from "../../../03-tab-to-cloud/scripts/cdp.ts";
import { DESKTOP_PORT, SCREENSHOT_COMMAND } from "../desktop.ts";

const link = process.argv[2]!;
const target = process.argv[3] ?? "modal-vm";
const out = process.env.OUT ?? "desktop-results.json";
const shots = process.env.SHOTS ?? "desktop-shots";
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

const TASK = `A tab cannot show me a real browser on a real desktop, and I want to see one work. Move yourself with your switch_environment tool to ${target} (one-sentence reason). There, using the desktop and not a script to do the pressing: (1) write desk/index.html in your workspace, a page with the heading "Walks Home desktop check", a button "Press me", and a line that reads "pressed N times" with N counting the presses, starting at 0; (2) serve the folder desk on port 8099 with python3 -m http.server, detached; (3) open http://localhost:8099 in Chromium on the desktop; (4) with your computer tool press the button exactly 4 times by clicking it; (5) tell me in one sentence the number the page shows on the screen, and that you read it from the screen.`;

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
  await page.until(answered, 900_000, 1_000);
  const answer = await page.evaluate<string>(`demo.items().filter(i => i.kind === "assistant").at(-1).text`);
  const computerCalls = await page.evaluate<number>(`demo.items().filter(i => i.kind === "tool" && /computer/.test(i.name ?? i.args ?? "")).length`);
  step("answered", { answer, computerCalls, ms: Date.now() - tCall, placement: await page.evaluate("demo.state.placement") });
  await snap(page, "answer");
  // The live view as a page gets it: a ticket for the run's secret, then the picture's stream, with no password in sight.
  const url = new URL(link);
  const run = url.pathname.split("/").pop()!;
  const secret = url.hash.slice(1);
  const ticket = (await (await fetch(`${url.origin}/run/${run}/desktop-ticket`, { method: "POST", headers: { authorization: `Bearer ${secret}` } })).json()) as { url: string };
  const stream = await fetch(`${url.origin}${ticket.url}`);
  const reader = stream.body!.getReader();
  const started = Date.now();
  let received = Buffer.alloc(0);
  let frames = 0;
  while (Date.now() - started < 6_000) {
    const { value, done } = await reader.read();
    if (done) break;
    received = Buffer.concat([received, Buffer.from(value)]);
    frames = (received.toString("latin1").match(/--frame/g) ?? []).length;
  }
  await reader.cancel();
  step("live view", { frames, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), fps: Number((frames / ((Date.now() - started) / 1000)).toFixed(2)), bytes: received.length, leaksSecret: received.includes(Buffer.from(secret)) });
  // Independent evidence from outside the agent: the VM's own desktop, and noVNC through its tunnel.
  const modal = new ModalClient();
  const app = await modal.apps.fromName(process.env.MODAL_APP ?? "pda-demo-d4", { createIfMissing: false });
  for await (const sb of modal.sandboxes.list({ appId: app.appId, tags: {} })) {
    const p = await sb.exec(["bash", "-c", `${SCREENSHOT_COMMAND} | base64 -w0`], { timeoutMs: 30_000 });
    const jpeg = Buffer.from((await p.stdout.readText()).trim(), "base64");
    writeFileSync(join(shots, "vm-desktop.jpg"), jpeg);
    const tunnels = await sb.tunnels(30_000);
    const novnc = tunnels[DESKTOP_PORT] ? (await fetch(`${tunnels[DESKTOP_PORT]!.url}/vnc.html`).then((r) => r.status, () => 0)) : null;
    step("the VM's desktop, from outside", { sandbox: sb.sandboxId, jpegBytes: jpeg.length, novncStatus: novnc });
    break;
  }
  results.items = await page.evaluate("demo.items().map(i => ({ kind: i.kind, text: (i.text ?? i.args ?? '').slice(0, 400) }))");
} catch (error) {
  step("failed", { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  writeFileSync(out, JSON.stringify(results, null, 2));
  await device.close().catch(() => undefined);
  cdp.close();
}
