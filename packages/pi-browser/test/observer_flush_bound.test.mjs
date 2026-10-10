// flush()'s wait for the effects a holding session has announced, against a fake CDP endpoint (no Chrome): it ends when the
// request is paused (an event, however late it comes), it is bounded when the request never arrives, and a request that never
// arrived is forgotten, so it costs one bounded wait and not one on every later flush.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";

/** A CDP endpoint that answers every command with an empty result (a target list for Target.getTargets, a session for
 *  Target.attachToTarget), attaches one page session, and sends what the test tells it to. */
async function fakeBrowser() {
  let socket = null;
  const commands = [];
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  };
  const server = http.createServer();
  server.on("upgrade", (req, s) => {
    socket = s;
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    s.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(offset + 4 + length);
        if ((buffer.length >= 0) && payload.length) answer(JSON.parse(payload.toString()));
      }
    });
  });
  const answer = (m) => {
    const sessionId = m.sessionId;
    commands.push({ method: m.method, sessionId });
    if (m.method === "Target.getTargets") return send({ id: m.id, result: { targetInfos: [{ targetId: "T1", type: "page", url: "http://fake.test/" }] } });
    if (m.method === "Target.attachToTarget") {
      send({ id: m.id, result: { sessionId: "S1" } });
      return send({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "http://fake.test/" }, waitingForDebugger: false } });
    }
    send({ id: m.id, result: {}, ...(sessionId ? { sessionId } : {}) });
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/`,
    /** Every command the observer sent, with the session it went to. */
    commands,
    /** A frame in another process (a widget on another origin) attaches as an `iframe` target with a session of its own. */
    attachIframe: () => send({ method: "Target.attachedToTarget", params: { sessionId: "S2", targetInfo: { targetId: "T2", type: "iframe", url: "http://widget.test/" }, waitingForDebugger: false } }),
    /** The frame announces that its form is being submitted, before the request exists. */
    formIntent: (frameId) => send({ sessionId: "S2", method: "Page.frameRequestedNavigation", params: { frameId, reason: "formSubmissionPost", url: "http://widget.test/pay", disposition: "currentTab" } }),
    pauseForm: (frameId) => send({ sessionId: "S2", method: "Fetch.requestPaused", params: { requestId: "F9", networkId: "R9", frameId, resourceType: "Document", request: { method: "POST", url: "http://widget.test/api/iframe-form", headers: {} } } }),
    announce: (requestId) => send({ sessionId: "S1", method: "Network.requestWillBeSent", params: { requestId, request: { method: "POST", url: "http://fake.test/api/order" } } }),
    pause: (requestId, networkId) => send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId, networkId, resourceType: "Fetch", request: { method: "POST", url: "http://fake.test/api/order", headers: {} } } }),
    close: () => new Promise((resolve) => { socket?.destroy(); server.close(() => resolve()); }),
  };
}

test("flush waits for an announced request's pause as an event, and a request that never arrives costs one bounded wait", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("deny"));
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = new Map();
  observer.record((row) => { rows.set(row.requestId, row); });
  const took = async (work) => { const start = Date.now(); await work(); return Date.now() - start; };

  // Nothing announced: flush costs its round trip and nothing more.
  assert.ok(await took(() => observer.flush(undefined, 2_000)) < 500, "an idle flush does not wait");

  // Announced, and paused late: flush returns when the pause arrives, with the decision journaled, far inside its bound.
  browser.announce("R1");
  setTimeout(() => browser.pause("F1", "R1"), 150);
  const waited = await took(() => observer.flush(undefined, 10_000));
  assert.ok(waited >= 100 && waited < 3_000, `flush waited for the pause (${waited} ms)`);
  assert.deepEqual([...rows.values()].map((row) => `${row.method} ${row.path} ${row.held}`), ["POST /api/order denied"], "and the request is in the journal");

  // Announced and never paused: the wait ends at its bound, and the entry is forgotten, so the next flush is not held.
  browser.announce("R2");
  const bounded = await took(() => observer.flush(undefined, 400));
  assert.ok(bounded >= 350 && bounded < 3_000, `the wait is bounded (${bounded} ms)`);
  assert.ok(await took(() => observer.flush(undefined, 400)) < 300, "a request that never arrived is not waited for again");
});

test("a request announced while a flush is waiting is not forgotten when that wait times out", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("deny"));
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = new Map();
  observer.record((row) => { rows.set(row.requestId, row); });
  const took = async (work) => { const start = Date.now(); await work(); return Date.now() - start; };

  // R1 never arrives; the flush waiting for it times out. R2, announced while it waits, is newer than what that wait covered.
  browser.announce("R1");
  setTimeout(() => browser.announce("R2"), 150);
  assert.ok(await took(() => observer.flush(undefined, 500)) >= 450, "the first wait ran to its bound");
  // R2's pause comes after that flush returned. The next flush still waits for it and has it journaled when it returns.
  setTimeout(() => browser.pause("F2", "R2"), 120);
  const second = await took(() => observer.flush(undefined, 5_000));
  assert.ok(second >= 80 && second < 3_000, `the second flush waited for R2 (${second} ms)`);
  assert.deepEqual([...rows.values()].map((row) => `${row.method} ${row.path} ${row.held}`), ["POST /api/order denied"], "R2 is in the journal");
});

test("a frame in another process announces its form's intent: Page is enabled on it, and flush waits for the POST that follows", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("deny"));
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = new Map();
  observer.record((row) => { rows.set(row.requestId, row); });
  const took = async (work) => { const start = Date.now(); await work(); return Date.now() - start; };

  browser.attachIframe();
  for (const end = Date.now() + 5_000; !browser.commands.some((c) => c.method === "Page.enable" && c.sessionId === "S2"); ) {
    if (Date.now() > end) assert.fail("the observer never enabled Page on the iframe target, so its forms' intent is never announced");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // The widget submits its form: the intent comes first, the request (paused by the observer) a moment later. flush, asked for in between,
  // waits for the pause and returns with the decision journaled.
  browser.formIntent("FR1");
  setTimeout(() => browser.pauseForm("FR1"), 150);
  const waited = await took(() => observer.flush(undefined, 10_000));
  assert.ok(waited >= 100 && waited < 3_000, `flush waited for the iframe form's POST (${waited} ms)`);
  assert.deepEqual([...rows.values()].map((row) => `${row.method} ${row.path} ${row.held}`), ["POST /api/iframe-form denied"], "and the POST is in the journal");
});
