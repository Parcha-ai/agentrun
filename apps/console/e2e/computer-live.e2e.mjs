// A desktop's live view in a real browser, end to end on the built server and console, on the real runner path: the server
// started in this process on a fresh data directory, and beside it a runner on the same store composed as the CLI's runner
// composes it (runner/main.ts runnerComputers), whose provider loader makes a fake desktop (its frames PNGs, its input
// recorded; no vendor, no network). The run's second model turn waits until this script lets it go, so the desktop is up
// and its view open (computer-live.ts openClaimView) while the console frames the viewer on the run's page (GET /computer:
// live, kind desktop). In the framed viewer, Take over is a take-over row the runner applies to the run's hold, a click
// and a key typed reach the desktop's watch, the page losing focus lets go of a held button, and Hand back gives the
// desktop back; let go, the run ends, and the viewer says its computer went. Headless Chrome; nothing leaves loopback. Every wait is for a condition, with a bound. Exits 0
// when every check holds, else 1.
//   CHROME_PATH=<chrome> node apps/console/e2e/computer-live.e2e.mjs [--tap FILE]
// Needs the repository built (npm run build).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixture, launchBrowser, LOOPBACK, newContext, newPage, ROOT, setUp } from "./harness.mjs";

const { values } = parseArgs({ options: { tap: { type: "string" } } });
const dir = await mkdtemp(join(tmpdir(), "agentrun-e2e-computer-"));
// The seal key the server makes at its start and its runner reads: one config home for both, this run's own.
process.env.XDG_CONFIG_HOME = join(dir, "config");
// The desktop's provider key: a stand-in, given only to the fake desktop.
process.env.E2B_API_KEY = "e2b-test-not-a-key";
const dist = (file) => import(join(ROOT, "packages/serve/dist", file));
const { startServe, fauxEnvOf } = await dist("server.js");
const { openSqliteStore } = await dist("store/index.js");
const { startRunner } = await dist("runner/runner.js");
const { dispatchRunner } = await dist("runner/harness-loops.js");
const { runEnv, runnerComputers } = await dist("runner/main.js");
const { routeOf } = await dist("runner/model-route.js");
const { ensureSealKey, sealKeyHome } = await dist("seal-key.js");
const { fakeDesktopProvider } = await import(join(ROOT, "packages/serve/test/computer-live-support.mjs"));

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

