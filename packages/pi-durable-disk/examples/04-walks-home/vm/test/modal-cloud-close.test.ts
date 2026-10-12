// Closing the Modal cloud removes every sandbox it made although removing one fails: a sandbox left behind costs by the minute (an H100
// by the minute at that). The Modal here is a fake whose sandboxes run nothing; the first one's terminate throws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modalCloud } from "../modal-cloud.ts";

const empty = new Uint8Array();

class FakeSandbox {
  readonly sandboxId: string;
  tags: Record<string, string> = {};
  exit: number | null = null;
  readonly name: string;
  readonly onTerminate: (id: string) => Promise<void>;
  /** Set by a test: the box's commands wait for this (a box still preparing). */
  static execGate: Promise<void> | undefined;
  /** Set by a test: the exit code every command returns, how long it takes, and every argv it was given. */
  static execExit = 0;
  static execDelayMs = 0;
  static execs: string[][] = [];
  constructor(name: string, id: number, onTerminate: (id: string) => Promise<void>) {
    this.name = name;
    this.sandboxId = `sb-${id}`;
    this.onTerminate = onTerminate;
  }
  async exec(argv?: string[]) {
    await FakeSandbox.execGate;
    if (argv) FakeSandbox.execs.push(argv);
    if (FakeSandbox.execDelayMs) await new Promise((r) => setTimeout(r, FakeSandbox.execDelayMs));
    const exit = FakeSandbox.execExit;
    return { stdin: { writeBytes: async () => undefined, close: async () => undefined }, stdout: { readBytes: async () => empty }, stderr: { readBytes: async () => empty }, wait: async () => exit };
  }
  async poll() {
    return this.exit;
  }
  async terminate() {
    await this.onTerminate(this.sandboxId);
    this.exit = 137;
  }
  async setTags(tags: Record<string, string>) {
    this.tags = { ...tags };
  }
  async getTags() {
    return { ...this.tags };
  }
}

async function world(failTerminate: (id: string, attempt: number) => boolean, gate?: Promise<void>, extra: Record<string, unknown> = {}) {
  const boxes: FakeSandbox[] = [];
  const attempts: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const sdk = {
    apps: { fromName: async (name: string) => ({ appId: `ap-${name}` }) },
    images: { fromRegistry: (tag: string) => ({ registry: tag, dockerfileCommands: () => ({}) }), fromId: async (id: string) => ({ id }) },
    sandboxes: {
      async create(_app: unknown, _image: unknown, params: { name: string }) {
        await gate;
        const box = new FakeSandbox(params.name, boxes.length + 1, async (id) => {
          attempts.push(id);
          if (failTerminate(id, attempts.filter((a) => a === id).length)) throw new Error("modal is having a moment");
        });
        boxes.push(box);
        return box;
      },
      fromId: async (id: string) => boxes.find((b) => b.sandboxId === id) ?? Promise.reject(new Error(`no sandbox ${id}`)),
      fromName: async (_app: string, name: string) => boxes.find((b) => b.name === name) ?? Promise.reject(new Error(`no sandbox ${name}`)),
      async *list() {
        yield* boxes.filter((b) => b.exit === null);
      },
    },
  };
  const cloud = await modalCloud({
    disk: "dsk-test",
    region: "test",
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 },
    log: (event, data = {}) => void logs.push({ event, data }),
    sdk: sdk as never,
    control: {} as never,
    transport: "pipe",
    warm: true,
    closeWaitMs: 5_000,
    ...extra,
  } as Parameters<typeof modalCloud>[0]);
  const ref = (id: string) => ({ disk: "dsk-test", region: "test", id });
  const up = async (runs: string[]) => {
    for (const r of runs) cloud.prewarm!(ref(r));
    for (const t0 = Date.now(); logs.filter((l) => l.event === "remote.ready").length < runs.length; await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() - t0 > 20_000) throw new Error(`the sandboxes did not come up: ${logs.map((l) => `${l.event} ${JSON.stringify(l.data).slice(0, 200)}`).join(" | ")}`);
    }
  };
  return { cloud, boxes, attempts, logs, ref, up };
}

