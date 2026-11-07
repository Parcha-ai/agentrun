// The serve mode: the HTTP front over a real pi Harness on a local "disk". The requestId is deduplicated by pi in the run's store, so a retry that
// reaches the next incarnation (fresh process memory) finds the same submission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { recordWake } from "../src/park.ts";
import type { DurableRun } from "../src/run.ts";
import { MESSAGE_ORIGIN_KIND, readServeToken, serveRun, type RunServer } from "../src/serve.ts";
import { lifecycleApp, LocalDisk, newCounters, openOn, sleep, until, type Counters } from "./_lifecycle.ts";
import { ctx } from "./_run-support.ts";

const REF = { disk: "dsk-local", region: "local", id: "serve-1" };

type Reply = { status: number; body: Record<string, any>; retryAfter: string | null };
async function call(server: RunServer, method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<Reply> {
  const res = await fetch(new URL(path, server.url), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, retryAfter: res.headers.get("retry-after") };
}

/** Every user entry of the root conversation whose text is `text`. */
async function userEntries(run: DurableRun, text: string): Promise<EntryRecord[]> {
  const page = await (await run.harness.root(ctx)).entries({}, 500, undefined, ctx);
  return page.items.filter((e) => e.model?.some((m) => m.role === "user" && (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")) === text));
}

async function served(disk: LocalDisk, counters: Counters, extra: { gate?: Promise<void> } = {}) {
  const app = lifecycleApp(counters, extra);
  const server = await serveRun({ root: { agent: app.agent } });
  const run = await openOn(disk, REF, app, { holder: { driver: "in-process", serve: server.url } });
  server.attach(run);
  return { app, server, run };
}

describe("the HTTP front", () => {
  it("answers 503 OPENING until the run is attached, then submits and returns the answer; a repeated requestId is the same submission", async () => {
    const disk = new LocalDisk("serve-basic");
    const counters = newCounters();
    try {
      const app = lifecycleApp(counters);
      const server = await serveRun({ root: { agent: app.agent } });
      const opening = await call(server, "POST", "/submit", { requestId: "r1", content: "hello" });
      assert.deepEqual([opening.status, opening.body.error, opening.retryAfter], [503, "OPENING", "1"]);
      const run = await openOn(disk, REF, app);
      server.attach(run);
      const first = await call(server, "POST", "/submit", { requestId: "r1", content: "hello", wait: true });
      assert.equal(first.status, 200);
      assert.equal(first.body.submission.status, "done");
      assert.deepEqual(first.body.answer.text, "echo: hello");
      assert.equal(first.body.generation, 1);
      const again = await call(server, "POST", "/submit", { requestId: "r1", content: "hello", wait: true });
      assert.equal(again.body.submission.id, first.body.submission.id);
      assert.equal(again.body.answer.text, "echo: hello");
      assert.equal((await userEntries(run, "hello")).length, 1);
      assert.equal(counters.requests, 1);
      const status = await call(server, "GET", "/status");
      assert.deepEqual([status.status, status.body.run, status.body.status, status.body.busy], [200, REF.id, "running", { kind: "idle" }]);
      await run.release();
      const released = await call(server, "POST", "/submit", { requestId: "r2", content: "hello" });
      assert.deepEqual([released.status, released.body.error], [503, "RELEASED"]);
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("refuses bad requests and unknown routes, and conversations that do not exist", async () => {
    const disk = new LocalDisk("serve-bad");
    try {
      const { server, run } = await served(disk, newCounters());
      for (const [body, why] of [
        [{ content: "x" }, "no requestId"],
        [{ requestId: "has space", content: "x" }, "requestId not printable ASCII"],
        [{ requestId: "r", content: 5 }, "content a number"],
        [{ requestId: "r", content: "x", whenBusy: "later" }, "whenBusy unknown"],
        [{ requestId: "r", content: "x", conversationId: -1 }, "conversationId negative"],
        ["{not json", "not JSON"],
        ["[1]", "not an object"],
      ] as const) {
        const r = await call(server, "POST", "/submit", body);
        assert.deepEqual([r.status, r.body.error], [400, "BAD_REQUEST"], why);
      }
      assert.deepEqual((await call(server, "POST", "/submit", { requestId: "r", content: "x", conversationId: 999 })).status, 404);
      assert.deepEqual((await call(server, "GET", "/nope")).body.error, "NOT_FOUND");
      await run.release();
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("a guarded input pi took, sent again once its conversation has parked a call, answers the same submission, not WAITING", async () => {
    const disk = new LocalDisk("serve-park-retry");
    const counters = newCounters();
    const { server, run } = await served(disk, counters);
    try {
      const PARK = "agentrun.tool_approval";
      const guarded = () => call(server, "POST", "/submit", { requestId: "g7", content: "hello", answers: false, asks: ["ask_person"], parks: [PARK] });
      const first = await guarded();
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const root = (await run.harness.root(ctx)).id;
      await run.harness.commit((tx) => tx.appendEntry(root, { kind: PARK, data: { phase: "requested", id: "ap_7", tool: "web_fetch", call_id: "call_7" } as never }), ctx);
      const again = await guarded();
      assert.deepEqual([again.status, again.body.submission?.id], [200, first.body.submission.id], JSON.stringify(again.body));
      const fresh = await call(server, "POST", "/submit", { requestId: "g8", content: "hello", answers: false, asks: ["ask_person"], parks: [PARK] });
      assert.deepEqual([fresh.status, fresh.body.error], [409, "WAITING"], "a new one is refused");
    } finally {
      await run.release().catch(() => undefined);
      await server.close().catch(() => undefined);
      disk.remove();
    }
  });

  it("pause() refuses submissions with 503 PARKING while status still answers; whenBusy reject is 409; abort stops the conversation", async () => {
    const disk = new LocalDisk("serve-pause");
    const counters = newCounters();
    try {
      const { server, run } = await served(disk, counters);
      const resume = server.pause();
      const parking = await call(server, "POST", "/submit", { requestId: "p1", content: "hello" });
      assert.deepEqual([parking.status, parking.body.error], [503, "PARKING"]);
      assert.equal((await call(server, "GET", "/status")).status, 200);
      resume();
      const gated = await call(server, "POST", "/submit", { requestId: "g1", content: "gate" });
      assert.equal(gated.body.submission.status, "placed");
      await until("the gate tool", () => counters.gate === 1);
      const busy = await call(server, "POST", "/submit", { requestId: "b1", content: "hello", whenBusy: "reject" });
      assert.deepEqual([busy.status, busy.body.error], [409, "BUSY"]);
      const aborted = await call(server, "POST", "/abort", {});
      assert.deepEqual([aborted.status, aborted.body.result], [200, "aborted"]);
      const after = await call(server, "GET", "/status");
      assert.deepEqual(after.body.busy, { kind: "idle" });
      assert.deepEqual((await call(server, "POST", "/abort", { submissionId: 12345 })).status, 404);
      await run.release();
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("streams pi's agent events as server-sent events; an open stream counts as an open request until the client goes", async () => {
    const disk = new LocalDisk("serve-events");
    try {
      let idle = 0;
      const app = lifecycleApp(newCounters());
      const server = await serveRun({ root: { agent: app.agent }, onIdle: () => void idle++ });
      const run = await openOn(disk, REF, app);
      server.attach(run);
      let text = "";
      const req = httpRequest(new URL("/events", server.url));
      const response = new Promise<void>((resolve) =>
        req.on("response", (res) => {
          assert.equal(res.headers["content-type"], "text/event-stream");
          res.setEncoding("utf8").on("data", (c: string) => (text += c));
          resolve();
        }),
      );
      req.end();
      await response;
      await until("the snapshot", () => text.includes("event: snapshot\n"));
      assert.equal(server.active, 1);
      await call(server, "POST", "/submit", { requestId: "e1", content: "hello", wait: true });
      await until("an events batch with the answer", () => text.includes("event: events\n") && text.includes("echo: hello"));
      req.destroy();
      await until("the stream closed", () => server.active === 0);
      assert.equal(idle, 1);
      await run.release();
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("a server message retried after an upgrade (its marker written under the old id) writes no second marker: one marker for one message, so a later person's message with the same text stays theirs", async () => {
    const disk = new LocalDisk("serve-origin-retry");
    let server: RunServer | undefined;
    let run: DurableRun | undefined;
    try {
      ({ server, run } = await served(disk, newCounters()));
      const text = "The cap was raised to $5; continue the task.";
      const origin = { kind: "server", reason: "cap_raised" };
      const root = await run!.harness.root(ctx);
      // Before the upgrade: the marker under the message's id plus ":origin", then the message itself, answered.
      await root.submit({ type: "write", requestId: "foo:origin", entry: { kind: MESSAGE_ORIGIN_KIND, data: { origin, text } } }, ctx);
      await (await root.submit({ type: "input", requestId: "foo", content: text }, ctx)).wait(ctx);
      // After it: the same server message again (a retry of the same request), through the door.
      const retried = await call(server!, "POST", "/submit", { requestId: "foo", content: text, origin, wait: true });
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      // A person then sends the same words.
      const person = await call(server!, "POST", "/submit", { requestId: "bar", content: text, wait: true });
      assert.equal(person.status, 200, JSON.stringify(person.body));
      const markers = (await root.entries({}, 500, undefined, ctx)).items.filter((entry) => entry.kind === MESSAGE_ORIGIN_KIND);
      // The Timeline gives each marker to one message with its text (pi-durable-agent's messageOrigins): one marker is the
      // server's message's alone, and the person's reads as theirs.
      assert.equal(markers.length, 1, `one marker for the one server message: ${JSON.stringify(markers.map((m) => m.data))}`);
      assert.equal((await userEntries(run!, text)).length, 2, "the server's message once, and the person's");
    } finally {
      // Released and closed whatever the assertions say, so a failure ends the file instead of holding it to its timeout.
      await run?.release();
      await server?.close();
      disk.remove();
    }
  });

  it("a trigger's origin is taken in its own shape, on a guarded input too; a guarded one refused busy takes its marker back, so nothing is left open for a later message with its text", async () => {
    const disk = new LocalDisk("serve-trigger-origin");
    const counters = newCounters();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let server: RunServer | undefined;
    let run: DurableRun | undefined;
    try {
      ({ server, run } = await served(disk, counters, { gate }));
      const origin = { kind: "trigger", trigger_id: "trg_1", source: "webhook", owner: false };
      for (const bad of [{ ...origin, source: "email" }, { ...origin, owner: "false" }, { ...origin, trigger_id: 7 }, { ...origin, extra: 1 }, { kind: "trigger", trigger_id: "trg_1", source: "webhook" }]) {
        const refused = await call(server!, "POST", "/submit", { requestId: "bad", content: "A new event came in.", origin: bad });
        assert.deepEqual([refused.status, refused.body.error], [400, "BAD_REQUEST"], JSON.stringify(bad));
      }
      const taken = await call(server!, "POST", "/submit", { requestId: "t1", content: "A new event came in.", origin, answers: false, asks: ["ask_person"], wait: true });
      assert.equal(taken.status, 200, JSON.stringify(taken.body));
      // Busy: a turn holds at the gate tool, and a guarded input is refused, after its marker went in.
      const gated = await call(server!, "POST", "/submit", { requestId: "g1", content: "gate" });
      assert.equal(gated.body.submission.status, "placed");
      await until("the gate tool", () => counters.gate === 1);
      const busy = await call(server!, "POST", "/submit", { requestId: "t2", content: "Another event came in.", origin, answers: false, asks: ["ask_person"] });
      assert.deepEqual([busy.status, busy.body.error], [409, "BUSY"]);
      // The writes queue behind the turn: they are in once it is done.
      open();
      const root = await run!.harness.root(ctx);
      // In the order they were written (the page is newest first).
      const markersNow = async () => (await root.entries({}, 500, undefined, ctx)).items.filter((entry) => entry.kind === MESSAGE_ORIGIN_KIND).sort((a, b) => Number(a.id) - Number(b.id)).map((entry) => entry.data);
      await until("the refused try's marker and its withdrawal", async () => (await markersNow()).length === 3);
      const markers = await markersNow();
      assert.deepEqual(markers, [
        { origin, text: "A new event came in." },
        { origin, text: "Another event came in." },
        { origin, text: "Another event came in.", withdrawn: true },
      ], "the taken one's marker, and the refused one's with its withdrawal");
      assert.equal((await userEntries(run!, "A new event came in.")).length, 1, "the trigger's message reached the run");
    } finally {
      await run?.release();
      await server?.close();
      disk.remove();
    }
  });

  it("a trigger's guarded message refused WAITING writes no marker: the waiting check comes before it; a server origin on a guarded input is refused", async () => {
    const disk = new LocalDisk("serve-trigger-waiting");
    let server: RunServer | undefined;
    let run: DurableRun | undefined;
    try {
      ({ server, run } = await served(disk, newCounters()));
      const PARK = "agentrun.tool_approval";
      const root = await run!.harness.root(ctx);
      await run!.harness.commit((tx) => tx.appendEntry(root.id, { kind: PARK, data: { phase: "requested", id: "ap_9", tool: "web_fetch", call_id: "call_9" } as never }), ctx);
      const origin = { kind: "trigger", trigger_id: "trg_1", source: "schedule", owner: true };
      const waiting = await call(server!, "POST", "/submit", { requestId: "w1", content: "Check the queue.", origin, answers: false, asks: ["ask_person"], parks: [PARK] });
      assert.deepEqual([waiting.status, waiting.body.error], [409, "WAITING"], JSON.stringify(waiting.body));
      const server_ = await call(server!, "POST", "/submit", { requestId: "s1", content: "The cap was raised.", origin: { kind: "server", reason: "cap_raised" }, answers: false });
      assert.deepEqual([server_.status, server_.body.error], [400, "BAD_REQUEST"], "a server origin is never on a guarded input");
      const markers = (await root.entries({}, 500, undefined, ctx)).items.filter((entry) => entry.kind === MESSAGE_ORIGIN_KIND);
      assert.deepEqual(markers, [], "no marker written");
    } finally {
      await run?.release();
      await server?.close();
      disk.remove();
    }
  });

  it("dedup is per conversation, as pi's submissionByRequest is: the same requestId on another conversation is a new submission", async () => {
    const disk = new LocalDisk("serve-perconv");
    const counters = newCounters();
    try {
      const { server, run, app } = await served(disk, counters);
      const onRoot = await call(server, "POST", "/submit", { requestId: "same", content: "on root", wait: true });
      const other = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent: app.agent }, ctx);
      const onOther = await call(server, "POST", "/submit", { requestId: "same", content: "on the other", wait: true, conversationId: other.id });
      assert.equal(onOther.status, 200);
      assert.notEqual(onOther.body.submission.id, onRoot.body.submission.id);
      assert.deepEqual([onRoot.body.answer.text, onOther.body.answer.text], ["echo: on root", "echo: on the other"]);
      const again = await call(server, "POST", "/submit", { requestId: "same", content: "ignored", wait: true, conversationId: other.id });
      assert.deepEqual([again.body.submission.id, again.body.answer.text], [onOther.body.submission.id, "echo: on the other"], "a repeat on that conversation is its first");
      assert.equal(counters.requests, 2);
      await run.release();
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("a requestId admitted by one incarnation is found by the next, whose memory never saw it", async () => {
    const disk = new LocalDisk("serve-dedup");
    const counters = newCounters();
    try {
      const one = await served(disk, counters);
      const admitted = await call(one.server, "POST", "/submit", { requestId: "req-7", content: "gate" });
      assert.equal(admitted.body.submission.status, "placed");
      await until("the gate tool", () => counters.gate === 1);
      // The instance goes away before it answers (a release here; a takeover is the same to the store).
      await one.run.release();
      await one.server.close();

      const two = await served(disk, counters);
      const retried = await call(two.server, "POST", "/submit", { requestId: "req-7", content: "gate", wait: true });
      assert.equal(retried.status, 200);
      assert.equal(retried.body.generation, 2);
      assert.equal(retried.body.submission.id, admitted.body.submission.id);
      assert.equal(retried.body.answer.text, "finished");
      assert.equal(counters.gate, 1, "the unsafe tool did not run again");
      assert.equal((await userEntries(two.run, "gate")).length, 1);
      await two.run.release();
      await two.server.close();
    } finally {
      disk.remove();
    }
  });
});

describe("the bearer token", () => {
  const TOKEN = "s3cr3t-token-for-the-serve-front";

  it("a non-loopback address needs a token: serveRun refuses before it binds anything", async () => {
    for (const host of ["0.0.0.0", "::", "10.1.2.3", "my-host.example"]) {
      await assert.rejects(serveRun({ host }), (e: unknown) => (e as { code?: string }).code === "SERVE_TOKEN_REQUIRED", host);
    }
  });

  it("with a token every route refuses a request without it or with a wrong one, and takes the right one; loopback without a token stays open", async () => {
    const disk = new LocalDisk("serve-token");
    try {
      const app = lifecycleApp(newCounters());
      const server = await serveRun({ root: { agent: app.agent }, token: TOKEN });
      const run = await openOn(disk, REF, app);
      server.attach(run);
      for (const [method, path] of [["POST", "/submit"], ["POST", "/abort"], ["GET", "/status"], ["GET", "/events"]] as const) {
        const body = method === "POST" ? { requestId: "t1", content: "hello" } : undefined;
        const none = await call(server, method, path, body);
        assert.deepEqual([none.status, none.body.error], [401, "UNAUTHORIZED"], `${path} without a token`);
        const wrong = await call(server, method, path, body, `${TOKEN}x`);
        assert.deepEqual([wrong.status, wrong.body.error], [401, "UNAUTHORIZED"], `${path} with a wrong token`);
        const short = await call(server, method, path, body, "s");
        assert.equal(short.status, 401, `${path} with a token of another length`);
      }
      const right = await call(server, "POST", "/submit", { requestId: "t1", content: "hello", wait: true }, TOKEN);
      assert.deepEqual([right.status, right.body.answer.text], [200, "echo: hello"]);
      assert.equal((await call(server, "GET", "/status", undefined, TOKEN)).status, 200);
      await run.release();
      await server.close();

      const open = await serveRun({ root: { agent: app.agent } });
      assert.match(open.url, /^http:\/\/127\.0\.0\.1:/);
      assert.equal((await call(open, "GET", "/status")).body.error, "OPENING", "loopback with no token answers without one");
      await open.close();
    } finally {
      disk.remove();
    }
  });

  it("a wildcard bind needs the address clients reach (`url`), which is what the server advertises; nothing binds without it", async () => {
    for (const host of ["0.0.0.0", "::"]) {
      await assert.rejects(serveRun({ host, token: TOKEN }), (e: unknown) => (e as { code?: string }).code === "SERVE_URL_REQUIRED", host);
    }
    await assert.rejects(serveRun({ url: "ftp://run-host.example:21" }), (e: unknown) => (e as { code?: string }).code === "SERVE_URL_INVALID");
    const server = await serveRun({ url: "https://run-host.example:8443" });
    assert.equal(server.url, "https://run-host.example:8443", "run.json's holder carries the given address, not the bound one");
    await server.close();
  });

  it("the token file must be private: 0600 is read, anything group or world readable, empty or missing is refused", () => {
    const disk = new LocalDisk("serve-token-file");
    try {
      const file = join(disk.base, "serve.token");
      writeFileSync(file, `${TOKEN}\n`);
      chmodSync(file, 0o600);
      assert.equal(readServeToken(file), TOKEN);
      for (const mode of [0o640, 0o604, 0o644]) {
        chmodSync(file, mode);
        assert.throws(() => readServeToken(file), (e: unknown) => (e as { code?: string }).code === "SERVE_TOKEN_INVALID", mode.toString(8));
      }
      chmodSync(file, 0o600);
      writeFileSync(file, "\n");
      assert.throws(() => readServeToken(file), (e: unknown) => (e as { code?: string }).code === "SERVE_TOKEN_INVALID");
      assert.throws(() => readServeToken(join(disk.base, "missing")), (e: unknown) => (e as { code?: string }).code === "SERVE_TOKEN_INVALID");
    } finally {
      disk.remove();
    }
  });
});
