// The frame recorder on a real Chrome (headless, through the cdp provider): JPEG frames of a page that moves, at most 10 a second and at most
// 800 px wide; a page that gets a password value pauses the capture until the next navigation; a release ends it with a gap.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CREDENTIAL_PROBE, frameRecorder, jpegSize } from "../dist/recorder/index.js";
import { cdpCall } from "../dist/providers/cdp-call.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 20_000) => { for (const end = Date.now() + ms; !check(); await sleep(25)) if (Date.now() > end) throw new Error("timed out"); };
const PASSWORD = ["hunter2", "Sentinel", "Password", "0001"].join("-");
const MOVING = `<!doctype html><title>moving</title><body style="margin:0"><div id=b style="width:100vw;height:100vh"></div><script>let n = 0; setInterval(() => { document.getElementById("b").style.background = "hsl(" + ((n += 17) % 360) + ",70%,50%)"; }, 20);</script>`;
const LOGIN = `<!doctype html><title>login</title><body style="margin:0"><form><input type=password name=pw></form><script>setTimeout(() => { document.querySelector("input").value = ${JSON.stringify(PASSWORD)}; }, 700); setTimeout(() => { location.href = "/after"; }, 2500);</script>`;

test("a real Chrome's page is recorded as JPEG frames within the rate and width caps, a credential on the page pauses it, a release ends it", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ path: req.url, at: Date.now() }); res.setHeader("content-type", "text/html"); res.end(req.url === "/login" ? LOGIN : MOVING); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "frame-recorder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  const started = Date.now();
  const lines = [];
  const blobs = new Map();
  const frames = frameRecorder({ sink: (line, bytes = {}) => { lines.push(line); for (const [hash, data] of Object.entries(bytes)) blobs.set(hash, data); }, clock: () => Date.now() - started, gen: () => 1 });
  t.after(() => frames.close());
  const provider = frames.watch(cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, headless: true, ...(process.env.CI || /nosandbox/.test(CHROME) ? { sandbox: false } : {}) } }), 5);
  const signal = new AbortController().signal;
  const ref = await provider.create({ tag: "ar-frames-5-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1280, height: 800 }, metadata: {} }, signal);
  let released = false;
  t.after(async () => { if (!released) await provider.release(ref, signal); });
  const target = await provider.attach(ref, signal);

  // A page that moves: frames arrive without anyone driving it.
  const open = async (url) => (await cdpCall(target.sdkCdpUrl, "Target.createTarget", { url })).close();
  await open(`${base}/moving`);
  await until(() => lines.filter((l) => l.kind === "frame").length >= 6);
  const first = lines.filter((l) => l.kind === "frame");
  for (const line of first) {
    assert.deepEqual([line.channel, line.source, line.conv, line.gen, line.data.session, line.data.provider, line.data.mime], ["live", "browser", 5, 1, ref.id, "cdp", "image/jpeg"]);
    const bytes = blobs.get(line.blobs[0]);
    assert.ok(bytes && bytes[0] === 0xff && bytes[1] === 0xd8, "a JPEG");
    assert.deepEqual(jpegSize(bytes), { w: line.data.w, h: line.data.h });
    assert.ok(line.data.w <= 800 && line.data.w > 0 && line.data.h > 0, `${line.data.w}x${line.data.h}`);
  }
  // At most 10 a second: no one-second window holds 11.
  const times = first.map((l) => l.t);
  for (let i = 0; i + 10 < times.length; i += 1) assert.ok(times[i + 10] - times[i] >= 1000 - 30, `11 frames within ${times[i + 10] - times[i]} ms`);

  // A page that is given a password: frames stop with a gap, and come back after the page navigates.
  const before = lines.length;
  await open(`${base}/login`);
  await until(() => lines.slice(before).some((l) => l.kind === "frame.gap"), 15_000);
  const gap = lines.find((l) => l.kind === "frame.gap");
  assert.equal(gap.data.reason, "credential_on_page");
  assert.equal(gap.data.session, ref.id);
  await until(() => seen.some((s) => s.path === "/after"), 15_000);
  const navigatedAt = seen.find((s) => s.path === "/after").at - started;
  await until(() => lines.slice(lines.indexOf(gap) + 1).some((l) => l.kind === "frame"), 15_000);
  const afterGap = lines.slice(lines.indexOf(gap) + 1);
  assert.ok(afterGap.filter((l) => l.kind === "frame").every((l) => l.t >= navigatedAt - 50), "no frame was kept between the password and the navigation");
  assert.equal(JSON.stringify(lines).includes(PASSWORD), false);
  for (const address of ["ws://", "127.0.0.1", "devtools", target.sdkCdpUrl]) assert.equal(JSON.stringify(lines).includes(address), false, `no debugger address in any line: ${address}`);

  await provider.release(ref, signal);
  released = true;
  const last = lines.at(-1);
  assert.deepEqual([last.kind, last.data.reason, last.data.session], ["frame.gap", "session_released", ref.id]);
});

