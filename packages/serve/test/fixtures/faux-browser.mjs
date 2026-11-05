// The `browser` tool's provider and driver for the tests: pi-browser's fake backend, with one page and no network or
// key. Each call it answers is appended to $FAUX_BROWSER_LOG, so a test reads what the run's process did; its first
// line says whether the Browserbase variables reached it in the env the real provider gets (never their values), its
// second which vendor the run's plane named (`browserbase`, `kernel`, or why it is unavailable) and whether Kernel's key
// reached it. The page names the vendor too, so the run's answer says which browser it got. Kernel's provider keeps
// no downloads, and neither does this one when the vendor is Kernel. Its provider is named for the vendor, so the run
// prices its session time as that vendor's, or $FAUX_BROWSER_PROVIDER's.
//
// A session's DevTools address (what the live view streams from) is a fake DevTools endpoint of this module's own, on
// loopback in the run's process, never the backend's sentinel vendor address: it has one page, and sends one screencast
// frame (FRAME, bytes no image decoder needs) once the page's screencast starts. It is started at the first attach.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

/** The screencast frame the fake DevTools endpoint sends: its bytes, and the page's size it reports. */
export const FRAME = { bytes: Buffer.from("faux-live-view-frame"), w: 1280, h: 800 };

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encode = (text) => {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
};
/** Masked client text frames out of a growing buffer. */
const decoder = (onText) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 127;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
      const masked = (buffer[1] & 128) !== 0;
      if (buffer.length < at + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const body = Buffer.from(buffer.subarray(at, at + length));
      if (mask) for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
      const opcode = buffer[0] & 15;
      buffer = buffer.subarray(at + length);
      if (opcode === 1) onText(body.toString("utf8"));
    }
  };
};

let devtools;
/** The fake DevTools endpoint's address, started once. */
const devtoolsUrl = () => (devtools ??= new Promise((resolve) => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
    const send = (message) => { if (!socket.destroyed) socket.write(encode(JSON.stringify(message))); };
    const page = { targetId: "PAGE1", type: "page", title: "Example", url: "https://example.test/", attached: false };
    socket.on("data", decoder((text) => {
      const { id, method, sessionId } = JSON.parse(text);
      send({ id, ...(sessionId ? { sessionId } : {}), result: {} });
      if (method === "Target.setDiscoverTargets") send({ method: "Target.targetCreated", params: { targetInfo: page } });
      else if (method === "Target.attachToTarget") send({ method: "Target.attachedToTarget", params: { sessionId: "FLAT1", targetInfo: page, waitingForDebugger: false } });
      else if (method === "Page.startScreencast") send({ method: "Page.screencastFrame", sessionId: "FLAT1", params: { data: FRAME.bytes.toString("base64"), metadata: { deviceWidth: FRAME.w, deviceHeight: FRAME.h }, sessionId: 1 } });
    }));
  });
  server.listen(0, "127.0.0.1", () => {
    server.unref();
    resolve(`ws://127.0.0.1:${server.address().port}/devtools/browser/faux`);
  });
}));

export default function browser(env = process.env, vendor = "browserbase") {
  const log = process.env.FAUX_BROWSER_LOG;
  const seen = (name) => (env[name] ? "set" : "unset");
  if (log) appendFileSync(log, `${JSON.stringify({ op: "env", BROWSERBASE_API_KEY: seen("BROWSERBASE_API_KEY"), BROWSERBASE_PROJECT_ID: seen("BROWSERBASE_PROJECT_ID") })}\n`);
  if (log) appendFileSync(log, `${JSON.stringify({ op: "vendor", vendor, KERNEL_API_KEY: seen("KERNEL_API_KEY") })}\n`);
  const start = "https://example.test/";
  const backend = new FakeBackend({ name: process.env.FAUX_BROWSER_PROVIDER || vendor, start, pages: { [start]: fixturePage(start, `The answer is forty-two. This browser is ${vendor}'s.`, "Example") }, ...(log ? { logFile: log } : {}) });
  const { downloads: _, ...withoutDownloads } = backend.provider;
  const base = vendor === "kernel" ? withoutDownloads : backend.provider;
  // The session's id stays in the address's query, where the fake driver reads it.
  const attach = async (ref, signal) => {
    const target = await base.attach(ref, signal);
    const id = new URL(target.sdkCdpUrl).searchParams.get("sessionId") ?? "";
    return { ...target, sdkCdpUrl: `${await devtoolsUrl()}?sessionId=${encodeURIComponent(id)}` };
  };
  return { provider: { ...base, attach }, driver: fakeDriver(backend) };
}
