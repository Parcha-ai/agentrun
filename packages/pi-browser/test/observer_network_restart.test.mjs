import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { EffectObserver, effectDecider, pageTools } from "@parcha/pi-browser";

/** A stand-in CDP endpoint with one page session. `SystemInfo.getProcessInfo` names a network service whose pid the test
 *  sets; every other command answers empty. */
async function fakeBrowser() {
  let socket = null;
  let servicePid = 100;
  let refusing = false;
  let hanging = false;
  let bare = false;
  const commands = [];
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  };
  const server = http.createServer();
  const sockets = new Set();
  server.on("connection", (c) => { sockets.add(c); c.on("close", () => sockets.delete(c)); });
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
        if (payload.length) answer(JSON.parse(payload.toString()));
      }
    });
  });
  const answer = (m) => {
    commands.push({ method: m.method, params: m.params });
    if (m.method === "Target.getTargets") return send({ id: m.id, result: { targetInfos: [{ targetId: "T1", type: "page", url: "http://fake.test/" }] } });
    if (m.method === "Target.attachToTarget") {
      send({ id: m.id, result: { sessionId: "S1" } });
      return send({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page", url: "http://fake.test/" }, waitingForDebugger: false } });
    }
    if (m.method === "SystemInfo.getProcessInfo" && hanging) return;
    if (m.method === "SystemInfo.getProcessInfo" && bare) return send({ id: m.id });
    if (m.method === "SystemInfo.getProcessInfo" && refusing) return send({ id: m.id, error: { code: -32601, message: "'SystemInfo.getProcessInfo' wasn't found" } });
    if (m.method === "SystemInfo.getProcessInfo") return send({ id: m.id, result: { processInfo: [{ type: "browser", id: 1 }, ...(servicePid ? [{ type: "network.mojom.NetworkService", id: servicePid }] : [])] } });
    send({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = (path) => `http://fake.test${path}`;
  return {
    url: `ws://127.0.0.1:${server.address().port}/`,
    commands,
    asked: () => commands.filter((c) => c.method === "SystemInfo.getProcessInfo").length,
    /** The network service dies and Chrome starts another (`null`: none is running yet). */
    restart: (pid) => { servicePid = pid; },
    /** The endpoint refuses the question, as a provider's may. */
    refuseService: () => { refusing = true; },
    /** The connection stays open and never answers the question. */
    hangService: () => { hanging = true; },
    /** A relay that answers the question with its id and no result. */
    bareService: () => { bare = true; },
    /** A redirect hop: the same request id announced again, with the response that redirected it. */
    redirected: (requestId, path) => send({ sessionId: "S1", method: "Network.requestWillBeSent", params: { requestId, type: "Fetch", redirectResponse: { status: 307 }, request: { method: "POST", url: `http://other.test${path}` } } }),
    responded: (requestId) => send({ sessionId: "S1", method: "Network.responseReceived", params: { requestId, type: "Fetch", response: { status: 200 } } }),
    pauseAt: (requestId, networkId, origin, path) => send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId, networkId, resourceType: "Fetch", request: { method: "POST", url: `${origin}${path}`, headers: {} } } }),
    announce: (requestId, path = "/api/order") => send({ sessionId: "S1", method: "Network.requestWillBeSent", params: { requestId, type: "Fetch", request: { method: "POST", url: `${url(path)}?card=4111` } } }),
    pause: (requestId, networkId, path = "/api/order") => send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId, networkId, resourceType: "Fetch", request: { method: "POST", url: url(path), headers: {} } } }),
    /** A form's intent, before its request exists, then its Document request and pause. */
    formIntent: (frameId) => send({ sessionId: "S1", method: "Page.frameRequestedNavigation", params: { frameId, reason: "formSubmissionPost", url: url("/submit"), disposition: "currentTab" } }),
    announceForm: (requestId, frameId = "FR1") => send({ sessionId: "S1", method: "Network.requestWillBeSent", params: { requestId, frameId, type: "Document", request: { method: "POST", url: url("/submit") } } }),
    pauseForm: (requestId, networkId, frameId) => send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId, networkId, frameId, resourceType: "Document", request: { method: "POST", url: url("/submit"), headers: {} } } }),
    failed: (requestId) => send({ sessionId: "S1", method: "Network.loadingFailed", params: { requestId, type: "Fetch", errorText: "net::ERR_ABORTED" } }),
    close: () => new Promise((resolve) => { for (const c of sockets) c.destroy(); server.close(() => resolve()); }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rig(t, decide = effectDecider("deny")) {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, decide);
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = [];
  const lost = [];
  const stop = observer.record((row) => { rows.push(`${row.requestId} ${row.method} ${row.path} ${row.held}`); }, (request) => { lost.push(request); });
  return { browser, observer, rows, lost, stop };
}

