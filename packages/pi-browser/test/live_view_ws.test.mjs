// ws.ts is the parser in front of a full-control browser. Each rule it keeps has a test: unmasked frames, reserved bits, unknown opcodes, a message
// over the cap (a single frame, a declared 64-bit length, fragments that add up), continuation handling, ping and close, bad UTF-8; and a seeded
// fuzz over random bytes shows that nothing throws and that nothing gets through before the hello.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createLiveView } from "../dist/live-view/index.js";
import { acceptWebSocket } from "../dist/live-view/ws.js";
import { connect } from "./fixtures/ws-client.mjs";

const CAP = 64 * 1024;
/** One client frame, masked unless asked otherwise; `declared` overrides the length a frame announces. */
function frame({ fin = true, rsv = 0, opcode = 1, mask = true, payload = Buffer.alloc(0), declared } = {}) {
  const n = declared ?? payload.length;
  const first = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  const m = mask ? 0x80 : 0;
  const head = n < 126 ? Buffer.from([first, m | n]) : n < 65536 ? Buffer.from([first, m | 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = first; h[1] = m | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4];
  return Buffer.concat([head, key, body]);
}
const close = (c) => c.ws.until((m) => m.type === "close").then((r) => r.item);

async function rig(t) {
  const got = { messages: [], closes: 0 };
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  // Upgraded sockets are no longer the http server's: they are ended here, or a failed assertion would leave `close` waiting on them.
  const sockets = new Set();
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    conn.onMessage = (data, binary) => { got.messages.push({ data: binary ? Buffer.from(data) : data, binary }); };
    conn.onClose = () => { got.closes += 1; };
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { got, url, open: async () => { const c = await connect(url, {}); assert.equal(c.status, 101); return c; } };
}

test("an unmasked client frame ends the connection with 1002 and delivers nothing", async (t) => {
  const r = await rig(t);
  const c = await r.open();
  c.ws.sendRaw(frame({ opcode: 1, mask: false, payload: Buffer.from("hi") }));
  assert.equal((await close(c)).code, 1002);
  assert.deepEqual(r.got.messages, []);
});

test("reserved bits and unknown opcodes end the connection with 1002", async (t) => {
  const r = await rig(t);
  for (const bad of [frame({ rsv: 4, payload: Buffer.from("x") }), frame({ rsv: 2, payload: Buffer.from("x") }), frame({ rsv: 1, payload: Buffer.from("x") }), frame({ opcode: 0x3 }), frame({ opcode: 0x7 }), frame({ opcode: 0xb }), frame({ opcode: 0xf })]) {
    const c = await r.open();
    c.ws.sendRaw(bad);
    assert.equal((await close(c)).code, 1002, bad.subarray(0, 2).toString("hex"));
  }
  assert.deepEqual(r.got.messages, []);
});

test("a single frame over the cap ends with 1009 before any of it is read: 16-bit and 64-bit announced lengths, no body sent", async (t) => {
  const r = await rig(t);
  const before = process.memoryUsage().arrayBuffers;
  for (const declared of [CAP + 1, 2 ** 31, 2 ** 40, 2 ** 53]) {
    const c = await r.open();
    c.ws.sendRaw(frame({ opcode: 2, declared, payload: Buffer.alloc(0) }).subarray(0, declared < 65536 ? 8 : 14));
    assert.equal((await close(c)).code, 1009, `declared ${declared}`);
  }
  // The 64-bit length with its top bit set is no length at all.
  const c = await r.open();
  const head = Buffer.alloc(14); head[0] = 0x82; head[1] = 0x80 | 127; head.writeBigUInt64BE(2n ** 63n, 2);
  c.ws.sendRaw(head);
  assert.equal((await close(c)).code, 1009);
  assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024, "nothing was allocated from an announced length");
  assert.deepEqual(r.got.messages, []);
});

