// The live view's screencast and input (src/live-view/stream.ts) over a fake DevTools endpoint: frames reach the viewer's handler one at a time and the browser is told to send the next only when
// the handler says (after the frame went out, or at once to drop it); the stream follows the page in use; input is validated and mapped to Input.* and bad input never reaches the browser; and
// nothing is written to disk.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openStream, StreamRefusal } from "../dist/live-view/stream.js";
import { fakeCdp, jpeg } from "./fixtures/fake-cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };

async function rig(t, { pages } = {}) {
  const fake = await fakeCdp(pages ? { pages } : undefined);
  t.after(() => fake.close());
  const seen = { frames: [], pages: [], dialogs: [], closed: 0 };
  let onFrame = (jpegBytes, size, ack) => { seen.frames.push({ jpegBytes, size }); ack(); };
  const stream = openStream(fake.url, {
    frame: (bytes, size, ack) => onFrame(bytes, size, ack),
    page: (p) => seen.pages.push(p),
    dialog: (d) => seen.dialogs.push(d),
    closed: () => { seen.closed += 1; },
  });
  t.after(() => stream.close());
  assert.ok(await until(() => fake.screencasts().length === 1), "the stream attached to the page and started the screencast");
  return { fake, stream, seen, onFrame: (fn) => { onFrame = fn; } };
}
const inputCalls = (fake, method) => fake.calls.filter((c) => c.method === method).map((c) => c.params);

test("a frame reaches the handler as JPEG bytes with the page's size, and the browser is told to send the next only when the handler acknowledges", async (t) => {
  const { fake, seen, onFrame } = await rig(t);
  let release;
  onFrame((bytes, size, ack) => { seen.frames.push({ bytes, size }); release = ack; });
  assert.ok(fake.frame({ bytes: jpeg(800, 500) }));
  assert.ok(await until(() => seen.frames.length === 1));
  assert.deepEqual([seen.frames[0].bytes[0], seen.frames[0].bytes[1]], [0xff, 0xd8], "a JPEG");
  assert.deepEqual(seen.frames[0].size, { w: 1280, h: 800 }, "the page's own width and height as the browser reports them");
  await wait(150);
  assert.equal(fake.acks.length, 0, "no acknowledgement while the viewer has not sent the frame");
  release();
  release();
  assert.ok(await until(() => fake.acks.length === 1));
  await wait(100);
  assert.equal(fake.acks.length, 1, "an acknowledgement is given once");
});

test("a frame the viewer drops is acknowledged at once, and the stream keeps no frame: the handler holds the only reference", async (t) => {
  const { fake, seen, onFrame } = await rig(t);
  onFrame((_bytes, _size, ack) => { seen.frames.push({}); ack(); });
  for (let i = 0; i < 5; i += 1) { assert.ok(fake.frame()); await wait(20); }
  assert.ok(await until(() => fake.acks.length === 5), `every dropped frame was acknowledged: ${fake.acks.length}`);
  assert.equal(seen.frames.length, 5);
});

test("the stream follows the page in use: a page opened later is shown, frames of the one left are acknowledged and not delivered, and its screencast stops", async (t) => {
  const { fake, seen } = await rig(t, { pages: [{ id: "PAGE1", url: "https://a.example/" }] });
  assert.ok(await until(() => seen.pages.some((p) => p.url === "https://a.example/")), "the page shown is announced");
  const first = fake.calls.find((c) => c.method === "Page.startScreencast").sessionId;
  fake.newPage("PAGE2", "https://b.example/next");
  assert.ok(await until(() => seen.pages.some((p) => p.url === "https://b.example/next")), "the new page is announced");
  assert.ok(await until(() => fake.screencasts().length === 1 && fake.calls.filter((c) => c.method === "Page.startScreencast").length === 2));
  assert.ok(fake.calls.some((c) => c.method === "Page.stopScreencast" && c.sessionId === first), "the page left stops its screencast");
  const before = seen.frames.length;
  assert.ok(fake.frame({ page: "PAGE2" }));
  assert.ok(await until(() => seen.frames.length === before + 1), "a frame of the page shown is delivered");
  fake.navigate("PAGE2", "https://b.example/other");
  assert.ok(await until(() => seen.pages.some((p) => p.url === "https://b.example/other")), "a move of the page shown is announced");
  fake.infoChanged("PAGE2");
  assert.ok(await until(() => seen.pages.some((p) => /^title /.test(p.title))), "a new title is announced");
  fake.destroyPage("PAGE2");
  assert.ok(await until(() => seen.pages.at(-1)?.url === "https://a.example/"), "when the page shown ends, the other one is");
});

