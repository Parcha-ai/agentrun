// A raw WebSocket client for the live view's tests: it can set any Origin and any path, which a browser's WebSocket cannot, and it reads the
// server's frames and close code exactly as sent.
import { randomBytes } from "node:crypto";
import http from "node:http";

function maskedFrame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/** Resolves `{ status }` when the server answered with a plain HTTP response (a refusal), or `{ status: 101, ws }` when it upgraded. */
export function connect(url, { origin, headers = {} } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...(origin === undefined ? {} : { Origin: origin }), ...headers },
    });
    req.on("response", (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("upgrade", (res, socket, head) => {
      let buffer = Buffer.from(head);
      const queue = [];
      const waiting = [];
      let closed = null;
      const push = (item) => { const w = waiting.shift(); if (w) w(item); else queue.push(item); };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = buffer[0] & 0x0f;
          let length = buffer[1] & 0x7f, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) push({ type: "text", data: payload.toString("utf8") });
          else if (opcode === 0x2) push({ type: "binary", data: Buffer.from(payload) });
          else if (opcode === 0xa) push({ type: "pong", data: Buffer.from(payload) });
          else if (opcode === 0x8) { closed = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString("utf8") }; push({ type: "close", ...closed }); }
        }
      });
      let ended;
      const gone = new Promise((r) => { ended = r; });
      socket.on("close", () => { if (!closed) { closed = { code: 1006, reason: "" }; push({ type: "close", ...closed }); } ended(); });
      socket.on("error", () => {});
      const ws = {
        sendText: (text) => socket.write(maskedFrame(0x1, Buffer.from(text))),
        sendJson: (value) => socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(value)))),
        sendBinary: (bytes) => socket.write(maskedFrame(0x2, bytes)),
        /** Bytes exactly as given, for frames a conforming client would never send. */
        sendRaw: (bytes) => socket.write(Buffer.from(bytes)),
        sendUnmasked: (text) => { const p = Buffer.from(text); socket.write(Buffer.concat([Buffer.from([0x81, p.length]), p])); },
        /** The next message, or `{ type: "none" }` after `ms`. */
        next: (ms = 2_000) => new Promise((r) => { if (queue.length) return r(queue.shift()); const t = setTimeout(() => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); r({ type: "none" }); }, ms); const w = (item) => { clearTimeout(t); r(item); }; waiting.push(w); }),
        /** Reads messages until one satisfies `want`; the others are returned too. */
        until: async (want, ms = 2_000) => { const seen = []; const end = Date.now() + ms; for (;;) { const item = await ws.next(Math.max(1, end - Date.now())); seen.push(item); if (want(item)) return { item, seen }; if (item.type === "none" || item.type === "close") return { item: null, seen }; } },
        closedWith: () => closed,
        gone: () => gone,
        destroy: () => socket.destroy(),
      };
      resolve({ status: 101, ws });
    });
    req.on("error", reject);
    req.end();
  });
}