test("close removes the second sandbox although terminating the first keeps failing, and says what is left", async () => {
  const w = await world((id) => id === "sb-1");
  await w.up(["run-a", "run-b"]);
  assert.equal(w.boxes.length, 2);
  await w.cloud.close!();
  assert.equal(w.boxes[1]!.exit, 137, "the second one is gone");
  assert.ok(w.attempts.filter((a) => a === "sb-1").length >= 2, "the failing one was tried again");
  assert.ok(w.logs.some((l) => l.event === "modal.delete-failed" && /moment/.test(String(l.data.error))), "each failure is reported");
  const summary = w.logs.find((l) => l.event === "close.failures");
  assert.equal(summary?.data.left, 1, "close says one sandbox is still there");
});

test("the take's warm GPU box: a removal that fails once (its server's stop of the run did) is retried by close, and the box is terminated", async () => {
  const w = await world((_id, attempt) => attempt === 1);
  await w.up(["run-a"]);
  await w.cloud.stopRemote!(w.ref("run-a")); // the server's own cleanup: the first terminate throws, the sandbox must not be forgotten
  assert.equal(w.boxes[0]!.exit, null, "still running after the failed removal");
  await w.cloud.close!();
  assert.equal(w.boxes[0]!.exit, 137, "close terminated it on the retry");
});

test("a box whose create is still in flight when close begins is removed when it lands, and no box is made after close", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const w = await world(() => false, gate);
  w.cloud.prewarm!(w.ref("run-a")); // the create waits at the gate
  const closing = w.cloud.close!();
  await new Promise((r) => setTimeout(r, 100));
  open(); // the create returns after close began
  await closing;
  assert.equal(w.boxes.length, 1);
  assert.equal(w.boxes[0]!.exit, 137, "the box that landed after close began was terminated");
  assert.ok(!w.logs.some((l) => l.event === "remote.ready"), "it was never prepared for a run that is gone");
  w.cloud.prewarm!(w.ref("run-b"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.boxes.length, 1, "no box is made once the cloud is closing");
});

test("a remote start that the server gave up on leaves no box behind", async () => {
  const w = await world(() => false);
  await w.up(["run-a"]);
  const envId = w.cloud.environments.find((e) => e.kind === "remote")!.id;
  const gaveUp = new AbortController();
  gaveUp.abort();
  await assert.rejects(() => w.cloud.startRemote!(w.ref("run-a"), envId, { t: "invite", run: "run-a", token: "t", tab: "x", switchId: "s" }, gaveUp.signal), /cancelled/);
  assert.equal(w.boxes[0]!.exit, 137, "the box the cancelled start would have used is gone");
  await w.cloud.stopRemote!(w.ref("run-a")); // the server's own cleanup finds nothing and does not fail
  await w.cloud.close!();
});

test("a remote start that fails after the box is up (no tunnel) removes the box", async () => {
  const w = await world(() => false);
  await w.up(["run-a"]);
  const envId = w.cloud.environments.find((e) => e.kind === "remote")!.id;
  await assert.rejects(() => w.cloud.startRemote!(w.ref("run-a"), envId, { t: "invite", run: "run-a", token: "t", tab: "x", switchId: "s" }));
  assert.equal(w.boxes[0]!.exit, 137, "a start that fails leaves nothing charging");
});