/** The credential probe in a real page: which fields it calls a credential. */
test("the credential probe calls a field a credential when it holds a value and is a password, a one-time code or named as one, in the page, a shadow root or a frame", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "frame-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, headless: true, ...(process.env.CI || /nosandbox/.test(CHROME) ? { sandbox: false } : {}) } });
  const signal = new AbortController().signal;
  const ref = await provider.create({ tag: "ar-probe-1-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
  t.after(() => provider.release(ref, signal));
  const target = await provider.attach(ref, signal);
  const socket = new WebSocket(target.sdkCdpUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("no socket")); });
  t.after(() => socket.close());
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => { const m = JSON.parse(String(event.data)); waiting.get(m.id)?.(m); };
  const call = (method, params = {}, sessionId) => new Promise((resolve) => { const n = (id += 1); waiting.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { result: { targetId } } = await call("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await call("Target.attachToTarget", { targetId, flatten: true });
  const probe = async (html) => {
    await call("Page.enable", {}, sessionId);
    await call("Page.navigate", { url: `data:text/html,${encodeURIComponent(html)}` }, sessionId);
    await sleep(300);
    return (await call("Runtime.evaluate", { expression: CREDENTIAL_PROBE, returnByValue: true }, sessionId)).result.result.value;
  };
  const F = { hold: false, why: null };
  const cases = [
    ["an empty password field", `<input type=password>`, F],
    ["a password with a value", `<input type=password value=hunter2>`, { hold: true, why: "field" }],
    ["a one-time-code field with a value", `<input autocomplete=one-time-code value=123456>`, { hold: true, why: "field" }],
    ["a field named otp with a value", `<input name=otp value=123456>`, { hold: true, why: "field" }],
    ["a field labelled as a 2fa code with a value", `<input aria-label="2FA code" value=123456>`, { hold: true, why: "field" }],
    ["an ordinary text field with a value", `<input name=username value=alice>`, F],
    ["an email field with a value", `<input type=email name=email value=a@b.test>`, F],
    ["a word that only contains a code name", `<input name=protocol value=http>`, F],
    ["a password in an open shadow root", `<div id=h></div><script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML = "<input type=password value=hunter2>";</script>`, { hold: true, why: "field" }],
    ["a password in a same-origin frame", `<iframe srcdoc="<input type=password value=hunter2>"></iframe>`, { hold: true, why: "field" }],
    ["a code field named only by a label that points at it", `<label for=c>Verification code</label><input id=c value=123456>`, { hold: true, why: "field" }],
    ["a code field inside its label", `<label>Enter your 2FA code <input value=123456></label>`, { hold: true, why: "field" }],
    ["a code field named by aria-labelledby", `<span id=l>One-time passcode</span><input aria-labelledby=l value=123456>`, { hold: true, why: "field" }],
    ["a field whose label is about something else", `<label for=n>Your name</label><input id=n value=Alice>`, F],
    ["a password nested deeper than the probe reads", `<div id=h></div><script>let host = document.getElementById("h"); for (let i = 0; i < 9; i += 1) { const root = host.attachShadow({ mode: "open" }); const next = document.createElement("div"); root.appendChild(next); host = next; } host.attachShadow({ mode: "open" }).innerHTML = "<input type=password value=hunter2>";</script>`, { hold: true, why: "too_deep" }],
    ["a visible frame the page cannot read into (another origin)", `<iframe src="data:text/html,<input>" width=300 height=100></iframe>`, { hold: true, why: "unreadable_frame" }],
    ["a frame that is not displayed", `<iframe src="data:text/html,<input>" style="display:none"></iframe>`, F],
    ["a frame with no area", `<iframe src="data:text/html,<input>" width=0 height=0></iframe>`, F],
    ["a visible frame of the page's own origin with nothing in it", `<iframe srcdoc="<p>hello</p>" width=300 height=100></iframe>`, F],
  ];
  for (const [what, html, expected] of cases) assert.deepEqual(await probe(html), expected, what);
  // A code typed and cleared between two checks is still seen: the page keeps what the fields were given, until the next check reports it.
  await probe(`<input name=otp id=o>`);
  await call("Runtime.evaluate", { expression: `(() => { const el = document.getElementById("o"); el.value = "123456"; el.dispatchEvent(new Event("input", { bubbles: true })); el.value = ""; })()`, returnByValue: true }, sessionId);
  assert.deepEqual((await call("Runtime.evaluate", { expression: CREDENTIAL_PROBE, returnByValue: true }, sessionId)).result.result.value, { hold: true, why: "typed" }, "typed and cleared, still reported once");
  assert.deepEqual((await call("Runtime.evaluate", { expression: CREDENTIAL_PROBE, returnByValue: true }, sessionId)).result.result.value, F, "and only once");
});
