// A fake Chrome DevTools endpoint, enough of it for a screencast recorder: Target discovery and flat attach, Page.enable,
// Page.startScreencast with frames the test pushes, Runtime.evaluate answering what the test says, navigation events. It speaks
// WebSocket by hand (text frames, no extensions), so no package is needed.
import { createHash } from "node:crypto";
import http from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A JPEG-shaped buffer: SOI, one SOF0 segment carrying `w` x `h`, EOI, and `pad` bytes of filler. Not an image a viewer can draw. */
export function jpeg(w, h, pad = 0, tag = 0) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([tag & 255, (tag >> 8) & 255]), Buffer.alloc(pad, 7), Buffer.from([0xff, 0xd9])]);
}

function encode(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Reads client frames (masked text frames, possibly fragmented across chunks) out of a growing buffer. */
function decoder(onText, onClose) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
      const masked = (buffer[1] & 128) !== 0;
      if (buffer.length < at + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const body = Buffer.from(buffer.subarray(at, at + length));
      if (mask) for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
      buffer = buffer.subarray(at + length);
      if (opcode === 1) onText(body.toString("utf8"));
      else if (opcode === 8) { onClose(); return; }
    }
  };
}

/** `fakeCdp()` starts listening on a loopback port. `url` is the browser's debugger URL. Everything the client asked is in `calls`. */
export async function fakeCdp({ pages = [{ id: "PAGE1", url: "about:blank" }] } = {}) {
  const targets = new Map(pages.map((p) => [p.id, { ...p }]));
  const sockets = new Set();
  const flat = new Map(); // flat sessionId -> targetId
  const owner = new Map(); // flat sessionId -> the socket that attached
  const calls = [];
  const acks = [];
  const screencasts = new Map(); // flat sessionId -> startScreencast params
  const state = { secret: false, why: "field", answers: [], unchecked: false, evaluateError: false, evaluateDelayMs: 0, flatSeq: 0, screenshot: null, screenshotError: false, screenshotDelayMs: 0 };

  const send = (socket, message) => { if (!socket.destroyed) socket.write(encode(JSON.stringify(message))); };
  const broadcast = (message) => { for (const socket of sockets) send(socket, message); };
  const info = (t) => ({ targetId: t.id, type: "page", title: "", url: t.url, attached: false });

  function handle(socket, raw) {
    const message = JSON.parse(raw);
    const { id, method, params = {}, sessionId } = message;
    calls.push({ method, params, sessionId: sessionId ?? null, at: performance.now() });
    const reply = (result = {}) => send(socket, { id, ...(sessionId ? { sessionId } : {}), result });
    switch (method) {
      case "Target.setDiscoverTargets":
        reply();
        for (const t of targets.values()) send(socket, { method: "Target.targetCreated", params: { targetInfo: info(t) } });
        break;
      case "Target.attachToTarget": {
        const flatId = `FLAT${(state.flatSeq += 1)}`;
        flat.set(flatId, params.targetId);
        owner.set(flatId, socket);
        reply({ sessionId: flatId });
        send(socket, { method: "Target.attachedToTarget", params: { sessionId: flatId, targetInfo: info(targets.get(params.targetId) ?? { id: params.targetId, url: "" }), waitingForDebugger: false } });
        break;
      }
      case "Target.detachFromTarget": flat.delete(params.sessionId); screencasts.delete(params.sessionId); reply(); break;
      case "Page.startScreencast": screencasts.set(sessionId, params); reply(); break;
      case "Page.stopScreencast": screencasts.delete(sessionId); reply(); break;
      case "Page.screencastFrameAck": acks.push({ sessionId, frame: params.sessionId }); reply(); break;
      // A one-off screenshot (a client that asks for a frame instead of waiting for a repaint): `state.screenshot` is the JPEG it answers with; unset, the answer is empty, as for any method this fake does not know.
      case "Page.getLayoutMetrics": reply({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } }); break;
      case "Page.captureScreenshot":
        if (state.screenshotError) send(socket, { id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message: "Unable to capture screenshot" } });
        else setTimeout(() => reply(state.screenshot ? { data: Buffer.from(state.screenshot).toString("base64") } : {}), state.screenshotDelayMs);
        break;
      case "Runtime.evaluate":
        setTimeout(() => {
          if (state.evaluateError) send(socket, { id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message: "Execution context was destroyed." } });
          else { const scripted = state.answers.shift(); const value = state.unchecked ? null : scripted !== undefined ? scripted : { hold: state.secret, why: state.secret ? state.why : null }; reply({ result: { type: "object", value } }); }
        }, state.evaluateDelayMs);
        break;
      default: reply();
    }
  }

  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("data", decoder((text) => handle(socket, text), () => { socket.end(Buffer.from([0x88, 0x00])); }));
    socket.on("close", () => { sockets.delete(socket); for (const [flatId, holder] of owner) if (holder === socket) { owner.delete(flatId); flat.delete(flatId); screencasts.delete(flatId); } });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let frameSeq = 0;

  return {
    port, calls, acks, state,
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    /** How many clients are connected. */
    clients: () => sockets.size,
    /** The Page.startScreencast parameters of each flat session that holds one. */
    screencasts: () => [...screencasts.values()],
    /** Pushes one screencast frame from a page the client attached to (the newest attached flat session of that page); false if none. */
    frame({ page = "PAGE1", bytes = jpeg(800, 500) } = {}) {
      const flatId = [...flat.entries()].reverse().find(([, target]) => target === page)?.[0];
      if (!flatId || !screencasts.has(flatId)) return false;
      broadcast({ method: "Page.screencastFrame", sessionId: flatId, params: { data: Buffer.from(bytes).toString("base64"), metadata: { deviceWidth: 1280, deviceHeight: 800, timestamp: Date.now() / 1000 }, sessionId: (frameSeq += 1) } });
      return true;
    },
    /** A main-frame navigation of a page. */
    navigate(page, url) {
      const t = targets.get(page);
      if (t) t.url = url;
      const flatId = [...flat.entries()].reverse().find(([, target]) => target === page)?.[0];
      if (flatId) broadcast({ method: "Page.frameNavigated", sessionId: flatId, params: { frame: { id: page, url, loaderId: "L" } } });
      broadcast({ method: "Target.targetInfoChanged", params: { targetInfo: info(t ?? { id: page, url }) } });
    },
    /** A page's info changing with its address the same (a new title). */
    infoChanged(page) { const t = targets.get(page); if (t) broadcast({ method: "Target.targetInfoChanged", params: { targetInfo: { ...info(t), title: `title ${Date.now()}` } } }); },
    /** A subframe's navigation, which is not a page's. */
    navigateSubframe(page, url) {
      const flatId = [...flat.entries()].reverse().find(([, target]) => target === page)?.[0];
      if (flatId) broadcast({ method: "Page.frameNavigated", sessionId: flatId, params: { frame: { id: "CHILD", parentId: page, url, loaderId: "L2" } } });
    },
    newPage(id, url = "about:blank") { const t = { id, url }; targets.set(id, t); broadcast({ method: "Target.targetCreated", params: { targetInfo: info(t) } }); },
    destroyPage(id) { targets.delete(id); broadcast({ method: "Target.targetDestroyed", params: { targetId: id } }); },
    /** Drops every connection, as a network cut does. */
    cut() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}
