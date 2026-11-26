// The triggers' tests' own: a fake clock for the engine, a schedule's body, a trigger's settled firings, and a host's
// launch hook that the install hands firings to.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { agent } from "./support.mjs";

/** The triggers' clock: `to(time)` moves it, and fires the one timer the engine holds once its time has come. */
export function fakeClock(start) {
  const clock = {
    t: Date.parse(start),
    timer: null,
    now: () => clock.t,
    arm(fire, ms) {
      const held = { at: clock.t + ms, fire };
      clock.timer = held;
      return { clear: () => void (clock.timer === held && (clock.timer = null)) };
    },
    to(time) {
      clock.t = Date.parse(time);
      const held = clock.timer;
      if (held && held.at <= clock.t) {
        clock.timer = null;
        held.fire();
      }
    },
  };
  return clock;
}

/** A case whose firing must run on a runner that dispatches it and delivers its commands: the fired run executes, reaches a
 *  state (working, parked on a person, waiting on a tool-call approval or at its door), and the firing reads or messages it.
 *  The switch starts the run (fires against its own store), but running it is the runner's; these turn on when it does. */
export const RUN_EXEC = "waits on running a fired run on the runner (dispatch and command delivery)";
/** A case whose trigger target is a message_run: the message is delivered to an existing run over the store. */
export const MESSAGE_RUN = "waits on delivering a message_run target over the store";
/** What a server that went down between a firing's run (or message) and its settle leaves: the firing `key` of trigger `id`
 *  due again in the store with no run named, while what it started stays under the firing's key (its run's origin row, or
 *  its message's command row). The engine starts a run (or queues a message) and settles its firing in two transactions,
 *  so a kill between them leaves exactly this; a restart's drive must find what is there, never start or send it twice.
 *  `store`: a handle on the server's store (serve()'s), the server itself closed. */
export async function leftDue(store, id, key, extra = {}) {
  const settled = await store.triggers.settle(id, key, { status: "due", runId: null, ...extra });
  assert.ok(settled, `firing ${key} of ${id} is in the store`);
}
export const keyOf = (kind, id, what) => `fir_${createHash("sha256").update(`${kind}\n${id}\n${what}`).digest("hex").slice(0, 32)}`;
export const schedule = (id, source, extra = {}) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: id, input: { content: "Say hello." }, max_cost_usd: 0.5 }, ...extra });

export async function made(api, id, extra) {
  assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
}

/** `check`'s answer once it is truthy, read every 10 ms for up to `ms`; its last answer when the time runs out, or, given
 *  `what`, a failed assert in those words. For what the server does after the change a test can await (a sender told of a
 *  pause that follows it), so the assert after it reads the outcome, not the timing. */
export async function until(check, ms = 5_000, what = undefined) {
  for (const end = Date.now() + ms; ; await sleep(10)) {
    const answer = await check();
    if (answer || Date.now() >= end) {
      if (!answer && what !== undefined) assert.fail(what);
      return answer;
    }
  }
}

/** The store's refusal of a firing's run (its run row is not there), on a firing still due or one that failed of it. */
const runRowMissing = (f) => /FOREIGN KEY constraint failed/.test(`${f.reason ?? ""} ${f.error?.message ?? ""}`);

/** The trigger's firings, newest first, once it holds at least `n` and none is still due. A firing whose run row the store
 *  refused ends the wait at once, under RUN_EXEC's words: the case waits on running a fired run, and waiting out the bound
 *  would only cost its time. Any other firing that does not settle waits the whole bound and fails as it would. */
export async function firings(api, id, n) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}/firings`);
    assert.equal(status, 200, JSON.stringify(body));
    const refused = body.firings.find(runRowMissing);
    if (refused) throw new Error(`${RUN_EXEC}: the store refused firing ${refused.key}'s run row (${refused.status})`);
    if (body.firings.length >= n && body.firings.every((f) => f.status !== "due")) return body.firings;
    assert.ok(Date.now() < end, `no ${n} settled firings: ${JSON.stringify(body.firings)}`);
  }
}

/** The path a launch-hook fake takes firings at. */
const HOOK_PATH = "/agentrun/firings";

/** A host's launch hook on 127.0.0.1. Only a POST to its path (any query) is kept in `got` and answered by
 *  `answer(res, sent, n)` (default 202 `{}`); any other request gets 404 unread, so `got` counts the firings handed. A
 *  POST cut short or not JSON gets 400. */
export async function hookServer(t, answer = (res) => res.writeHead(202, { "content-type": "application/json" }).end("{}")) {
  const got = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url, "http://h").pathname !== HOOK_PATH) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    let sent;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const kept = { method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
      got.push(kept);
      sent = kept.sent = JSON.parse(kept.body.toString("utf8"));
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(400).end();
      return;
    }
    // An answer that throws (its server stopped under it) fails its test by what it leaves undone, not here.
    await Promise.resolve().then(() => answer(res, sent, got.length)).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${server.address().port}${HOOK_PATH}`, got };
}

/** A launch hook that drops the connection: a listener on 127.0.0.1 this test owns until its end, which reads each request
 *  whole and then closes its socket unanswered, so a POST to `url` is sent and never answered, the same every time (the
 *  fetch's UND_ERR_SOCKET). Never a port that was closed: another process could bind it. */
export async function droppingServer(t) {
  const server = createServer((req) => {
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}${HOOK_PATH}`, port };
}