test("a request the network service took with it before its pause is told to the call as lost, with the journal row's fields only, and is never journaled", async (t) => {
  const { browser, observer, rows, lost } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost, [{ requestId: "R1", method: "POST", origin: "http://fake.test", path: "/api/order" }], "the call heard of it once, with no query, body or header");
  assert.deepEqual(rows, [], "a lost request is never journaled, so never as sent or allowed");
});

test("a lost request whose pause comes after all is refused and journaled denied, never sent: the call was told it was not sent", async (t) => {
  const { browser, observer, rows, lost } = await rig(t, effectDecider("allow"));
  browser.announce("R1");
  await sleep(100);
  browser.restart(200);
  await observer.flush(undefined, 1_000);
  assert.equal(lost.length, 1);
  browser.pause("F1", "R1");
  await sleep(100);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(rows, ["R1 POST /api/order pending", "R1 POST /api/order denied"], "allow does not send it");
  const answers = browser.commands.filter((c) => /^Fetch\.(failRequest|continueRequest)$/.test(c.method)).map((c) => `${c.method} ${c.params.requestId}`);
  assert.deepEqual(answers, ["Fetch.failRequest F1"]);
});

test("a restart with nothing in flight tells nothing, and nothing is asked while the observer is idle", async (t) => {
  const { browser, observer, rows, lost } = await rig(t, effectDecider("allow"));
  await sleep(600);
  assert.equal(browser.asked(), 0, "an idle observer never asks for the network service");
  // A busy spell sets what the service was, then it restarts while nothing is in flight.
  browser.announce("R1");
  browser.pause("F1", "R1");
  await observer.flush(undefined, 1_000);
  browser.restart(200);
  await sleep(600);
  // A request after the restart is the new service's, on its way: it is not lost, whatever the first answer about the service says.
  browser.announce("R2");
  await sleep(400);
  browser.pause("F2", "R2");
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost, [], "nothing is told");
  assert.deepEqual(rows, ["R1 POST /api/order pending", "R1 POST /api/order allowed", "R2 POST /api/order pending", "R2 POST /api/order allowed"]);
  const asked = browser.asked();
  await sleep(700);
  assert.equal(browser.asked(), asked, "once nothing waits, nothing is asked");
});

test("a request already paused is never lost: a restart after its pause tells nothing", async (t) => {
  const { browser, observer, lost } = await rig(t, effectDecider("allow"));
  browser.announce("R1");
  await sleep(100);
  browser.pause("F1", "R1");
  browser.announce("R2");
  await sleep(100);
  browser.restart(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost.map((r) => r.requestId), ["R2"], "only the one still waiting for its pause");
});

test("a request that ended unpaused when the service died is lost; one that ended unpaused with the service alive (a refused preflight) is not", async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.failed("R1");
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost, [], "the service is the same: the page saw its own failure");
  browser.announce("R2", "/api/pay");
  await sleep(100);
  browser.restart(200);
  browser.failed("R2");
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost.map((r) => `${r.requestId} ${r.path}`), ["R2 /api/pay"]);
});

test("a call is told only while it records, and a service not yet started again is asked again until it answers", async (t) => {
  const { browser, observer, lost, stop } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  setTimeout(() => browser.restart(300), 300);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost.map((r) => r.requestId), ["R1"], "the restart was found once the new service answered");
  stop();
  browser.announce("R2");
  await sleep(100);
  browser.restart(400);
  await sleep(600);
  assert.equal(lost.length, 1, "a loss after the call stopped recording is not told to it");
});