test("a mouse, wheel, key and text message become the Input calls the browser takes, with the page's coordinates", async (t) => {
  const { fake, stream } = await rig(t);
  await stream.input({ type: "mouse", action: "move", x: 10, y: 20 });
  await stream.input({ type: "mouse", action: "down", x: 11, y: 21, button: "left", clickCount: 2, modifiers: 8 });
  await stream.input({ type: "mouse", action: "up", x: 11, y: 21, button: "left" });
  await stream.input({ type: "mouse", action: "down", x: 1, y: 2, button: "right" });
  await stream.input({ type: "wheel", x: 5, y: 6, deltaX: 0, deltaY: 120 });
  await stream.input({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
  await stream.input({ type: "key", action: "down", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await stream.input({ type: "key", action: "up", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await stream.input({ type: "text", text: "pasted text" });
  const mouse = inputCalls(fake, "Input.dispatchMouseEvent");
  assert.deepEqual(mouse.map((m) => [m.type, m.x, m.y, m.button, m.buttons, m.clickCount, m.modifiers]), [
    ["mouseMoved", 10, 20, "none", 0, 0, 0], ["mousePressed", 11, 21, "left", 1, 2, 8], ["mouseReleased", 11, 21, "left", 0, 1, 0], ["mousePressed", 1, 2, "right", 2, 1, 0], ["mouseWheel", 5, 6, undefined, undefined, undefined, 0],
  ]);
  assert.deepEqual([mouse[4].deltaX, mouse[4].deltaY], [0, 120]);
  const keys = inputCalls(fake, "Input.dispatchKeyEvent");
  assert.deepEqual(keys.map((k) => [k.type, k.key, k.text, k.windowsVirtualKeyCode]), [["keyDown", "a", "a", 65], ["rawKeyDown", "ArrowLeft", undefined, 37], ["keyUp", "a", undefined, 65]], "a key that makes text is a keyDown with it, one that does not is a rawKeyDown");
  assert.deepEqual(inputCalls(fake, "Input.insertText"), [{ text: "pasted text" }]);
});

test("a message that is not well formed is refused with a typed reason and never reaches the browser", async (t) => {
  const { fake, stream } = await rig(t);
  const refused = async (call, reason = "bad_message") => {
    const before = fake.calls.length;
    await assert.rejects(call, (error) => error instanceof StreamRefusal && error.reason === reason, reason);
    assert.equal(fake.calls.length, before, "nothing was sent to the browser");
  };
  await refused(stream.input({ type: "mouse", action: "move", x: Number.NaN, y: 1 }));
  await refused(stream.input({ type: "mouse", action: "move", x: 1, y: Infinity }));
  await refused(stream.input({ type: "mouse", action: "sideways", x: 1, y: 1 }));
  await refused(stream.input({ type: "mouse", action: "down", x: 1, y: 1, button: "thumb" }));
  await refused(stream.input({ type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: "far" }));
  await refused(stream.input({ type: "key", action: "down", key: "", code: "KeyA" }));
  await refused(stream.input({ type: "key", action: "hold", key: "a", code: "KeyA" }));
  await refused(stream.input({ type: "text", text: "" }));
  await refused(stream.input({ type: "text", text: "x".repeat(100_001) }));
  await refused(stream.input({ type: "teleport" }));
  await refused(stream.input(null));
  await refused(stream.nav({ type: "nav", action: "url", url: "javascript:alert(1)" }));
  await refused(stream.nav({ type: "nav", action: "url", url: "data:text/html,<p>x</p>" }));
  await refused(stream.nav({ type: "nav", action: "url", url: "file:///etc/passwd" }));
  await refused(stream.nav({ type: "nav", action: "url", url: "not a url" }));
  await refused(stream.nav({ type: "nav", action: "sideways" }));
  await refused(stream.dialog({ type: "dialog", accept: "yes" }));
});

test("an address is navigated to, a reload is asked for, and with no page nothing is delivered and the reason is no_page", async (t) => {
  const { fake, stream } = await rig(t);
  await stream.nav({ type: "nav", action: "url", url: "https://acme.example/login?next=%2F" });
  await stream.nav({ type: "nav", action: "reload" });
  assert.deepEqual(inputCalls(fake, "Page.navigate"), [{ url: "https://acme.example/login?next=%2F" }]);
  assert.equal(inputCalls(fake, "Page.reload").length, 1);
  const bare = await fakeCdp({ pages: [] });
  t.after(() => bare.close());
  const idle = openStream(bare.url, { frame: (_b, _s, ack) => ack(), page() {}, dialog() {}, closed() {} });
  t.after(() => idle.close());
  await wait(200);
  await assert.rejects(idle.input({ type: "text", text: "x" }), (error) => error instanceof StreamRefusal && error.reason === "no_page");
  await assert.rejects(idle.nav({ type: "nav", action: "reload" }), (error) => error instanceof StreamRefusal && error.reason === "no_page");
});

test("close stops the screencast and the browser's socket, and a socket cut under the stream is reported once", async (t) => {
  const { fake, stream, seen } = await rig(t);
  stream.close();
  assert.ok(await until(() => fake.clients() === 0), "the socket is closed");
  assert.ok(fake.calls.some((c) => c.method === "Page.stopScreencast"));
  assert.equal(seen.closed, 0, "a close the stream asked for is not reported");
  const cut = await rig(t);
  cut.fake.cut();
  assert.ok(await until(() => cut.seen.closed === 1), "a cut is reported");
});

test("nothing is written to disk: the module imports no module, and streaming frames, input and a navigation in a process that fails any file write writes none", async (t) => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "live-view", "stream.ts"), "utf8");
  const imports = [...source.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map((m) => m[0]);
  assert.deepEqual(imports, [], "no runtime import: no fs, no recorder, no log");
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\b(require|writeFile|appendFile|createWriteStream|mkdir|rename|console\.)/, "no file or log call");
  const fake = await fakeCdp();
  t.after(() => fake.close());
  // The child's temporary directory is its own: a listing of the shared one would see another test file's files.
  const own = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "lv-nodisk-"));
  t.after(() => fs.rmSync(own, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(HERE, "live_view_stream_child.mjs"), fake.url], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: own } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  assert.ok(await until(() => fake.screencasts().length === 1, 8000), `the child attached: ${err.slice(-300)}`);
  for (let i = 0; i < 6; i += 1) { fake.frame(); await wait(30); }
  assert.ok(await until(() => /STREAMED/.test(out), 8000), `the child streamed: ${out.slice(-300)} ${err.slice(-300)}`);
  assert.equal(await exited, 0, err.slice(-500));
  const report = JSON.parse(out.split("\n").find((l) => l.startsWith("REPORT "))?.slice(7) ?? "null");
  assert.ok(report.frames >= 6, `frames reached the child's handler: ${report.frames}`);
  assert.deepEqual(report.writes, [], "no file write, open for writing, mkdir or rename was attempted");
  assert.deepEqual([report.tmpBefore, report.tmpAfter], [[], []], "the child's own temporary directory was empty before and after");
  assert.deepEqual(fs.readdirSync(own), [], "and is empty now");
});

test("the address about:blank is navigated to, exactly: every other about: address, and script-bearing ones, are refused and never reach the browser", async (t) => {
  const { fake, stream } = await rig(t);
  await stream.nav({ type: "nav", action: "url", url: "about:blank" });
  assert.deepEqual(inputCalls(fake, "Page.navigate"), [{ url: "about:blank" }], "the viewer's own parser and address bar accept about:blank, so the stream does too");
  for (const url of ["about:blank#x", "ABOUT:BLANK", "about:srcdoc", "about:", "about:blank ", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    await assert.rejects(() => stream.nav({ type: "nav", action: "url", url }), (e) => e instanceof StreamRefusal && e.reason === "bad_message", url);
  }
  assert.equal(inputCalls(fake, "Page.navigate").length, 1, "nothing but about:blank was sent");
});