test("close does not wait for a box that is past its create and still preparing: it removes it and returns", async () => {
  let release!: () => void;
  FakeSandbox.execGate = new Promise<void>((r) => (release = r));
  try {
    const w = await world(() => false);
    w.cloud.prewarm!(w.ref("run-a"));
    for (const end = Date.now() + 10_000; w.boxes.length === 0; await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("the box was never created");
    const started = Date.now();
    await w.cloud.close!();
    assert.ok(Date.now() - started < 3_000, `close took ${Date.now() - started} ms: it waited for the preparing box`);
    assert.equal(w.boxes[0]!.exit, 137, "the preparing box was terminated by the sweep");
    release();
  } finally {
    release();
    FakeSandbox.execGate = undefined;
  }
});

test("the cluster: its boxes come up together, are ready when the pool says so, and close removes every one", async () => {
  const w = await world(() => false, undefined, { cluster: { size: 3, image: "im-cluster", cpu: 8, memoryMiB: 65536, start: "now" } });
  await w.cloud.cluster!.start();
  const status = w.cloud.cluster!.status();
  assert.equal(status.boxes.length, 3);
  assert.deepEqual(status.boxes.map((b) => b.state), ["ready", "ready", "ready"]);
  assert.equal(w.boxes.length, 3);
  await w.cloud.close!();
  assert.deepEqual(w.boxes.map((b) => b.exit), [137, 137, 137], "no cluster box is left running");
});

test("the cluster: a close while its boxes are still being created removes them when they land", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const w = await world(() => false, gate, { cluster: { size: 2, image: "im-cluster", start: "now" } });
  const closing = w.cloud.close!();
  await new Promise((r) => setTimeout(r, 100));
  open();
  await closing;
  await w.cloud.cluster!.start();
  assert.equal(w.boxes.length, 2);
  assert.deepEqual(w.boxes.map((b) => b.exit), [137, 137], "boxes that landed after close began were terminated");
});

