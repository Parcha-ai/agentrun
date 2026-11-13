// A driver of the attach binding (spec/computer/attach.md) as serve's tests run one: it pairs with a code over HTTP, then
// dials the attach WebSocket with its token and keeps it as a driver on any OS must. It pings each heartbeat, answers
// hello, screen.shot, screen.read and input.actions, closes with 1003 on a binary frame (ws closes with 1009 itself on a
// frame over maxPayload), and after a close it dials again by the protocol's rule: never after 4400, 4401 or 4426 or an
// upgrade refused 401, 403 or 426, else after redialDelay, the count reset by a socket that stayed up a minute. Every wait
// is the protocol's times `scale`. Nothing here is any one OS's: its hello is what a test gives it.
import WebSocket from "ws";

const { ATTACH_CLOSE, ATTACH_HEARTBEAT_MS, ATTACH_PATH, ATTACH_REDIAL_MAX_MS, ATTACH_SUBPROTOCOL, MAX_LINE_BYTES, PROTOCOL_VERSION, redialDelay, redials } = await import("@parcha/agentrun-computer");

/** A hello of no OS in particular. */
export const DRIVER_HELLO = { protocol: PROTOCOL_VERSION, version: "0.2.0-test", os: "linux", osVersion: "test", kind: "desktop", arch: "x86_64", groups: ["screen", "input.pointer", "input.keys"], screen: { width: 1, height: 1, scale: 1 } };
/** A 1x1 PNG. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** The upgrade answers a driver does not dial again after: a person must pair it again, or update it. */
const REFUSED = new Set([401, 403, 426]);

/** POST /v2/computers/pair at `address` (the server's origin): the driver's own request, with no token of the server's. */
export async function pairDriver({ address, code, name, hello = DRIVER_HELLO }) {
  const res = await fetch(`${address}/v2/computers/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, hello }) });
  return { status: res.status, body: await res.json() };
}

/**
 * The driver's socket to `address` with `token`: start() opens it (and the driver keeps it), stop() quits as a person
 * quitting the driver does (a close with 1001, no dial after). `calls` keeps each request the server sent, `closes` the
 * code of each socket's end. For a test that must see the cases fail: `takesBinary` keeps a socket a binary frame came
 * on, and `redialsAfter` replaces the protocol's rule of which closes are dialed again after.
 */
export function attachDriver({ address, token, hello = DRIVER_HELLO, scale = 1, onActions = async () => {}, takesBinary = false, redialsAfter = redials }) {
  const url = `${address.replace(/^http/, "ws")}${ATTACH_PATH}`;
  const calls = [];
  const closes = [];
  let running = false;
  let socket;
  let timer;
  let attempt = 0;
  /** Why it stopped dialing: an upgrade's status or a close's code. */
  let stopped;

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(dial, Math.max(1, Math.round(redialDelay(attempt++) * scale)));
  };

  function dial() {
    if (!running) return;
    const ws = new WebSocket(url, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_LINE_BYTES });
    socket = ws;
    let openedAt;
    let refused;
    let beat;
    let ended = false;
    ws.on("error", () => undefined);
    ws.once("unexpected-response", (req, res) => {
      refused = res.statusCode;
      req.destroy();
      end(undefined);
    });
    ws.once("open", () => {
      openedAt = Date.now();
      beat = setInterval(() => void (ws.readyState === WebSocket.OPEN && ws.ping()), Math.max(1, Math.round(ATTACH_HEARTBEAT_MS * scale)));
    });
    ws.on("message", async (data, binary) => {
      if (binary) return takesBinary ? undefined : ws.close(ATTACH_CLOSE.binary, "the attach binding takes text frames only");
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.id === undefined || typeof message.method !== "string") return;
      calls.push(message);
      const answer = (result) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "hello") return answer(hello);
      if (message.method === "screen.shot" || message.method === "screen.read") return answer({ id: "shot-1", data: PNG, eof: true, size: Buffer.from(PNG, "base64").length, width: 1, height: 1 });
      if (message.method === "input.actions") {
        await onActions(message.params);
        return answer({ done: message.params.actions.length });
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } }));
    });
    ws.once("close", (code) => end(code));

    function end(code) {
      if (ended) return;
      ended = true;
      clearInterval(beat);
      if (socket === ws) socket = undefined;
      if (code !== undefined) closes.push(code);
      if (!running) return;
      if (refused !== undefined && REFUSED.has(refused)) return void ((running = false), (stopped = { status: refused }));
      if (code !== undefined && refused === undefined && !redialsAfter(code)) return void ((running = false), (stopped = { code }));
      // A socket that stayed up a minute starts the count again.
      if (openedAt !== undefined && Date.now() - openedAt >= ATTACH_REDIAL_MAX_MS * scale) attempt = 0;
      later();
    }
  }

  return {
    calls,
    closes,
    /** Opens the socket, as a person opening the driver does; it is kept until stop(). */
    start() {
      if (running) return;
      running = true;
      stopped = undefined;
      attempt = 0;
      dial();
    },
    /** Quits: the socket closed with 1001, and no dial after. */
    stop() {
      running = false;
      clearTimeout(timer);
      socket?.close(ATTACH_CLOSE.going, "the driver is quitting");
    },
    /** Whether a socket is open now. */
    get open() {
      return socket?.readyState === WebSocket.OPEN;
    },
    get stopped() {
      return stopped;
    },
  };
}
