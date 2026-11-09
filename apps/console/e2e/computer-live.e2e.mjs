// A desktop's live view in a real browser, end to end on the built server and console: the server started in this process
// with the store's viewers and a seal key (the one store a runner shares with it), a run of an agent that waits on the
// person, and on the runner's side, in the same store under the run's claim, a desktop's view opened by openComputerView
// over a fake watch (its frames PNGs this script makes, its input recorded) and a fake computer-hold. The console frames
// the viewer on the run's page (GET /computer: live, kind desktop); in the framed viewer Take over holds the computer,
// a key typed reaches the fake watch's input, and Hand back gives it back. Headless Chrome; nothing leaves loopback.
// Every wait is for a condition, with a bound. Exits 0 when every check holds, else 1.
//   CHROME_PATH=<chrome> node apps/console/e2e/computer-live.e2e.mjs [--tap FILE]
// Needs the repository built (npm run build).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { fixture, launchBrowser, LOOPBACK, newContext, newPage, ROOT, setUp } from "./harness.mjs";

const { values } = parseArgs({ options: { tap: { type: "string" } } });
const dist = (file) => import(join(ROOT, "packages/serve/dist", file));
const { startServe } = await dist("server.js");
const { openSqliteStore } = await dist("store/sqlite/store.js");
const { openComputerView } = await dist("computer-live.js");
const { fakeHold, fakeWatch } = await import(join(ROOT, "packages/serve/test/computer-live-support.mjs"));

const results = [];
const check = (what, ok, detail = "") => { results.push({ what, ok }); console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); };
/** Until `test()` holds, bounded; each try waits on the next turn of the event loop's timers. */
async function until(test, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A PNG of `w` x `h` pixels, one colour: a frame the browser draws. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const dir = await mkdtemp(join(tmpdir(), "agentrun-e2e-computer-"));
const sealKey = randomBytes(32);
process.env.AGENTRUN_SEAL_KEY = sealKey.toString("base64");
const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
let server;
let browser;
let view;
try {
  server = await startServe({ data: join(dir, "data"), port: 0, host: LOOPBACK, faux: fixture("faux-ask.mjs"), accounts: true, openSetup: true, store: { triggers: store.triggers, runs: store.runs, liveViewers: store.liveViewers } });
  const origin = `http://${LOOPBACK}:${server.port}`;
  const api = async (method, path, body) => {
    const res = await fetch(`${origin}/v2${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  check("the agent is made", (await api("POST", "/agents", { definition: { id: "desk", name: "Desk", instructions: "Ask.", tools: ["ask_person"] } })).status === 201);
  const started = await api("POST", "/agents/desk/runs", { input: { content: "Use the desktop." } });
  check("the run starts", started.status === 202, String(started.status));
  const runId = started.body.run_id;
  await until(async () => (await api("GET", `/runs/${runId}`)).body?.status === "input_required", "the run waits on the person");

  // The runner's side: the run as the store holds it, claimed, and its desktop's view opened.
  if (!(await store.runs.get(runId))) {
    await store.agents.create({ id: "desk", name: "Desk" }, { id: "rev-desk", kind: "agentic", body: { instructions: "Ask." } });
    await store.runs.create({ id: runId, agentId: "desk", revisionId: "rev-desk" });
  }
  const claim = (await store.runs.claimMany("runner-e2e", 10, { leaseMs: 600_000 })).find((c) => c.runId === runId);
  check("the runner claims the run", !!claim);
  const watch = fakeWatch();
  const hold = fakeHold({ grant: true });
  const opened = await openComputerView({ store, sealKey, claim, kind: "desktop", input: "desktop", tag: "cmp-e2e-desktop", watch: watch.watch, hold: hold.hold });
  check("the desktop's view is handed over", opened.ok === true, JSON.stringify(opened.ok ? "" : opened));
  view = opened.view;

  browser = await launchBrowser();
  const { context, blocked } = await newContext(browser, origin);
  const { page, errors } = await newPage(context);
  await setUp(page, origin);
  await page.goto(`${origin}/#/runs/${encodeURIComponent(runId)}`);
  const tab = page.getByRole("tab", { name: "Watch live" });
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  const iframe = page.locator('section[aria-label="Browser"] iframe');
  await iframe.waitFor({ timeout: 20_000 });
  const src = await iframe.getAttribute("src");
  check("the console frames the viewer under /computer/live", new URL(src).pathname.startsWith(`/v2/runs/${encodeURIComponent(runId)}/computer/live/v/`));
  const viewer = page.frameLocator('section[aria-label="Browser"] iframe');
  const hands = viewer.locator("#hands");
  await hands.waitFor({ timeout: 20_000 });
  check("the viewer's button reads Take over", (await hands.innerText()) === "Take over");
  check("a desktop shows no phone buttons", await viewer.locator("#phone").isHidden());

  // A frame: drawn, and acked by the page once drawn.
  await watch.opened();
  await Promise.race([watch.push({ format: "png", bytes: png(64, 40, [30, 120, 200]), width: 1280, height: 800, frameWidth: 64, frameHeight: 40 }), new Promise((r) => setTimeout(r, 20_000))]);
  check("the page drew the frame and acked it", watch.state.acks === 1);
  check("the canvas has the frame's size", await viewer.locator("#screen").evaluate((c) => c.width === 64 && c.height === 40));

  // Take over, type, Hand back.
  await hands.click();
  await viewer.locator("#hands", { hasText: "Hand back" }).waitFor({ timeout: 20_000 });
  check("Take over reached the hold", hold.calls.includes("take"));
  await viewer.locator("#screen").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("q");
  const typed = (actions) => actions.some((a) => a.type === "type" && a.text === "q");
  await until(() => watch.state.inputs.some(typed), "the key typed reaches the computer").catch(() => {});
  check("the click reached the computer once held", watch.state.inputs.some((actions) => actions.some((a) => a.type === "down" && a.button === "left")), JSON.stringify(watch.state.inputs));
  check("the key typed reached it as text", watch.state.inputs.some(typed), JSON.stringify(watch.state.inputs));
  await hands.click();
  await viewer.locator("#hands", { hasText: "Take over" }).waitFor({ timeout: 20_000 });
  check("Hand back reached the hold", hold.calls.includes("give"));
  check("the viewer says the computer went back", (await viewer.locator("#notice").innerText()).includes("You handed the computer back"));
  check("the page reached nothing but its own origin", blocked.length === 0, blocked.join(", "));
  check("the page logged no error", errors.length === 0, errors.join(" | "));
  await context.close();
} catch (error) {
  check("the flow ran to its end", false, (error && error.message) || String(error));
} finally {
  await view?.close("ended").catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  await store.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
if (values.tap) {
  let head = "none";
  try { head = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"]).toString().trim() ? "dirty" : execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"]).toString().trim(); } catch {}
  const lines = ["TAP version 13", `1..${results.length}`, ...results.map((r, i) => `${r.ok ? "ok" : "not ok"} ${i + 1} - ${r.what}`), `# pass ${results.length - failed}`, `# fail ${failed}`, `# head ${head}`];
  await writeFile(values.tap, `${lines.join("\n")}\n`);
}
process.exit(failed ? 1 : 0);