test("a browser that refuses the question is asked once, and a flush still ends at its bound", async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.refuseService();
  browser.announce("R1");
  await sleep(400);
  browser.announce("R2");
  const start = Date.now();
  await observer.flush(undefined, 400);
  assert.ok(Date.now() - start < 1_000, `the flush was bounded (${Date.now() - start} ms)`);
  assert.equal(browser.asked(), 1);
  assert.deepEqual(lost, []);
});

test("a request that ended unpaused while the new service had not started yet is told lost once it answers", async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  browser.failed("R1");
  setTimeout(() => browser.restart(300), 600);
  await observer.flush(undefined, 1_500);
  assert.deepEqual(lost.map((r) => r.requestId), ["R1"]);
});

test("a browser that answers but names no network service (one in-process) stops being asked within a bound, even after a held request ended unpaused", async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.restart(null);
  browser.announce("R1");
  await sleep(50);
  browser.failed("R1");
  await observer.flush(undefined, 400);
  await sleep(3_000);
  const asked = browser.asked();
  await sleep(1_000);
  assert.equal(browser.asked(), asked, `the asks stopped (${asked} asked)`);
  assert.ok(asked <= 12, `and they were bounded (${asked})`);
  assert.deepEqual(lost, []);
});

test("a form POST whose intent the network service took with it is told lost, and the Document pause that comes after all is refused and journaled denied, never sent under allow", async (t) => {
  const { browser, observer, rows, lost } = await rig(t, effectDecider("allow"));
  browser.formIntent("FR1");
  await sleep(100);
  browser.restart(200);
  await sleep(400);
  assert.deepEqual(lost.map((r) => `${r.requestId} ${r.method} ${r.path}`), ["navigation:FR1 POST /submit"], "the call is told the form was not sent");
  browser.announceForm("D1");
  browser.pauseForm("F1", "D1", "FR1");
  await sleep(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(rows, ["D1 POST /submit pending", "D1 POST /submit denied"], "allow does not send it");
  const answers = browser.commands.filter((c) => /^Fetch\.(failRequest|continueRequest)$/.test(c.method)).map((c) => `${c.method} ${c.params.requestId}`);
  assert.deepEqual(answers, ["Fetch.failRequest F1"]);
  // A later form in the same frame is a new intent: it is decided as any other.
  browser.formIntent("FR1");
  browser.announceForm("D2");
  browser.pauseForm("F2", "D2", "FR1");
  await sleep(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(rows.slice(2), ["D2 POST /submit pending", "D2 POST /submit allowed"]);
});

test("a known service whose new pid shows only after a gap over 2 s still has its lost request told", async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  setTimeout(() => browser.restart(300), 2_600);
  await sleep(3_200);
  await observer.flush(undefined, 500);
  assert.deepEqual(lost.map((r) => r.requestId), ["R1"]);
});

test("a known service that names no pid past the long bound has its waiting request told lost, stops being asked, and a later restart is still found", { timeout: 60_000 }, async (t) => {
  const { browser, observer, lost } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  await sleep(11_000);
  assert.deepEqual(lost.map((r) => r.requestId), ["R1"], "told once the gap passed the long bound");
  const asked = browser.asked();
  await sleep(800);
  assert.equal(browser.asked(), asked, "nothing is asked once nothing waits");
  browser.restart(300);
  browser.announce("R2");
  await sleep(100);
  browser.restart(400);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost.map((r) => r.requestId), ["R1", "R2"], "detection still runs, from the pid it learned again");
});

