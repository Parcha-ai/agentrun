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
  constructor(name: string, id: number, onTerminate: (id: string) => Promise<void>) {
    this.name = name;
    this.sandboxId = `sb-${id}`;
    this.onTerminate = onTerminate;
  }
  async exec() {
    return { stdin: { writeBytes: async () => undefined, close: async () => undefined }, stdout: { readBytes: async () => empty }, stderr: { readBytes: async () => empty }, wait: async () => 0 };
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

async function world(failTerminate: (id: string, attempt: number) => boolean, gate?: Promise<void>) {
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
  });
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