const data = join(dir, "data");
const faux = fixture("faux-held.mjs");
// The run's second model turn waits on this until the script lets it go (fixtures/faux-held.mjs, in this process).
let letGo;
globalThis[Symbol.for("agentrun.test.held")] = new Promise((resolve) => (letGo = resolve));
const desktop = fakeDesktopProvider();
let server;
let runner;
let runnerStore;
let browser;
try {
  server = await startServe({ data, port: 0, host: LOOPBACK, faux, accounts: true, openSetup: true });
  const origin = `http://${LOOPBACK}:${server.port}`;
  // The runner beside it, on the same store, with the server's seal key and the faux model.
  runnerStore = await openSqliteStore({ dataDir: data, role: "runner" });
  const env = { ...runEnv(process.env), ...fauxEnvOf({ faux }) };
  const sealKey = ensureSealKey(undefined, { configHome: sealKeyHome(process.env) }).key;
  const computers = runnerComputers(runnerStore, env, sealKey, { load: desktop.load });
  runner = startRunner({ store: runnerStore, createLoop: dispatchRunner({ env, data, journal: (claim) => runnerStore.journal(claim), store: runnerStore, sealKey, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps }) });

  const api = async (method, path, body) => {
    const res = await fetch(`${origin}/v2${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  check("the agent is made", (await api("POST", "/agents", { definition: { id: "desk", name: "Desk", instructions: "Look.", tools: ["read"], computer: { kind: "desktop", provider: "e2b" } } })).status === 201);
  const started = await api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
  check("the run starts", started.status === 202, String(started.status));
  const runId = started.body.run_id;
  // Up: the run's journal says so once its first turn is committed.
  await until(async () => (await api("GET", `/runs/${runId}`)).body?.computer?.state === "ready", "the run's desktop is up", 30_000);
  check("the runner made the desktop at the claim", desktop.record.created.length === 1);

  browser = await launchBrowser();
  const { context, blocked } = await newContext(browser, origin);
  const { page, errors } = await newPage(context);
  await setUp(page, origin);
  await page.goto(`${origin}/#/runs/${encodeURIComponent(runId)}`);
  const tab = page.getByRole("tab", { name: "Screen" });
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  const iframe = page.locator('section[aria-label="Screen"] iframe');
  await iframe.waitFor({ timeout: 20_000 });
  const src = await iframe.getAttribute("src");
  check("the console frames the viewer under /computer/live", new URL(src).pathname.startsWith(`/v2/runs/${encodeURIComponent(runId)}/computer/live/v/`));
  const viewer = page.frameLocator('section[aria-label="Screen"] iframe');
  const hands = viewer.locator("#hands");
  await hands.waitFor({ timeout: 20_000 });
  check("the viewer's button reads Take over", (await hands.innerText()) === "Take over");
  check("a desktop shows no phone buttons", await viewer.locator("#phone").isHidden());
  // The token leaves the viewer's address at once: its fragment is gone after load.
  const viewerFrame = page.frames().find((f) => new URL(f.url()).pathname.includes("/computer/live/v/"));
  check("the viewer's location.hash is empty after load", (await viewerFrame.evaluate(() => location.hash)) === "");

  // The desktop's frame: drawn, and acked by the page once drawn.
  await until(() => desktop.record.acks === 1, "the page drew the frame and acked it").catch(() => {});
  check("the page drew the frame and acked it", desktop.record.acks === 1);
  check("the canvas has the frame's size", await viewer.locator("#screen").evaluate((c) => c.width === 64 && c.height === 40));

  // Take over: a take-over row the runner applies to the run's hold.
  await hands.click();
  await viewer.locator("#hands", { hasText: "Hand back" }).waitFor({ timeout: 20_000 });
  check("the person holds the desktop", (await viewer.locator("#drive").innerText()) === "you have the computer");
  await viewer.locator("#screen").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("q");
  const typed = (actions) => actions.some((a) => a.type === "type" && a.text === "q");
  await until(() => desktop.record.inputs.some(typed), "the key typed reaches the computer").catch(() => {});
  check("the click reached the desktop once held", desktop.record.inputs.some((actions) => actions.some((a) => a.type === "down" && a.button === "left")), JSON.stringify(desktop.record.inputs));
  check("the key typed reached it as text", desktop.record.inputs.some(typed), JSON.stringify(desktop.record.inputs));
  // A button held when the page loses focus is let go.
  const presses = () => desktop.record.inputs.filter((actions) => actions.some((a) => a.type === "down")).length;
  const lifted = (actions) => actions.length === 1 && actions[0].type === "up" && actions[0].button === "left";
  await viewer.locator("#screen").hover({ position: { x: 8, y: 8 } });
  await page.mouse.down();
  await until(() => presses() === 2, "the second press reaches the desktop").catch(() => {});
  await viewerFrame.evaluate(() => window.dispatchEvent(new Event("blur")));
  await until(() => desktop.record.inputs.some(lifted), "the blur lets go of the button").catch(() => {});
  check("losing focus lets go of the held button", desktop.record.inputs.some(lifted), JSON.stringify(desktop.record.inputs));
  await page.mouse.up();

  // Hand back: the agent drives again; let go, the run ends, which ends the view.
  await hands.click();
  await viewer.locator("#notice", { hasText: "You handed the computer back" }).waitFor({ timeout: 20_000 }).catch(() => {});
  check("the viewer says the computer went back", (await viewer.locator("#notice").innerText()).includes("You handed the computer back"));
  letGo();
  await until(async () => (await api("GET", `/runs/${runId}`)).body?.status === "completed", "the run ends").catch(() => {});
  check("the run ends once the desktop is handed back", (await api("GET", `/runs/${runId}`)).body?.status === "completed");
  // The view ends with the run: the viewer says its computer was released, or the run's page has already taken the frame
  // away (its tab closes with the run's computer), whichever the page shows first.
  const ended = await until(async () => {
    if ((await iframe.count()) === 0) return "the frame is gone";
    const said = await viewer.locator("#notice").innerText({ timeout: 1_000 }).catch(() => "");
    return said.includes("This computer has been released.") ? "the viewer says it was released" : false;
  }, "the view ends with the run").catch(() => undefined);
  check("the view ends with the run", ended !== undefined, ended);
  check("the page reached nothing but its own origin", blocked.length === 0, blocked.join(", "));
  check("the page logged no error", errors.length === 0, errors.join(" | "));
  await context.close();
} catch (error) {
  check("the flow ran to its end", false, (error && error.message) || String(error));
} finally {
  letGo();
  await browser?.close().catch(() => {});
  await runner?.close().catch(() => {});
  await runnerStore?.close().catch(() => {});
  await server?.close().catch(() => {});
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