test("a form lost both by its intent and by its Document's id is refused once; the frame's next Document POST without a new intent is decided as any other", async (t) => {
  const { browser, observer, rows, lost } = await rig(t, effectDecider("allow"));
  browser.formIntent("FR1");
  browser.announceForm("D1");
  await sleep(100);
  browser.restart(200);
  await sleep(400);
  assert.deepEqual(lost.map((r) => `${r.method} ${r.path}`), ["POST /submit"], "one form, told once");
  browser.pauseForm("F1", "D1", "FR1");
  await sleep(200);
  browser.announceForm("D2");
  browser.pauseForm("F2", "D2", "FR1");
  await sleep(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(rows, ["D1 POST /submit pending", "D1 POST /submit denied", "D2 POST /submit pending", "D2 POST /submit allowed"]);
});

test("through a call's own flush (1 s), a known service whose new pid shows only after 2.6 s still has its lost request told before the call stops recording", async (t) => {
  const { browser, observer, lost, stop } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  setTimeout(() => browser.restart(300), 2_600);
  await observer.flush(undefined, 1_000);
  stop();
  assert.deepEqual(lost.map((r) => r.requestId), ["R1"]);
});

test("a call's abort ends a flush that waits for a missing service", async (t) => {
  const { browser, observer } = await rig(t);
  browser.announce("R1");
  await sleep(100);
  browser.restart(null);
  const start = Date.now();
  await observer.flush(AbortSignal.timeout(300), 1_000);
  assert.ok(Date.now() - start < 2_500, `the flush ended with the call (${Date.now() - start} ms)`);
});

test("three requests lost together are all told before flush returns, however slowly the call takes each", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("deny"));
  t.after(async () => { observer.close(); await browser.close(); });
  const lost = [];
  const stop = observer.record(() => {}, async (request) => { lost.push(request.requestId); await sleep(50); });
  for (const id of ["R1", "R2", "R3"]) browser.announce(id);
  await sleep(100);
  browser.restart(200);
  await observer.flush(undefined, 1_000);
  stop();
  await sleep(300);
  assert.deepEqual(lost.sort(), ["R1", "R2", "R3"]);
});

test("a browser that never answers the question does not hold a flush past its bound", async (t) => {
  const { browser, observer } = await rig(t);
  browser.hangService();
  browser.announce("R1");
  await sleep(100);
  const start = Date.now();
  await observer.flush(undefined, 500);
  assert.ok(Date.now() - start < 5_000, `the flush returned (${Date.now() - start} ms)`);
});

test("a browser that keeps its socket open and never answers leaves no question pending once it times out, and the asking stops instead of piling up", async (t) => {
  const { browser, observer, lost } = await rig(t);
  // A known service first, then the browser stops answering while one request waits and another ended unpaused.
  browser.announce("R0");
  browser.pause("F0", "R0");
  await observer.flush(undefined, 500);
  browser.hangService();
  browser.announce("R1");
  browser.announce("R2");
  await sleep(50);
  browser.failed("R2");
  await observer.flush(undefined, 500);
  await sleep(4_000);
  const asked = browser.asked();
  await sleep(2_500);
  assert.equal(browser.asked(), asked, `the questions stopped (${asked} sent)`);
  assert.equal(observer.pending.size, 0, "no unanswered question is kept");
  assert.deepEqual(lost, [], "timeouts alone never make a request lost");
  // A new held request starts the watch again.
  browser.announce("R3");
  await sleep(300);
  assert.ok(browser.asked() > asked, "a new held request is asked about");
});

test("a redirect hop is waited for and decided under its own call, journaled apart from the hop before it", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("allow"));
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = [];
  const stop = observer.record((row) => { rows.push(`${row.requestId} ${row.method} ${row.origin}${row.path} ${row.held}`); });
  browser.announce("R1");
  browser.pause("F1", "R1");
  // As in Chrome, the flush starts once hop 1 is paused; hop 1 goes out and its 307 to another origin comes back a moment
  // later, then hop 2 is paused, and its answer comes.
  setTimeout(() => browser.redirected("R1", "/api/xorigin"), 200);
  setTimeout(() => browser.pauseAt("F2", "R1", "http://other.test", "/api/xorigin"), 400);
  setTimeout(() => browser.responded("R1"), 600);
  const start = Date.now();
  await observer.flush(undefined, 3_000);
  const took = Date.now() - start;
  stop();
  assert.ok(took < 2_000, `the flush ended with hop 2's answer, not at its bound (${took} ms)`);
  assert.deepEqual(rows, ["R1 POST http://fake.test/api/order pending", "R1 POST http://fake.test/api/order allowed", "R1#2 POST http://other.test/api/xorigin pending", "R1#2 POST http://other.test/api/xorigin allowed"]);
});

