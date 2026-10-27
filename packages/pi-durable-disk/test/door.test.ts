// The serve door with a hook (`AppOptions.door`): a harness of the app's own takes the input. Every submit is admitted
// in the root conversation (a `door.input` entry, through the run's fenced commit) before the hook sees it, a requestId
// reaches the hook at most once across incarnations, and its outcome is settled on the same record. A scripted hook
// stands in for the harness: no network, no model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { serveUntilDone } from "../src/cli.ts";
import type { DurableRun } from "../src/run.ts";
import { serveRun, type DoorContext, type DoorHook, type DoorInput, type RunServer } from "../src/serve.ts";
import { lifecycleApp, LocalDisk, newCounters, openOn, sleep, until } from "./_lifecycle.ts";
import { alive, ctx, killQuietly, waitGone } from "./_run-support.ts";
import { FaultyDatabase, SQLITE_IOERR_FSYNC, sqliteError } from "./_support.ts";

const REF = { disk: "dsk-local", region: "local", id: "door-1" };
const TOKEN = "door-test-token";

type Reply = { status: number; body: Record<string, any> };
async function call(server: RunServer, method: "GET" | "POST", path: string, body?: unknown, token: string | null = null): Promise<Reply> {
  const res = await fetch(new URL(path, server.url), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const submit = (server: RunServer, requestId: string, content = "hello") => call(server, "POST", "/submit", { requestId, content });

type Outcome = { accepted: true } | { accepted: false; reason: "busy" };

/** A hook whose submit and abort the test scripts; it records every call. */
function scripted(options: { submit?: (input: DoorInput, ctx: DoorContext) => Promise<Outcome>; abort?: (ctx: DoorContext) => Promise<"aborted" | "idle"> } = {}) {
  const calls = { submit: [] as DoorInput[], abort: 0, signals: [] as AbortSignal[] };
  const state = { busy: false };
  const hook: DoorHook = {
    async submit(input, ctx) {
      calls.submit.push(input);
      calls.signals.push(ctx.signal);
      return (options.submit ?? (async () => ({ accepted: true }) as const))(input, ctx);
    },
    async abort(ctx) {
      calls.abort++;
      return (options.abort ?? (async () => "aborted" as const))(ctx);
    },
    busy: () => state.busy,
  };
  return { hook, calls, state };
}

/** The door's records of the root conversation, oldest first. */
async function doorEntries(run: DurableRun): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  const page = await (await run.harness.root(ctx)).entries({ order: "ascending" }, 500, undefined, ctx);
  return page.items.filter((e) => e.kind.startsWith("door.")).map((e) => ({ kind: e.kind, data: e.data as Record<string, unknown> }));
}

async function served(disk: LocalDisk, hook: DoorHook, extra: { token?: string; submitMs?: number; abortMs?: number; decorateStore?: (db: SqliteDatabase) => SqliteDatabase } = {}) {
  const app = lifecycleApp(newCounters());
  const fenced: unknown[] = [];
  const server = await serveRun({
    root: { agent: app.agent },
    ...(extra.token ? { token: extra.token } : {}),
    doorTimeouts: { submitMs: extra.submitMs ?? 5_000, abortMs: extra.abortMs ?? 1_000 },
  });
  const run = await openOn(disk, REF, app, { fenced, ...(extra.decorateStore ? { decorateStore: extra.decorateStore } : {}) });
  server.attach(run, hook);
  return { server, run, app, fenced };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

/** An event stream's frames as they arrive: the snapshot, then every event of every batch, in order. */
function openEvents(server: RunServer) {
  let text = "";
  const req = httpRequest(new URL("/events", server.url));
  const ready = new Promise<void>((resolve) =>
    req.on("response", (res) => {
      res.setEncoding("utf8").on("data", (c: string) => (text += c));
      resolve();
    }),
  );
  req.end();
  const frames = () =>
    text
      .split("\n\n")
      .filter((f) => f.startsWith("event: "))
      .map((f) => ({ event: f.slice(7, f.indexOf("\n")), data: JSON.parse(f.slice(f.indexOf("\ndata: ") + 7)) }));
  const events = () => frames().flatMap((f) => (f.event === "events" ? (f.data as { type: string; entry?: { kind: string } }[]) : []));
  return { ready, frames, events, close: () => req.destroy() };
}

describe("the door hook: admission", () => {
  it("admits the input in the root conversation before the hook sees it; a retry answers ACCEPTED and never calls the hook again", async () => {
    const disk = new LocalDisk("door-admit");
    try {
      let run!: DurableRun;
      const seenAtCall: unknown[] = [];
      const { hook, calls } = scripted({
        submit: async (input) => {
          seenAtCall.push((await doorEntries(run)).filter((e) => e.data.requestId === input.requestId));
          return { accepted: true };
        },
      });
      const s = await served(disk, hook);
      run = s.run;
      const first = await submit(s.server, "r1", "hello");
      assert.deepEqual([first.status, first.body.status, first.body.requestId, first.body.generation], [200, "ACCEPTED", "r1", 1]);
      assert.deepEqual(calls.submit, [{ requestId: "r1", content: "hello", whenBusy: "followUp" }]);
      assert.deepEqual(seenAtCall, [[{ kind: "door.input", data: { requestId: "r1", content: "hello", whenBusy: "followUp", status: "ADMITTED" } }]], "the admission was durable when the hook ran");
      const again = await submit(s.server, "r1", "hello");
      assert.deepEqual([again.status, again.body.status], [200, "ACCEPTED"]);
      assert.equal(calls.submit.length, 1, "a retry never reaches the hook");
      assert.deepEqual((await doorEntries(run)).map((e) => [e.kind, e.data.status]), [["door.input", "ADMITTED"], ["door.status", "ACCEPTED"]]);
      await run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("two submits of one requestId together reach the hook once: the second answers 202 ADMITTED while the hook runs", async () => {
    const disk = new LocalDisk("door-together");
    try {
      const gate = deferred<Outcome>();
      const { hook, calls } = scripted({ submit: () => gate.promise });
      const s = await served(disk, hook);
      const [a, b] = [submit(s.server, "same"), submit(s.server, "same")];
      await until("the hook's call", () => calls.submit.length >= 1);
      const second = await Promise.race([a, b]);
      assert.deepEqual([second.status, second.body.status], [202, "ADMITTED"]);
      gate.resolve({ accepted: true });
      const replies = await Promise.all([a, b]);
      assert.deepEqual(replies.map((r) => r.status).sort(), [200, 202]);
      assert.equal(calls.submit.length, 1);
      assert.equal((await doorEntries(s.run)).filter((e) => e.kind === "door.input").length, 1, "one admission");
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("order: without the token, while opening and while parking, nothing is admitted and the hook is not called", async () => {
    const disk = new LocalDisk("door-order");
    try {
      const { hook, calls } = scripted();
      const app = lifecycleApp(newCounters());
      const server = await serveRun({ root: { agent: app.agent }, token: TOKEN });
      const opening = await call(server, "POST", "/submit", { requestId: "o1", content: "x" }, TOKEN);
      assert.deepEqual([opening.status, opening.body.error], [503, "OPENING"]);
      const run = await openOn(disk, REF, app);
      server.attach(run, hook);
      const none = await call(server, "POST", "/submit", { requestId: "t1", content: "x" });
      assert.deepEqual([none.status, none.body.error], [401, "UNAUTHORIZED"]);
      const resume = server.pause();
      const parking = await call(server, "POST", "/submit", { requestId: "p1", content: "x" }, TOKEN);
      assert.deepEqual([parking.status, parking.body.error], [503, "PARKING"]);
      resume();
      assert.equal(calls.submit.length, 0);
      assert.deepEqual(await doorEntries(run), []);
      const ok = await call(server, "POST", "/submit", { requestId: "t1", content: "x" }, TOKEN);
      assert.deepEqual([ok.status, ok.body.status], [200, "ACCEPTED"]);
      await run.release();
      await server.close();
    } finally {
      disk.remove();
    }
  });

  it("a lease lost at the admission's commit fails it: 503 RELEASED, nothing admitted, the hook never called; and nothing reaches it after", async () => {
    const disk = new LocalDisk("door-fence");
    try {
      const faulty: { database?: FaultyDatabase } = {};
      const { hook, calls } = scripted();
      const s = await served(disk, hook, { decorateStore: (db) => (faulty.database = new FaultyDatabase(db)) });
      assert.equal((await submit(s.server, "f0")).status, 200);
      assert.equal(calls.submit.length, 1, "the door reaches the hook while the lease holds");
      faulty.database!.failNextCommit(sqliteError(SQLITE_IOERR_FSYNC, "disk I/O error"));
      const lost = await submit(s.server, "f1");
      assert.deepEqual([lost.status, lost.body.error], [503, "RELEASED"]);
      assert.equal(calls.submit.length, 1, "the hook was not called");
      await until("the fence", () => s.fenced.length === 1);
      const rows = await faulty.database!.inner.all<{ record: string }>("SELECT record FROM entries");
      assert.deepEqual(rows.map((r) => JSON.parse(r.record)).filter((e) => e.kind === "door.input").map((e) => e.data.requestId), ["f0"], "no admission of f1 is durable");
      const after = await submit(s.server, "f2");
      assert.deepEqual([after.status, after.body.error], [503, "RELEASED"]);
      assert.equal(calls.submit.length, 1);
      await s.server.close();
      await faulty.database!.inner.close();
    } finally {
      disk.remove();
    }
  });
});

describe("the door hook: outcomes", () => {
  it("REJECTED_BUSY is 409 BUSY and terminal for its requestId; FAILED (the hook threw before taking it) is 500; each retry answers its record", async () => {
    const disk = new LocalDisk("door-states");
    try {
      const { hook, calls } = scripted({
        submit: async (input) => {
          if (input.requestId === "busy") return { accepted: false, reason: "busy" };
          throw new Error("the harness child is gone");
        },
      });
      const s = await served(disk, hook);
      for (let i = 0; i < 2; i++) {
        const busy = await submit(s.server, "busy");
        assert.deepEqual([busy.status, busy.body.error, busy.body.status], [409, "BUSY", "REJECTED_BUSY"]);
        const failed = await submit(s.server, "boom");
        assert.deepEqual([failed.status, failed.body.error, failed.body.status], [500, "FAILED", "FAILED"]);
        assert.match(failed.body.message, /the harness child is gone/);
      }
      assert.deepEqual(calls.submit.map((c) => c.requestId), ["busy", "boom"]);
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("at the bound: ctx.signal aborts, hook.abort is called, 504 UNKNOWN; a late outcome settles the same record and a retry never re-submits", async () => {
    const disk = new LocalDisk("door-unknown");
    try {
      const late: Record<string, ReturnType<typeof deferred<Outcome>>> = { acc: deferred(), busy: deferred(), boom: deferred() };
      const { hook, calls } = scripted({ submit: (input) => late[input.requestId]!.promise });
      const s = await served(disk, hook, { submitMs: 100, abortMs: 100 });
      for (const id of Object.keys(late)) {
        const r = await submit(s.server, id);
        assert.deepEqual([r.status, r.body.error, r.body.status], [504, "UNKNOWN", "UNKNOWN"], id);
      }
      assert.ok(calls.signals.every((signal) => signal.aborted), "ctx.signal aborted at the bound");
      assert.equal(calls.abort, 3, "hook.abort called at each bound");
      const before = await submit(s.server, "acc");
      assert.deepEqual([before.status, before.body.status], [504, "UNKNOWN"], "a retry before the late outcome answers UNKNOWN");
      late.acc!.resolve({ accepted: true });
      late.busy!.resolve({ accepted: false, reason: "busy" });
      late.boom!.reject(new Error("late failure"));
      await until("the late outcomes", async () => (await doorEntries(s.run)).filter((e) => e.kind === "door.status").length === 6);
      assert.deepEqual([(await submit(s.server, "acc")).status, (await submit(s.server, "busy")).status, (await submit(s.server, "boom")).status], [200, 409, 500]);
      assert.deepEqual(calls.submit.map((c) => c.requestId), ["acc", "busy", "boom"], "no requestId was submitted twice");
      assert.deepEqual(
        (await doorEntries(s.run)).filter((e) => e.data.requestId === "acc").map((e) => e.data.status),
        ["ADMITTED", "UNKNOWN", "ACCEPTED"],
      );
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("an accept just after the bound (an abort that lost the race to delivery) ends ACCEPTED, with no second submit", async () => {
    const disk = new LocalDisk("door-race");
    try {
      const { hook, calls } = scripted({
        submit: async () => {
          await sleep(130);
          return { accepted: true };
        },
        abort: async () => "idle",
      });
      const s = await served(disk, hook, { submitMs: 100, abortMs: 100 });
      const r = await submit(s.server, "race");
      assert.deepEqual([r.status, r.body.status], [504, "UNKNOWN"]);
      await until("the late accept", async () => (await submit(s.server, "race")).body.status === "ACCEPTED");
      assert.deepEqual((await submit(s.server, "race")).status, 200);
      assert.equal(calls.submit.length, 1);
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("UNKNOWN and ADMITTED records outlive the process: the next incarnation answers them and never calls submit for them", async () => {
    const disk = new LocalDisk("door-restart");
    try {
      const one = scripted({ submit: () => new Promise(() => {}) });
      const a = await served(disk, one.hook, { submitMs: 100, abortMs: 50 });
      assert.equal((await submit(a.server, "unknown")).status, 504);
      await a.run.release();
      await a.server.close();
      // A process that dies while its hook holds the input leaves the record ADMITTED.
      const two = scripted({ submit: () => new Promise(() => {}) });
      const b = await served(disk, two.hook, { submitMs: 60_000 });
      const pending = submit(b.server, "admitted").catch(() => undefined);
      await until("the hook's call", () => two.calls.submit.length === 1);
      await b.run.release();
      await b.server.close();
      await pending;

      const three = scripted();
      const c = await served(disk, three.hook);
      const unknown = await submit(c.server, "unknown");
      assert.deepEqual([unknown.status, unknown.body.status], [504, "UNKNOWN"]);
      const admitted = await submit(c.server, "admitted");
      assert.deepEqual([admitted.status, admitted.body.status, admitted.body.generation], [202, "ADMITTED", 3]);
      assert.equal(three.calls.submit.length, 0, "the resume submitted nothing again");
      await c.run.release();
      await c.server.close();
    } finally {
      disk.remove();
    }
  });
});

describe("the door hook: abort, status, events", () => {
  it("POST /abort calls hook.abort with today's answer shape; GET /status's busy comes from hook.busy()", async () => {
    const disk = new LocalDisk("door-abort");
    try {
      const { hook, calls, state } = scripted({ abort: async () => (state.busy ? "aborted" : "idle") });
      const s = await served(disk, hook);
      assert.deepEqual((await call(s.server, "GET", "/status")).body.busy, { kind: "idle" });
      state.busy = true;
      assert.deepEqual((await call(s.server, "GET", "/status")).body.busy, { kind: "busy" });
      const aborted = await call(s.server, "POST", "/abort", {});
      assert.deepEqual([aborted.status, aborted.body], [200, { result: "aborted" }]);
      state.busy = false;
      assert.deepEqual((await call(s.server, "POST", "/abort", {})).body, { result: "idle" });
      assert.equal(calls.abort, 2);
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("the events stream: snapshot.run follows hook.busy(); the hook's run_start, its entries and its run_end arrive in order", async () => {
    const disk = new LocalDisk("door-events");
    try {
      let turnEnded = false;
      const { hook, state } = scripted({
        submit: async (input, door) => {
          state.busy = true;
          door.emit({ type: "run_start" });
          void (async () => {
            const root = await door.run.harness.root(ctx);
            await door.run.harness.commit((tx) => tx.appendEntry(root.id, { kind: "app.turn", data: { said: input.content as string } }), ctx);
            state.busy = false;
            door.emit({ type: "run_end" });
            turnEnded = true;
          })();
          return { accepted: true };
        },
      });
      const s = await served(disk, hook);
      const idle = openEvents(s.server);
      await idle.ready;
      await until("the snapshot", () => idle.frames().length >= 1);
      assert.equal(idle.frames()[0]!.event, "snapshot");
      assert.equal(idle.frames()[0]!.data.run, undefined, "idle: no run in the snapshot");
      idle.close();

      const stream = openEvents(s.server);
      await stream.ready;
      await until("the snapshot", () => stream.frames().length >= 1);
      assert.equal((await submit(s.server, "ev1", "hi")).status, 200);
      await until("the hook's turn", () => turnEnded, 3_000);
      await until("the run_end", () => stream.events().some((e) => e.type === "run_end"));
      const types = stream.events().map((e) => (e.type === "entry_appended" ? `entry ${e.entry!.kind}` : e.type));
      const at = (t: string) => types.indexOf(t);
      assert.ok(at("run_start") >= 0 && at("entry app.turn") > at("run_start") && at("run_end") > at("entry app.turn"), types.join(", "));
      assert.equal(types.filter((t) => t === "run_start").length, 1);
      assert.equal(types.filter((t) => t === "run_end").length, 1);

      state.busy = true;
      const busy = openEvents(s.server);
      await busy.ready;
      await until("the snapshot", () => busy.frames().length >= 1);
      assert.deepEqual(busy.frames()[0]!.data.run, { inputs: [] }, "busy: the snapshot has a run");
      busy.close();
      stream.close();
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });

  it("run_end pairs run_start when the hook throws after emitting run_start", async () => {
    const disk = new LocalDisk("door-pair");
    try {
      const { hook } = scripted({
        submit: async (_input, ctx) => {
          ctx.emit({ type: "run_start" });
          throw new Error("died mid-turn");
        },
      });
      const s = await served(disk, hook);
      const stream = openEvents(s.server);
      await stream.ready;
      await until("the snapshot", () => stream.frames().length >= 1);
      assert.equal((await submit(s.server, "p1")).status, 500);
      await until("the run_end", () => stream.events().some((e) => e.type === "run_end"), 2_000);
      const runs = stream.events().filter((e) => e.type === "run_start" || e.type === "run_end").map((e) => e.type);
      assert.deepEqual(runs, ["run_start", "run_end"]);
      stream.close();
      await s.run.release();
      await s.server.close();
    } finally {
      disk.remove();
    }
  });
});

describe("the door hook: SIGTERM", () => {
  it("a hook whose abort never settles: the drain kills the harness child's process group, releases the run and exits with no child left", async () => {
    const disk = new LocalDisk("door-sigterm");
    let pid = 0;
    try {
      const { hook, state } = scripted({
        submit: async (_input, ctx) => {
          const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
          child.unref();
          pid = child.pid!;
          ctx.adopt(pid);
          state.busy = true;
          return { accepted: true };
        },
        abort: () => new Promise(() => {}),
      });
      const s = await served(disk, hook, { abortMs: 200 });
      assert.equal((await submit(s.server, "s1")).status, 200);
      assert.ok(alive(pid), "the harness child runs");
      const signals = new EventEmitter();
      const events: string[] = [];
      const exit = serveUntilDone(s.run, undefined, "resume", (e) => events.push(e), signals, { server: s.server });
      signals.emit("SIGTERM");
      assert.equal(await exit, 0);
      assert.ok(events.includes("released"));
      assert.ok(await waitGone(pid, 2_000), "no harness child outlives the instance");
      await s.server.close();
    } finally {
      killQuietly(pid);
      disk.remove();
    }
  });
});