test("the cluster starts when the first page takes the run (prewarm), not before, and only once", async () => {
  const w = await world(() => false, undefined, { cluster: { size: 2, image: "im-cluster" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(w.boxes.length, 0, "nothing is created until a page attaches");
  w.cloud.prewarm!(w.ref("run-a"));
  w.cloud.prewarm!(w.ref("run-a"));
  await w.cloud.cluster!.start();
  assert.equal(w.boxes.filter((b) => b.name.includes("gpu")).length, 2, "two cluster boxes, once");
  await w.cloud.close!();
});

const reset = () => {
  FakeSandbox.execExit = 0;
  FakeSandbox.execDelayMs = 0;
  FakeSandbox.execs = [];
};

test("the cluster: boxes are owned per run, so one run cannot get, run in or release another run's box by using the same thread id", async () => {
  const w = await world(() => false, undefined, { cluster: { size: 2, image: "im-cluster", start: "now" } });
  await w.cloud.cluster!.start();
  const a = w.cloud.cluster!.gpuFor("run-a");
  const b = w.cloud.cluster!.gpuFor("run-b");
  const boxA = await a.acquire("x");
  assert.equal(a.holds(boxA), true);
  assert.equal(b.holds(boxA), false, "run b does not hold run a's box");
  const boxB = await b.acquire("x"); // the same thread id, another run
  assert.notEqual(boxB, boxA, "a different box");
  await assert.rejects(b.exec(boxA, ["id"], {}), /no thread of this run holds that box/);
  await assert.rejects(b.poll(boxA), /no thread of this run holds that box/);
  b.release("x");
  assert.equal(a.holds(boxA), true, "run b's release did not free run a's box");
  await w.cloud.close!();
});

test("the cluster: a command runs in its own session with its group recorded, and kill ends the group", async () => {
  reset();
  const w = await world(() => false, undefined, { cluster: { size: 1, image: "im-cluster", start: "now" } });
  await w.cloud.cluster!.start();
  const g = w.cloud.cluster!.gpuFor("run-a");
  const box = await g.acquire("t");
  FakeSandbox.execs = [];
  const p = await g.exec(box, ["train-skill", "walk", "--out", "/workspace/skills/walk"], { timeoutMs: 5000 });
  const ran = FakeSandbox.execs.at(-1)!;
  assert.deepEqual([ran[0], ran[1]], ["sh", "-c"]);
  assert.match(ran[2]!, /setsid -w/);
  assert.deepEqual(ran.slice(4), ["train-skill", "walk", "--out", "/workspace/skills/walk"], "the argv goes through untouched");
  assert.match(ran[3]!, /^\/tmp\/\.pda-rpc\//, "its pid file");
  await p.kill!();
  const killer = FakeSandbox.execs.at(-1)!;
  assert.match(killer[2]!, /kill -TERM -- -\$p/);
  assert.equal(killer[3], ran[3], "the same pid file");
  await w.cloud.close!();
  reset();
});

test("the cluster: a box that never gets ready is removed, and if Modal would not take it the first time it stays tracked and close tries again", async () => {
  reset();
  FakeSandbox.execExit = 1; // the readiness command keeps failing
  const w = await world((_id, attempt) => attempt === 1, undefined, { cluster: { size: 1, image: "im-cluster", readyCommand: "false", readyTimeoutMs: 1_200, start: "now" } });
  await w.cloud.cluster!.start();
  assert.equal(w.cloud.cluster!.status().boxes[0]!.state, "failed");
  assert.equal(w.boxes[0]!.exit, null, "the first removal failed: the box is still there");
  await w.cloud.close!();
  assert.equal(w.boxes[0]!.exit, 137, "close tried again, because the box was never untracked");
  reset();
});

test("the cluster: closing while a box is warming up stops the warm-up and removes the box", async () => {
  reset();
  FakeSandbox.execExit = 1;
  const w = await world(() => false, undefined, { cluster: { size: 1, image: "im-cluster", readyCommand: "false", readyTimeoutMs: 60_000, start: "now" } });
  const warming = w.cloud.cluster!.start();
  for (const end = Date.now() + 5_000; w.boxes.length === 0; await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("no box");
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await w.cloud.close!();
  await warming;
  assert.ok(Date.now() - t0 < 4_000, `close took ${Date.now() - t0} ms: it waited out the warm-up`);
  assert.equal(w.boxes[0]!.exit, 137);
  const before = FakeSandbox.execs.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(FakeSandbox.execs.length, before, "no readiness command runs after close");
  reset();
});

test("the cluster: a readiness answer that comes after the deadline is not accepted", async () => {
  reset();
  FakeSandbox.execDelayMs = 1_500; // answers success, but only after the 1 s the box was given
  const w = await world(() => false, undefined, { cluster: { size: 1, image: "im-cluster", readyCommand: "true", readyTimeoutMs: 1_000, start: "now" } });
  await w.cloud.cluster!.start();
  assert.equal(w.cloud.cluster!.status().boxes[0]!.state, "failed");
  assert.match(w.cloud.cluster!.status().boxes[0]!.error ?? "", /not ready in 1 s.*too late/);
  await w.cloud.close!();
  assert.equal(w.boxes[0]!.exit, 137);
  reset();
});

test("the cluster: a box whose poll says it ended is dead for good: the pool never hands it out again", async () => {
  reset();
  const w = await world(() => false, undefined, { cluster: { size: 2, image: "im-cluster", start: "now", watchMs: 0 } });
  await w.cloud.cluster!.start();
  const g = w.cloud.cluster!.gpuFor("run-a");
  const box = await g.acquire("t");
  const sandbox = w.boxes.find((b) => b.sandboxId === box)!;
  sandbox.exit = 137; // its TTL ran out
  assert.equal(await g.poll(box), 137, "the thread is told how it ended");
  assert.equal(w.cloud.cluster!.status().boxes.find((b) => b.id === box)?.state, "failed");
  g.release("t");
  const next = await w.cloud.cluster!.gpuFor("run-b").acquire("u");
  assert.notEqual(next, box, "another thread never gets the dead box");
  await w.cloud.close!();
  reset();
});