test("a request whose decision comes after the flush started is waited for through its decision and its answer: its redirect's next hop is the same call's", async (t) => {
  const browser = await fakeBrowser();
  const slowAllow = async () => { await sleep(300); return { allow: true, verdict: null }; };
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, slowAllow);
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = [];
  const stop = observer.record((row) => { rows.push(`${row.requestId} ${row.path} ${row.held}`); });
  browser.announce("R1");
  browser.pause("F1", "R1");
  // The flush starts while hop 1's decision is still pending; hop 1 goes out once allowed, and its 307 comes back after.
  setTimeout(() => browser.redirected("R1", "/api/xorigin"), 500);
  setTimeout(() => browser.pauseAt("F2", "R1", "http://other.test", "/api/xorigin"), 600);
  setTimeout(() => browser.responded("R1"), 1_200);
  await observer.flush(undefined, 3_000);
  stop();
  assert.deepEqual(rows, ["R1 /api/order pending", "R1 /api/order allowed", "R1#2 /api/xorigin pending", "R1#2 /api/xorigin allowed"]);
});

test("a redirect's next hop paused before its announcement arrives is still waited for through its decision", async (t) => {
  const browser = await fakeBrowser();
  const slowAllow = async () => { await sleep(300); return { allow: true, verdict: null }; };
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, slowAllow);
  t.after(async () => { observer.close(); await browser.close(); });
  const rows = [];
  const stop = observer.record((row) => { rows.push(`${row.requestId} ${row.path} ${row.held}`); });
  browser.announce("R1");
  browser.pause("F1", "R1");
  setTimeout(() => browser.pauseAt("F2", "R1", "http://other.test", "/api/xorigin"), 500);
  setTimeout(() => browser.redirected("R1", "/api/xorigin"), 520);
  setTimeout(() => browser.responded("R1"), 1_200);
  await observer.flush(undefined, 3_000);
  stop();
  assert.deepEqual(rows, ["R1 /api/order pending", "R1 /api/order allowed", "R1#2 /api/xorigin pending", "R1#2 /api/xorigin allowed"]);
});

test("a denied request is not waited for after its decision", async (t) => {
  const { browser, observer } = await rig(t);
  browser.announce("R1");
  browser.pause("F1", "R1");
  const start = Date.now();
  await observer.flush(undefined, 2_000);
  assert.ok(Date.now() - start < 500, `the flush returned at the denial (${Date.now() - start} ms)`);
});

test("a redirect hop lost with the network service is not told as not sent: its first hop went out", async (t) => {
  const { browser, observer, lost } = await rig(t, effectDecider("allow"));
  browser.announce("R1");
  browser.pause("F1", "R1");
  await sleep(100);
  browser.redirected("R1", "/api/xorigin");
  await sleep(100);
  browser.restart(200);
  await observer.flush(undefined, 1_000);
  assert.deepEqual(lost, []);
});

test("a relay that answers the question with no result stalls the watch instead of spinning, and the observer still hears its socket close", async (t) => {
  const browser = await fakeBrowser();
  const observer = await EffectObserver.open({ sdkCdpUrl: browser.url }, effectDecider("deny"));
  t.after(async () => { observer.close(); await browser.close(); });
  observer.record(() => {});
  browser.bareService();
  browser.announce("R1");
  await sleep(1_000);
  assert.ok(browser.asked() <= 5, `the asking stalled (${browser.asked()} asked)`);
  await browser.close();
  for (const end = Date.now() + 2_000; !observer.closed && Date.now() < end; await sleep(20));
  assert.equal(observer.closed, true, "the socket's close was heard");
});

test("a page that sends a held request every millisecond is asked about at most every 50 ms or so: 100 in 100 ms take about 3 questions", async (t) => {
  const { browser } = await rig(t);
  const start = Date.now();
  for (let i = 0; i < 100; i += 1) { browser.announce(`R${i}`); await sleep(1); }
  const took = Date.now() - start;
  await sleep(Math.max(0, 120 - took));
  assert.ok(browser.asked() <= Math.ceil(took / 50) + 2, `${browser.asked()} questions in ${took} ms`);
});

