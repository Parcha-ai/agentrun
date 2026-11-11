// The local browser's raw-CDP driver on a real Chrome (CHROME_PATH, or /usr/bin/google-chrome; skipped without one, and
// failed instead under AGENTRUN_REQUIRE_LOCAL_CHROME=1): a page of injected HTML on about:blank, its snapshot, a typed
// field and a clicked button, and the result read back from the page; then run code, refused. Chrome is started here as
// the local provider starts it, headless with its sandbox on and its debugging port on loopback, and killed at the end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cdpDriver, CDP_CODE_REFUSED } from "../dist/driver/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const HTML = `<title>Greeter</title><h1>Greeter</h1>
<label>Your name <input id="name"></label>
<select id="tone" aria-label="Tone"><option value="warm">Warm</option><option value="formal">Formal</option></select>
<button id="go" onclick="document.getElementById('out').textContent = (document.getElementById('tone').value === 'formal' ? 'Good day, ' : 'Hello, ') + document.getElementById('name').value">Greet</button>
<p id="out"></p>`;

/** One CDP command at a time over a websocket of the test's own. */
async function raw(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("no DevTools socket")); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); waiting.get(m.id)?.(m); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => ws.close() };
}

test("a real Chrome: snapshot, type in a field, select, click a button, read the result; run code is refused", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdpd-", "/tmp");
  const profile = path.join(root, "profile");
  // A TMPDIR of its own, inside the scratch directory: what Chrome leaves there on its kill goes with it.
  const tmp = path.join(root, "t");
  await mkdir(tmp);
  const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "about:blank"], { stdio: "ignore", detached: true, env: { ...process.env, TMPDIR: tmp } }); // key-gate: loopback-rule a test Chrome's DevTools socket
  t.after(async () => {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
    await new Promise((resolve) => (chrome.exitCode !== null || chrome.signalCode !== null ? resolve() : chrome.once("exit", resolve)));
  });
  let port;
  let browserPath;
  for (const end = Date.now() + 20_000; Date.now() < end && !port; await new Promise((r) => setTimeout(r, 100))) {
    const [p, b] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
    if (/^\d+$/.test(p ?? "") && b) [port, browserPath] = [Number(p), b.trim()];
  }
  assert.ok(port, "Chrome opened its debugging port");
  const url = `ws://127.0.0.1:${port}${browserPath}`; // key-gate: loopback-rule a test Chrome's DevTools socket

  // The page: injected HTML on the blank page Chrome opened.
  const setup = await raw(url);
  const { targetInfos } = await setup.send("Target.getTargets");
  const { sessionId } = await setup.send("Target.attachToTarget", { targetId: targetInfos.find((one) => one.type === "page").targetId, flatten: true });
  const { frameTree } = await setup.send("Page.getFrameTree", {}, sessionId);
  await setup.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: HTML }, sessionId);
  setup.close();

  const driver = await cdpDriver()({ sdkCdpUrl: url });
  t.after(() => driver.close());
  const shot = await driver.snapshot();
  assert.match(shot, /^\[page\] Greeter \| about:blank/);
  assert.match(shot, /## Greeter/);
  const id = (role, name) => {
    const found = new RegExp(`\\[(\\d+-\\d+)\\] ${role} "${name}"`).exec(shot);
    assert.ok(found, `the snapshot shows a ${role} "${name}":\n${shot}`);
    return found[1];
  };
  const field = id("textbox", "Your name");
  const tone = id("select", "Tone");
  const button = id("button", "Greet");
  assert.match(field, /^0-\d+$/, "a frame-node id in the main frame");

  const typed = await driver.run({ actions: [{ op: "fill", id: field, value: "Ada" }] });
  assert.match(typed, new RegExp(`^\\[ok\\] fill \\[${field}\\] textbox "Your name" = "Ada" -> page changed$`));
  const picked = await driver.run({ actions: [{ op: "select", id: tone, values: "Formal" }] });
  assert.match(picked, /= "Formal" -> page changed$/);
  const clicked = await driver.run({ actions: [{ op: "click", id: button }] });
  assert.match(clicked, new RegExp(`^\\[ok\\] click \\[${button}\\] button "Greet" -> page changed$`));

  const read = await driver.page();
  assert.match(read.text, /Good day, Ada/);
  assert.match(await driver.snapshot(), /Good day, Ada/);

  await assert.rejects(driver.run({ code: "return 1" }), { message: CDP_CODE_REFUSED });
  const shotBytes = await driver.screenshot({ type: "png" });
  assert.equal(shotBytes.mimeType, "image/png");
  assert.ok(Buffer.from(shotBytes.data, "base64").subarray(1, 4).toString() === "PNG");
});