test("a message at the cap passes and one byte over fails, fragments counted together", async (t) => {
  const r = await rig(t);
  const ok = await r.open();
  ok.ws.sendRaw(frame({ opcode: 2, payload: Buffer.alloc(CAP, 1) }));
  for (let i = 0; i < 100 && r.got.messages.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(r.got.messages[0]?.data.length, CAP);
  const frags = await r.open();
  frags.ws.sendRaw(Buffer.concat([frame({ fin: false, opcode: 2, payload: Buffer.alloc(30_000) }), frame({ fin: false, opcode: 0, payload: Buffer.alloc(30_000) })]));
  frags.ws.sendRaw(frame({ fin: true, opcode: 0, payload: Buffer.alloc(30_000) }));
  assert.equal((await close(frags)).code, 1009, "three fragments of 30,000 bytes are 90,000");
  assert.equal(r.got.messages.length, 1, "the over-cap message was never delivered");
});

test("continuation frames: a message in fragments is reassembled (a ping between them is answered); a stray continuation, or a new message inside one, is refused", async (t) => {
  const r = await rig(t);
  const good = await r.open();
  good.ws.sendRaw(Buffer.concat([frame({ fin: false, opcode: 1, payload: Buffer.from("hel") }), frame({ opcode: 9, payload: Buffer.from("p") }), frame({ fin: false, opcode: 0, payload: Buffer.from("lo ") }), frame({ fin: true, opcode: 0, payload: Buffer.from("world") })]));
  const pong = await good.ws.next();
  assert.deepEqual([pong.type, pong.data.toString()], ["pong", "p"]);
  for (let i = 0; i < 100 && r.got.messages.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(r.got.messages, [{ data: "hello world", binary: false }]);
  const stray = await r.open();
  stray.ws.sendRaw(frame({ fin: true, opcode: 0, payload: Buffer.from("x") }));
  assert.equal((await close(stray)).code, 1002);
  const inside = await r.open();
  inside.ws.sendRaw(Buffer.concat([frame({ fin: false, opcode: 1, payload: Buffer.from("a") }), frame({ fin: true, opcode: 1, payload: Buffer.from("b") })]));
  assert.equal((await close(inside)).code, 1002);
  assert.equal(r.got.messages.length, 1);
});

test("ping is answered with its own payload, close is answered, and a control frame that is fragmented or longer than 125 bytes is refused", async (t) => {
  const r = await rig(t);
  const c = await r.open();
  c.ws.sendRaw(frame({ opcode: 9, payload: Buffer.from("are you there") }));
  const pong = await c.ws.next();
  assert.deepEqual([pong.type, pong.data.toString()], ["pong", "are you there"]);
  c.ws.sendRaw(frame({ opcode: 0xa, payload: Buffer.from("unsolicited") }));
  c.ws.sendRaw(frame({ opcode: 8, payload: Buffer.from([0x03, 0xe8]) }));
  assert.equal((await close(c)).code, 1000);
  for (const bad of [frame({ fin: false, opcode: 9, payload: Buffer.from("x") }), frame({ opcode: 9, payload: Buffer.alloc(126) }), frame({ opcode: 8, payload: Buffer.alloc(126) })]) {
    const x = await r.open();
    x.ws.sendRaw(bad);
    assert.equal((await close(x)).code, 1002);
  }
});

test("text that is not UTF-8 ends the connection with 1007; binary is delivered as it is", async (t) => {
  const r = await rig(t);
  const c = await r.open();
  c.ws.sendRaw(frame({ opcode: 1, payload: Buffer.from([0xff, 0xfe, 0xfd]) }));
  assert.equal((await close(c)).code, 1007);
  const b = await r.open();
  b.ws.sendRaw(frame({ opcode: 2, payload: Buffer.from([0xff, 0xfe]) }));
  for (let i = 0; i < 100 && r.got.messages.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(r.got.messages, [{ data: Buffer.from([0xff, 0xfe]), binary: true }]);
});

test("a vanished peer ends the connection: its FIN is answered, so close is seen", async (t) => {
  const r = await rig(t);
  const c = await r.open();
  c.ws.destroy();
  for (let i = 0; i < 100 && r.got.closes < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(r.got.closes, 1);
});

// A small seeded generator, so a failing run can be replayed.
function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

test("fuzz: random bytes and mangled frames never throw out of the parser, and the server still answers after them", async (t) => {
  const r = await rig(t);
  const rand = prng(20261015);
  const escaped = [];
  const onThrow = (e) => escaped.push(String(e));
  process.on("uncaughtException", onThrow);
  process.on("unhandledRejection", onThrow);
  t.after(() => { process.off("uncaughtException", onThrow); process.off("unhandledRejection", onThrow); });
  for (let i = 0; i < 300; i += 1) {
    const c = await r.open();
    const pieces = 1 + Math.floor(rand() * 4);
    for (let p = 0; p < pieces; p += 1) {
      const kind = Math.floor(rand() * 4);
      const n = 1 + Math.floor(rand() * 40);
      let bytes;
      if (kind === 0) bytes = Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256)));
      else if (kind === 1) bytes = frame({ opcode: Math.floor(rand() * 16), rsv: Math.floor(rand() * 8), fin: rand() < 0.5, mask: rand() < 0.8, payload: Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))) });
      else if (kind === 2) bytes = frame({ opcode: 1 + Math.floor(rand() * 2), declared: Math.floor(rand() * 2 ** 33), payload: Buffer.alloc(0) }).subarray(0, 2 + Math.floor(rand() * 12));
      else bytes = frame({ fin: false, opcode: Math.floor(rand() * 3), payload: Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))) });
      c.ws.sendRaw(bytes);
    }
    c.ws.destroy();
  }
  await new Promise((x) => setTimeout(x, 200));
  assert.deepEqual(escaped, []);
  const alive = await r.open();
  alive.ws.sendRaw(frame({ opcode: 9, payload: Buffer.from("ok") }));
  assert.equal((await alive.ws.next()).type, "pong");
});

