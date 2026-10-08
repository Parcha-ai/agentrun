// The serve mode without Archil: the HTTP front over a real pi Harness on a local "disk", and the client that
// wakes a released run through ensureRunning. The requestId is deduplicated by pi in the run's store, so a retry that
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
import { readServeToken, requestRun, serveRun, ServeError, type RunServer } from "../src/serve.ts";
import { InProcessHost, lifecycleApp, LocalDisk, newCounters, openOn, sleep, until, type Counters } from "./_lifecycle.ts";
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

  it("the client sends its token; without it the instance's 401 comes back as the answer", async () => {
    const disk = new LocalDisk("serve-token-client");
    const instances: { run: DurableRun; server: RunServer }[] = [];
    try {
      const host = new InProcessHost(async (ref) => {
        const app = lifecycleApp(newCounters());
        const server = await serveRun({ root: { agent: app.agent }, token: TOKEN });
        const run = await openOn(disk, ref, app, { holder: { driver: "in-process", serve: server.url } });
        server.attach(run);
        instances.push({ run, server });
      });
      const body = { requestId: "c1", content: "hello", wait: true };
      const ok = await requestRun(REF, { method: "POST", path: "/submit", body }, { host, ensure: { control: disk }, token: TOKEN, timeoutMs: 10_000 });
      assert.deepEqual([ok.status, (ok.body as any).answer.text], [200, "echo: hello"]);
      const refused = await requestRun(REF, { method: "POST", path: "/submit", body }, { host, ensure: { control: disk }, timeoutMs: 10_000 });
      assert.deepEqual([refused.status, (refused.body as any).error], [401, "UNAUTHORIZED"]);
      for (const i of instances) (await i.run.release(), await i.server.close());
    } finally {
      disk.remove();
    }
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

describe("the client", () => {
  it("starts a never-started run and a parked one on request, sends straight to a running one, and refuses a done run", async () => {
    const disk = new LocalDisk("serve-client");
    const counters = newCounters();
    const instances: { run: DurableRun; server: RunServer }[] = [];
    try {
      const host = new InProcessHost(async () => {
        // The driver returns once the instance runs; the client finds it through run.json.
        void served(disk, counters).then((i) => instances.push(i));
      });
      const options = { host, ensure: { control: disk }, timeoutMs: 10_000 };
      const submit = (requestId: string, content: string) => requestRun(REF, { method: "POST", path: "/submit", body: { requestId, content, wait: true } as JsonValue }, options);

      const first = await submit("c1", "hello");
      assert.equal(first.status, 200);
      assert.equal((first.body as any).answer.text, "echo: hello");
      assert.deepEqual(first.ensured.map((e) => e.action), ["started"]);

      const again = await submit("c2", "hi");
      assert.deepEqual([again.status, again.ensured.length], [200, 0], "a running instance answers at once");

      // Parked idle: run.json sleeping with no wake; only a request starts it.
      await recordWake(instances[0]!.run, null);
      await instances[0]!.run.release();
      const woken = await submit("c3", "again");
      assert.equal((woken.body as any).generation, 2);
      assert.equal(woken.ensured[0]?.action === "started" && woken.ensured[0].woke, true);

      await instances[1]!.run.setStatus("done");
      await instances[1]!.run.release();
      await assert.rejects(submit("c5", "too late"), (e: unknown) => e instanceof ServeError && e.code === "RUN_TERMINAL");
      for (const i of instances) await i.server.close();
      await sleep(10);
    } finally {
      disk.remove();
    }
  });

  it("a control API that never answers ends the request at its deadline, not never", { timeout: 10_000 }, async () => {
    const disk = new LocalDisk("serve-stall");
    try {
      const stalled = Object.assign(Object.create(disk) as LocalDisk, { getObject: () => new Promise<Uint8Array>(() => {}) });
      const t0 = Date.now();
      const err = await requestRun(REF, { method: "GET", path: "/status" }, { host: new InProcessHost(async () => {}), ensure: { control: stalled }, timeoutMs: 400 }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ServeError && err.code === "NOT_SERVED", String(err));
      assert.ok(Date.now() - t0 < 2_000, `ended at its deadline (${Date.now() - t0} ms)`);
    } finally {
      disk.remove();
    }
  });

  it("gives up on an instance whose lease lapses while a request is open (a frozen instance never answers) and asks the supervisor", async () => {
    const disk = new LocalDisk("serve-frozen");
    try {
      const now = Date.now();
      await disk.putObject(`runs/${REF.id}/run.json`, JSON.stringify({
        run: REF.id, status: "running", generation: 1, sealedSeq: null, wakeAt: null, updatedAt: new Date(now).toISOString(),
        heartbeatAt: new Date(now - 2_500).toISOString(), detail: null,
        holder: { driver: "in-process", host: "h", bootId: null, pid: 1, since: new Date(now).toISOString(), serve: "http://127.0.0.1:9" },
      }));
      let aborted = 0;
      const hanging = ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => (aborted = Date.now() - now, reject(new Error("aborted")))))) as unknown as typeof fetch;
      const host = new InProcessHost(async () => {});
      const err = await requestRun(REF, { method: "GET", path: "/status" }, { host, ensure: { control: disk, leaseExpiryMs: 3_000 }, timeoutMs: 4_000, fetch: hanging }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ServeError && err.code === "NOT_SERVED", String(err));
      assert.ok(aborted > 0 && aborted < 2_500, `the request was dropped once the lease lapsed (${aborted} ms), not at the deadline`);
      assert.ok(err.ensured.some((e) => e.action === "started"), "and the supervisor was asked");
    } finally {
      disk.remove();
    }
  });

  it("starts once while the instance opens, though nothing lists it yet, and asks again only after the start timeout", { timeout: 20_000 }, async () => {
    const disk = new LocalDisk("serve-once");
    const counters = newCounters();
    const instances: { run: DurableRun; server: RunServer }[] = [];
    try {
      // The driver returns at once; the instance mounts (and so shows in the delegations) 400 ms later.
      const host = new InProcessHost(async () => void sleep(400).then(() => served(disk, counters)).then((i) => instances.push(i)));
      const r = await requestRun(REF, { method: "POST", path: "/submit", body: { requestId: "o1", content: "hello", wait: true } }, { host, ensure: { control: disk }, timeoutMs: 10_000 });
      assert.equal(r.status, 200);
      assert.deepEqual(r.ensured.map((e) => e.action), ["started"]);
      assert.equal(host.starts.length, 1);
      await instances[0]!.run.release();
      await instances[0]!.server.close();

      const never = new InProcessHost(async () => {});
      // The supervisor's start grace (300 ms here) has passed too by the time the client asks again.
      const err = await requestRun({ ...REF, id: "serve-never" }, { method: "GET", path: "/status" }, { host: never, ensure: { control: disk, startGraceMs: 300 }, timeoutMs: 1_500, startTimeoutMs: 400 }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ServeError && err.code === "NOT_SERVED");
      assert.ok(never.starts.length >= 2 && never.starts.length <= 4, `a start that never opens is retried after the start timeout (${never.starts.length} starts)`);
    } finally {
      disk.remove();
    }
  });

  it("a start the supervisor reports in flight (`starting`, inside its start grace) is waited for, never doubled", { timeout: 20_000 }, async () => {
    const disk = new LocalDisk("serve-starting");
    const counters = newCounters();
    const instances: { run: DurableRun; server: RunServer }[] = [];
    try {
      // Another supervisor started generation 1 just now: its start mark is written, nothing is mounted yet.
      await disk.putObject(`runs/${REF.id}/start.json`, JSON.stringify({ generation: 1, at: new Date().toISOString(), by: "other:1" }));
      void sleep(500).then(() => served(disk, counters)).then((i) => instances.push(i));
      const host = new InProcessHost(async () => {
        throw new Error("this client must not start a second instance");
      });
      const r = await requestRun(REF, { method: "POST", path: "/submit", body: { requestId: "s1", content: "hello", wait: true } }, { host, ensure: { control: disk }, timeoutMs: 10_000 });
      assert.equal(r.status, 200);
      assert.deepEqual(r.ensured.map((e) => e.action), ["starting"], "asked once, then waited for generation 1");
      assert.equal(host.starts.length, 0);
      assert.equal((r.body as any).generation, 1);
    } finally {
      for (const i of instances) (await i.run.release().catch(() => {}), await i.server.close());
      disk.remove();
    }
  });
});
