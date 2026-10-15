import { createHash } from "node:crypto";
import http from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const frame = (text) => {
  const data = Buffer.from(text);
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  if (data.length < 65536) return Buffer.concat([Buffer.from([0x81, 126, data.length >> 8, data.length & 255]), data]);
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
};

/** A browser's CDP endpoint that answers each command with `handle(method, params, { sessionId, emit, drop })` and
 *  records every command; `emit(method, params, sessionId)` sends an event and `drop()` cuts the connection. */
export async function fakeCdp(handle) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const mask = buffer[1] & 0x80 ? buffer.subarray(offset, offset + 4) : null;
        if (mask) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString("utf8"));
        calls.push(message);
        const emit = (method, params, sessionId) => socket.write(frame(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })));
        const drop = () => socket.destroy();
        const result = handle(message.method, message.params ?? {}, { sessionId: message.sessionId, emit, drop });
        if (!socket.destroyed) socket.write(frame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
    calls,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
