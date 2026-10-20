// A CDP endpoint on loopback for tests that need the wire itself: it answers every command empty (or as `answer` says), can send
// any frame, including ones that are not JSON, records the commands it receives and the upgrade request's headers, and says when
// the client closed its socket.
import { createHash } from "node:crypto";
import http from "node:http";

export async function startFakeCdp({ answer } = {}) {
  let socket = null;
  const sockets = new Set();
  const commands = [];
  const upgrades = [];
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  const frame = (text) => {
    const body = Buffer.from(text);
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  };
  const sendRaw = (text) => frame(text);
  const send = (message) => frame(JSON.stringify(message));
  const server = http.createServer();
  server.on("upgrade", (req, s) => {
    socket = s;
    sockets.add(s);
    upgrades.push({ authorization: req.headers.authorization ?? null, protocol: req.headers["sec-websocket-protocol"] ?? null });
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`);
    s.on("close", () => closedResolve());
    s.on("error", () => closedResolve());
    let buffer = Buffer.alloc(0);
    s.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) { closedResolve(); continue; }
        if (opcode === 1 && payload.length) reply(JSON.parse(payload.toString()));
      }
    });
  });
  const reply = (m) => {
    commands.push({ id: m.id, method: m.method, sessionId: m.sessionId, params: m.params });
    if (answer?.(m, { send, sendRaw })) return;
    if (m.method === "Target.getTargets") return send({ id: m.id, result: { targetInfos: [{ targetId: "T1", type: "page", url: "http://fake.test/" }] } });
    if (m.method === "Target.attachToTarget") {
      send({ id: m.id, result: { sessionId: "S1" } });
      return send({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "http://fake.test/" }, waitingForDebugger: false } });
    }
    send({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/`,
    commands, upgrades, closed, send, sendRaw,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
