// The computer viewer's screen size (computer-viewer.ts), run in a VM against a fake page: the canvas takes the frame's
// shape fitted in the stage, its own pixels are its CSS size times devicePixelRatio (so the browser never scales it a
// second time, which blurred the full-window view), a stage of the desktop's shape is filled with no bars, and a resize
// draws the frame it has again at the new size. Each step waits on the frame's ack or the resize, never on a clock.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { computerViewerAssets } from "../dist/computer-viewer.js";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.width = 0;
    this.height = 0;
    this.box = { width: 0, height: 0 };
    this.classList = { toggle() {} };
  }
  addEventListener() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, ...this.box }; }
}

/** A decoded frame the fake createImageBitmap hands over: its size, and whether the viewer let it go. */
const bitmapOf = (width, height) => ({ width, height, closed: false, close() { this.closed = true; } });

/** The viewer's script on a fake page whose stage is `box` CSS px at `dpr`, ready on a desktop. `bitmaps` are what
 *  createImageBitmap answers, one per frame, in order. */
function viewer({ box, dpr, bitmaps, kind = "desktop" }) {
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); };
  el("stage").box = box;
  const draws = [];
  const ctx = { imageSmoothingEnabled: false, imageSmoothingQuality: "low", drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality }); } };
  el("screen").getContext = () => ctx;
  let resized;
  let socket;
  let acked;
  class FakeWebSocket {
    constructor() { this.readyState = 1; socket = this; }
    send(data) { if (JSON.parse(data).type === "ack") acked?.(); }
  }
  // Each media query the page asks for, with the change listeners it holds on it.
  const queries = [];
  const window = {
    devicePixelRatio: dpr,
    addEventListener() {},
    matchMedia(media) {
      const query = { media, listeners: new Set(), addEventListener(type, fn) { if (type === "change") this.listeners.add(fn); }, removeEventListener(type, fn) { if (type === "change") this.listeners.delete(fn); } };
      queries.push(query);
      return query;
    },
  };
  const queue = [...bitmaps];
  const context = vm.createContext({
    location: { hash: "#t=token&hands=page", pathname: "/v2/runs/r/computer/live/v/x", search: "", protocol: "http:", host: "h" },
    history: { replaceState() {} },
    document: { getElementById: el, body: new FakeElement("body") },
    URLSearchParams,
    WebSocket: FakeWebSocket,
    ResizeObserver: class { constructor(fn) { resized = fn; } observe() {} },
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options?.type; } },
    createImageBitmap: async () => queue.shift(),
    window,
    JSON, Object, Math, Number, String, Date, DataView, Uint8Array, Promise,
  });
  vm.runInContext(computerViewerAssets.js, context);
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: "ready", kind, input: kind === "phone" ? "android" : "desktop", held: false, drive: "agent" }) });
  /** One frame of a `w` x `h` screen, resolved once the viewer acked it (drawn). */
  const frame = (w, h) => {
    const buffer = new ArrayBuffer(6);
    const view = new DataView(buffer);
    view.setUint16(0, w);
    view.setUint16(2, h);
    view.setUint8(4, 0xff);
    view.setUint8(5, 0xd8);
    const drawn = new Promise((resolve) => { acked = resolve; });
    socket.onmessage({ data: buffer });
    return drawn;
  };
  /** The stage's box changes, as its ResizeObserver hears it. */
  const resize = (next) => { el("stage").box = next; resized(); };
  /** The window moves to a display of `next` density, as its media query hears it: the stage keeps its CSS size. */
  const density = (next) => {
    window.devicePixelRatio = next;
    // The queries as they were: one the page asks for while it hears this change is for the next.
    for (const query of [...queries]) for (const fn of [...query.listeners]) fn();
  };
  /** The media queries the page listens on now. */
  const listening = () => queries.filter((q) => q.listeners.size > 0).map((q) => q.media);
  return { canvas: el("screen"), draws, frame, resize, density, listening };
}

const px = (value) => Number.parseFloat(value);