test("a cancelled call's flush stops waiting for an allowed request's response head at once", async (t) => {
  const { browser, observer, rows } = await rig(t, effectDecider("allow"));
  browser.announce("R1");
  browser.pause("F1", "R1");
  await sleep(100);
  assert.deepEqual(rows, ["R1 POST /api/order pending", "R1 POST /api/order allowed"], "continued, and its response head never comes");
  const cancel = new AbortController();
  let abortedAt = 0;
  setTimeout(() => { abortedAt = Date.now(); cancel.abort(); }, 200);
  await observer.flush(cancel.signal, 1_000);
  const after = Date.now() - abortedAt;
  assert.ok(abortedAt > 0 && after < 50, `the flush returned ${abortedAt ? `${after} ms after the abort` : "before the abort"}`);
});

test("a journaling observer, which holds nothing, never asks for the network service", async (t) => {
  const { browser, observer } = await rig(t, null);
  browser.announce("R1");
  await sleep(400);
  await observer.flush(undefined, 300);
  assert.equal(browser.asked(), 0);
});

test("a run whose code throws after a loss still tells the model of the lost request, beside the error", async () => {
  const lostOne = { requestId: "R1", method: "POST", origin: "https://shop.test", path: "/api/order" };
  const effects = { holding: true, record: (_row, lost) => { effects.lost = lost; return () => {}; }, flush: async () => { await effects.lost?.(lostOne); } };
  const record = { lastUrl: "https://shop.test/", navigation: [{ at: "2026-11-07T00:00:00.000Z", url: "https://shop.test/" }] };
  const driver = { run: async () => { throw new Error("page.click: Timeout 5000ms exceeded"); }, url: async () => "https://shop.test/" };
  const session = { driver, tag: "t-1", sessionId: "s-1", record, notice: null, interrupted: null, recorded: false, effects, replaced: null };
  const port = { session: async () => session, ended: async () => false, mark: async () => {}, settle: async () => {}, dispatching: async () => {}, dispatched: async () => {}, finished: async () => {}, journal: async () => {}, navigated: async () => {}, answered: async () => {}, dropped: async () => {} };
  const call = { callId: "call-2", conversationId: 2, signal: undefined, label: "node-a", redact: (text) => text, evidence: { file: async () => null } };
  const out = await pageTools().run({ code: "await page.click('#order')" }, port, call);
  assert.equal(out.isError, true);
  const failed = JSON.parse(out.content[0].text);
  assert.match(failed.message, /Timeout 5000ms exceeded/, "the error's own words stay");
  assert.match(failed.message, /The browser lost a request your page made before the request left the browser: POST https:\/\/shop\.test\/api\/order\./);
  assert.deepEqual(out.details?.lost, [{ method: "POST", url: "https://shop.test/api/order" }]);
});

test("run tells the model the browser lost a request and it was NOT sent, names it by method and URL with no query, and lists it in details.lost", async () => {
  const lostOne = { requestId: "R1", method: "POST", origin: "https://shop.test", path: "/api/order" };
  const effects = { holding: true, record: (_row, lost) => { effects.lost = lost; return () => {}; }, flush: async () => { await effects.lost?.(lostOne); } };
  const record = { lastUrl: "https://shop.test/", navigation: [{ at: "2026-11-07T00:00:00.000Z", url: "https://shop.test/" }] };
  const driver = { run: async () => "done", url: async () => "https://shop.test/" };
  const session = { driver, tag: "t-1", sessionId: "s-1", record, notice: null, interrupted: null, recorded: false, effects, replaced: null };
  const port = { session: async () => session, ended: async () => false, mark: async () => {}, settle: async () => {}, dispatching: async () => {}, dispatched: async () => {}, finished: async () => {}, journal: async () => {}, navigated: async () => {}, answered: async () => {} };
  const call = { callId: "call-1", conversationId: 1, signal: undefined, label: "node-a", redact: (text) => text, evidence: { file: async () => null } };
  const out = await pageTools().run({ code: "await page.click('#order')" }, port, call);
  const said = out.content[0].text;
  assert.match(said, /^done/);
  assert.match(said, /The browser lost a request your page made before the request left the browser: POST https:\/\/shop\.test\/api\/order\. Chrome's network service restarted while it was on its way, so the request was not sent\. Make it again if you still need it\./);
  assert.doesNotMatch(said, /reached/, "the preflight may have reached the site: the notice says only that the request was not sent");
  assert.deepEqual(out.details.lost, [{ method: "POST", url: "https://shop.test/api/order" }]);
  assert.equal(out.details.sent, undefined);
});
