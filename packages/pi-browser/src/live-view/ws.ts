// A WebSocket server for one upgraded socket (RFC 6455): text and binary messages, fragmentation, ping/pong, close. It is as small as the
// viewer needs and takes no dependency. Client frames must be masked; a message larger than `maxPayload` ends the connection.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A message of more frames than this is cut off (1009), whatever its bytes: input messages arrive whole or in a few frames. */
const MAX_FRAGMENTS = 64;
/** A client that pings and never reads its pongs is cut off past this many queued bytes. */
const MAX_QUEUED_WRITE = 1 << 20;

export type WsConn = {
  /** False when the connection is closed. `done` runs once the bytes were handed to the operating system (or the connection ended). */
  send(data: string | Uint8Array, done?: () => void): boolean;
  /** Sends a close frame and ends the socket. Idempotent. */
  close(code: number, reason?: string): void;
  /** Bytes written and not yet taken by the network: a slow viewer shows here. */
  readonly buffered: number;
  readonly closed: boolean;
  onMessage: (data: string | Buffer, binary: boolean) => void;
  onClose: () => void;
};

export type WsOptions = { maxPayload?: number };

/** Completes the handshake on `socket` and returns the connection; null (with the socket destroyed after a 400) when the request is not a valid
 *  WebSocket upgrade. The caller has already decided the request may proceed (path, Origin). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, options: WsOptions = {}): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (req.method !== "GET" || upgrade !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  const maxPayload = options.maxPayload ?? 64 * 1024;
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let closed = false;
  let sentClose = false;
  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  /** How many frames the message being assembled has had, empty ones included: a message of unlimited empty fragments adds no bytes and would never reach the size cap. */
  let fragmentFrames = 0;
  /** A message is being assembled: its first frame was not final. Kept apart from `fragments`, which holds only frames that carry bytes. */
  let inMessage = false;
  let fragmentBinary = false;
  const conn: WsConn = {
    send(data, done) {
      if (closed || sentClose) return false;
      const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      socket.write(frame(typeof data === "string" ? 0x1 : 0x2, payload), () => done?.());
      return true;
    },
    close(code, reason = "") {
      if (!sentClose && !closed) {
        sentClose = true;
        const text = Buffer.from(reason.slice(0, 100), "utf8");
        const payload = Buffer.allocUnsafe(2 + text.length);
        payload.writeUInt16BE(code, 0);
        text.copy(payload, 2);
        try { socket.write(frame(0x8, payload)); } catch { /* already gone */ }
      }
      // The socket ends after the close frame is flushed; a peer that never answers is cut off.
      socket.end();
      const timer = setTimeout(() => socket.destroy(), 1_000);
      timer.unref();
    },
    get buffered() { return socket.writableLength; },
    get closed() { return closed || sentClose; },
    onMessage: () => {},
    onClose: () => {},
  };
  const finish = () => { if (closed) return; closed = true; conn.onClose(); };
  const fail = (code: number, reason: string) => { conn.close(code, reason); };

  const deliver = (binary: boolean, payload: Buffer) => {
    if (binary) { conn.onMessage(payload, true); return; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload); } catch { fail(1007, "text is not utf-8"); return; }
    conn.onMessage(text, false);
  };

  const drain = () => {
    while (!closed && !sentClose) {
      if (buffer.length < 2) return;
      const first = buffer[0]!, second = buffer[1]!;
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f;
      if ((first & 0x70) !== 0) return fail(1002, "reserved bits");
      if ((second & 0x80) === 0) return fail(1002, "client frames are masked");
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return fail(1009, "message too big");
        length = Number(big); offset = 10;
      }
      if (length > maxPayload) return fail(1009, "message too big");
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + 4 + i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) return fail(1002, "bad control frame");
        if (opcode === 0x8) { conn.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return; }
        if (opcode === 0x9) {
          if (socket.writableLength > MAX_QUEUED_WRITE) return fail(1008, "too slow to read");
          if (!closed) socket.write(frame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        return fail(1002, "unknown opcode");
      }
      if (opcode === 0x0) {
        if (!inMessage) return fail(1002, "unexpected continuation");
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (inMessage) return fail(1002, "interleaved message");
        fragmentBinary = opcode === 0x2;
      } else return fail(1002, "unknown opcode");
      fragmentFrames += 1;
      if (fragmentFrames > MAX_FRAGMENTS) return fail(1009, "too many fragments");
      if (payload.length > 0) { fragments.push(payload); fragmentBytes += payload.length; }
      if (fragmentBytes > maxPayload) return fail(1009, "message too big");
      inMessage = !fin;
      if (fin) {
        const whole = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments);
        fragments = []; fragmentBytes = 0; fragmentFrames = 0; inMessage = false;
        deliver(fragmentBinary, whole);
      }
    }
  };
  socket.on("data", (chunk: Buffer) => { buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk; drain(); });
  // An HTTP server's sockets allow half-open: a viewer that vanishes sends only a FIN, and without answering it `close` never comes.
  socket.on("end", () => { socket.end(); });
  socket.on("close", finish);
  socket.on("error", () => { socket.destroy(); finish(); });
  if (buffer.length) queueMicrotask(drain);
  return conn;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, payload]);
}