test("fuzz through the whole server: nothing before a valid hello starts a stream or reaches the browser, however well-formed", async (t) => {
  const made = [];
  const host = createLiveView({ hostOrigin: null, helloTimeoutMs: 100, viewer: { html: "", js: "", css: "" }, stream: (url, handlers) => { made.push({ url, handlers }); return { input: async () => { throw new Error("reached the browser"); }, nav: async () => { throw new Error("reached the browser"); }, dialog: async () => { throw new Error("reached the browser"); }, close() {} }; }, gates: () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} }) });
  t.after(() => host.close());
  const view = await host.open("ar-run-9-1", "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  const url = `http://${u.host}${u.pathname}/ws`;
  const rand = prng(7);
  const input = [{ type: "mouse", action: "down", x: 1, y: 1 }, { type: "text", text: "secret" }, { type: "nav", action: "url", url: "https://example.com/" }, { type: "key", action: "down", key: "a", code: "KeyA" }, { type: "dialog", accept: true }, { type: "hello", token: "wrong" }, { type: "hello" }];
  const escaped = [];
  const onThrow = (e) => escaped.push(String(e));
  process.on("uncaughtException", onThrow);
  t.after(() => process.off("uncaughtException", onThrow));
  for (let i = 0; i < 120; i += 1) {
    const c = await connect(url, { origin: u.origin });
    assert.equal(c.status, 101);
    if (rand() < 0.5) c.ws.sendJson(input[Math.floor(rand() * input.length)]);
    else c.ws.sendRaw(frame({ opcode: Math.floor(rand() * 16), rsv: Math.floor(rand() * 8), mask: rand() < 0.7, payload: randomBytes(1 + Math.floor(rand() * 60)) }));
    await c.ws.next(30);
    c.ws.destroy();
  }
  assert.deepEqual([made.length, escaped], [0, []]);
});

test("a message of empty fragments is bounded too: a non-final frame and unlimited empty continuations end with 1009, nothing is kept per frame", async (t) => {
  const r = await rig(t);
  const c = await r.open();
  c.ws.sendRaw(frame({ fin: false, opcode: 1, payload: Buffer.alloc(0) }));
  const empty = frame({ fin: false, opcode: 0, payload: Buffer.alloc(0) });
  for (let i = 0; i < 20; i += 1) c.ws.sendRaw(Buffer.concat(Array.from({ length: 50 }, () => empty)));
  assert.equal((await close(c)).code, 1009, "1,000 empty continuation frames never finish a message");
  assert.deepEqual(r.got.messages, []);
  const ok = await r.open();
  ok.ws.sendRaw(Buffer.concat([frame({ fin: false, opcode: 1, payload: Buffer.from("a") }), ...Array.from({ length: 10 }, () => frame({ fin: false, opcode: 0, payload: Buffer.from("b") })), frame({ fin: true, opcode: 0, payload: Buffer.from("c") })]));
  for (let i = 0; i < 100 && r.got.messages.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(r.got.messages, [{ data: "abbbbbbbbbbc", binary: false }], "an ordinary fragmented message still works");
});
