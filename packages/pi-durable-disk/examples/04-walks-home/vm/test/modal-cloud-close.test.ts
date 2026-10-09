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

test("close removes the second sandbox although terminating the first throws, and says so", async () => {
  const boxes: FakeSandbox[] = [];
  const attempts: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const sdk = {
    apps: { fromName: async (name: string) => ({ appId: `ap-${name}` }) },
    images: { fromRegistry: (tag: string) => ({ registry: tag, dockerfileCommands: () => ({}) }), fromId: async (id: string) => ({ id }) },
    sandboxes: {
      async create(_app: unknown, _image: unknown, params: { name: string }) {
        const box = new FakeSandbox(params.name, boxes.length + 1, async (id) => {
          attempts.push(id);
          if (id === "sb-1") throw new Error("modal is having a moment");
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
  });
  cloud.prewarm!({ disk: "dsk-test", region: "test", id: "run-a" });
  cloud.prewarm!({ disk: "dsk-test", region: "test", id: "run-b" });
  for (const t0 = Date.now(); logs.filter((l) => l.event === "remote.ready").length < 2; await new Promise((r) => setTimeout(r, 25))) {
    if (Date.now() - t0 > 20_000) throw new Error(`the sandboxes did not come up: ${logs.map((l) => l.event).join(",")}`);
  }
  assert.equal(boxes.length, 2);
  await cloud.close!();
  assert.deepEqual([...attempts].sort(), ["sb-1", "sb-2"], "both were asked to terminate");
  assert.equal(boxes[1]!.exit, 137, "the second one is gone");
  assert.ok(logs.some((l) => l.event === "modal.delete-failed" && /moment/.test(String(l.data.error))), "the failure is reported");
});