test("the canvas's own pixels are its CSS size times devicePixelRatio, and the frame is drawn into them once, smoothed at its best", async () => {
  // The full window that showed soft: a 1920x1080 desktop, its frames 1280 wide, under the console's bar on a 2x screen.
  const bitmap = bitmapOf(1280, 720);
  const { canvas, draws, frame } = viewer({ box: { width: 1920, height: 1019 }, dpr: 2, bitmaps: [bitmap] });
  await frame(1920, 1080);
  assert.equal(canvas.style.width, "1811px");
  assert.equal(canvas.style.height, "1019px");
  assert.equal(canvas.width, px(canvas.style.width) * 2, "the canvas holds one pixel per device pixel");
  assert.equal(canvas.height, px(canvas.style.height) * 2);
  assert.deepEqual(draws.map((d) => d.args), [[bitmap, 0, 0, canvas.width, canvas.height]], "scaled once, by the canvas, to the device's pixels");
  assert.equal(draws[0].smoothing, true);
  assert.equal(draws[0].quality, "high");
  assert.equal(bitmap.closed, false, "the frame on screen is kept, to draw again at a new size");
  // What is left beside it is even in device pixels, so the centred canvas starts on a whole pixel.
  assert.equal((1920 * 2 - canvas.width) % 2, 0);
});

test("a stage of the desktop's shape is filled to its edges: no bars, at any devicePixelRatio", async () => {
  for (const dpr of [1, 1.5, 2]) {
    const { canvas, frame } = viewer({ box: { width: 1600, height: 900 }, dpr, bitmaps: [bitmapOf(1280, 720)] });
    await frame(1920, 1080);
    assert.equal(canvas.style.width, "1600px", `at ${dpr}x`);
    assert.equal(canvas.style.height, "900px", `at ${dpr}x`);
    assert.equal(canvas.width, 1600 * dpr);
    assert.equal(canvas.height, 900 * dpr);
  }
  // A screen the stage holds pixel for pixel is drawn 1:1.
  const { canvas, draws, frame } = viewer({ box: { width: 1280, height: 800 }, dpr: 1, bitmaps: [bitmapOf(1280, 800)] });
  await frame(1280, 800);
  assert.deepEqual([canvas.width, canvas.height, canvas.style.width, canvas.style.height], [1280, 800, "1280px", "800px"]);
  assert.deepEqual(draws[0].args.slice(1), [0, 0, 1280, 800]);
});

test("a phone's tall frame fits the stage's height, its canvas at the device's pixels", async () => {
  const { canvas, frame } = viewer({ box: { width: 400, height: 800 }, dpr: 3, bitmaps: [bitmapOf(720, 1600)], kind: "phone" });
  await frame(1080, 2400);
  assert.deepEqual([canvas.style.width, canvas.style.height], ["360px", "800px"]);
  assert.deepEqual([canvas.width, canvas.height], [1080, 2400]);
});

test("a resize draws the frame on screen again at the new size; the next frame lets the one before go", async () => {
  const first = bitmapOf(1280, 720);
  const second = bitmapOf(1280, 720);
  const { canvas, draws, frame, resize } = viewer({ box: { width: 1280, height: 720 }, dpr: 1, bitmaps: [first, second] });
  await frame(1920, 1080);
  assert.deepEqual([canvas.width, canvas.height], [1280, 720]);
  // The stage changes size (the window, or the console's full-window view): the same frame, drawn again at the new size.
  resize({ width: 960, height: 540 });
  assert.deepEqual([canvas.width, canvas.height, canvas.style.width, canvas.style.height], [960, 540, "960px", "540px"], "at 1x the device's pixels are the CSS px");
  assert.deepEqual(draws.at(-1).args, [first, 0, 0, 960, 540]);
  assert.equal(draws.at(-1).quality, "high", "a resized canvas loses its context's settings, so they are set again");
  await frame(1920, 1080);
  assert.deepEqual(draws.at(-1).args, [second, 0, 0, 960, 540]);
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
});

test("a move to a display of another density redraws the frame at its pixels, with no resize and no new frame", async () => {
  const bitmap = bitmapOf(1280, 720);
  const { canvas, draws, frame, density, listening } = viewer({ box: { width: 960, height: 540 }, dpr: 1, bitmaps: [bitmap] });
  await frame(1920, 1080);
  assert.deepEqual(listening(), ["(resolution: 1dppx)"]);
  assert.deepEqual([canvas.width, canvas.height], [960, 540]);
  density(2);
  assert.deepEqual([canvas.width, canvas.height, canvas.style.width, canvas.style.height], [1920, 1080, "960px", "540px"]);
  assert.deepEqual(draws.at(-1).args, [bitmap, 0, 0, 1920, 1080]);
  assert.deepEqual(listening(), ["(resolution: 2dppx)"], "it listens for the next change, and no longer for the one it heard");
  density(1);
  assert.deepEqual([canvas.width, canvas.height], [960, 540]);
  assert.deepEqual(listening(), ["(resolution: 1dppx)"]);
});
