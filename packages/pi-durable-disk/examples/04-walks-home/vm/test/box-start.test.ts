// Programs started on the GPU box at creation: the box counts as ready only when its ready check passes; a secret travels in a root-only
// file that is removed afterwards, never inside a command line; and an unready box is an error rather than a box handed to the agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modalCloud } from "../modal-cloud.ts";

const empty = new Uint8Array();
const SECRET = "sk-test-SECRET-value-with'quote";

function world(readyAfter: number) {
  const execs: string[] = [];
  const uploads: { path: string; text: string }[] = [];
  let polls = 0;
  class Box {
    sandboxId = "sb-1";
    tags: Record<string, string> = {};
    exit: number | null = null;
    name: string;
    volumes: unknown;
    constructor(name: string, volumes: unknown) {
      this.name = name;
      this.volumes = volumes;
    }
    async exec(argv: string[]) {
      const cmd = argv.at(-1) ?? "";
      execs.push(cmd);
      const stdin: string[] = [];
      if (/engine-ready/.test(cmd)) polls++;
      const code = /engine-ready/.test(cmd) && polls < readyAfter ? 1 : 0;
      return { stdin: { writeBytes: async (b: Uint8Array) => void stdin.push(new TextDecoder().decode(b)), close: async () => undefined }, stdout: { readBytes: async () => empty }, stderr: { readBytes: async () => empty }, wait: async () => code };
    }
    async poll() { return this.exit; }
    async terminate() { this.exit = 137; }
    async setTags(t: Record<string, string>) { this.tags = { ...t }; }
    async getTags() { return { ...this.tags }; }
  }
  const made: Box[] = [];
  const sdk = {
    apps: { fromName: async (n: string) => ({ appId: `ap-${n}` }) },
    images: { fromRegistry: (t: string) => ({ registry: t, dockerfileCommands: () => ({}) }), fromId: async (id: string) => ({ id }) },
    volumes: { fromName: async (n: string) => ({ volume: n }) },
    sandboxes: {
      async create(_a: unknown, _i: unknown, params: { name: string; volumes?: unknown }) {
        const b = new Box(params.name, params.volumes);
        made.push(b);
        return b;
      },
      fromId: async () => made[0]!,
      fromName: async () => made[0]!,
      async *list() { yield* made; },
    },
  };
  return { sdk, execs, uploads, made, polls: () => polls };
}

test("start commands run as the run user in the background; the secret goes by file; the box is ready only when the check passes", async () => {
  process.env.TEST_BOX_SECRET = SECRET;
  const w = world(3);
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const cloud = await modalCloud({
    disk: "d", region: "r", model: { baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 },
    log: (event, data = {}) => void logs.push({ event, data }), sdk: w.sdk as never, control: {} as never, transport: "pipe", warm: "gpu",
    gpu: { image: "im-1", startCommands: ["python scripts/engine.py --port 8000 > /var/tmp/engine.log 2>&1"], startEnv: ["TEST_BOX_SECRET"], readyCommand: "grep -q engine-ready /var/tmp/engine.log", readyTimeoutMs: 60_000, volumes: { "/vol": "weights" } },
  } as never);
  const t0 = Date.now();
  cloud.prewarm!({ disk: "d", region: "r", id: "run-a" });
  for (; !logs.some((l) => l.event === "remote.ready" || l.event === "remote.warm-failed"); await new Promise((r) => setTimeout(r, 50))) if (Date.now() - t0 > 60_000) throw new Error("timed out");
  const failed = logs.find((l) => l.event === "remote.warm-failed");
  assert.equal(failed, undefined, JSON.stringify(failed));
  assert.deepEqual(w.made[0]!.volumes, { "/vol": { volume: "weights" } }, "the volume is mounted");
  assert.equal(w.polls(), 3, "the box was polled until the check passed");
  assert.ok(logs.findIndex((l) => l.event === "box.ready") < logs.findIndex((l) => l.event === "remote.ready"), "ready is reported after the check");
  const all = w.execs.join("\n");
  assert.doesNotMatch(all, /SECRET-value/, "no command line carries the secret");
  assert.match(all, /sudo -n -u pda -H env TEST_BOX_SECRET="\$TEST_BOX_SECRET"/, "the program is given it from the sourced file, as the run user");
  assert.match(all, /setsid -f bash -c/, "started in the background");
  assert.match(all, /rm -f \/root\/\.pda-start\.env/, "the file is removed once the programs started");
  await cloud.close!();
});

test("a box whose check never passes is an error, not a box for the agent", async () => {
  const w = world(1_000_000);
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const cloud = await modalCloud({
    disk: "d", region: "r", model: { baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 },
    log: (event, data = {}) => void logs.push({ event, data }), sdk: w.sdk as never, control: {} as never, transport: "pipe", warm: "gpu",
    gpu: { image: "im-1", startCommands: ["true"], readyCommand: "grep -q engine-ready /nowhere", readyTimeoutMs: 6_000 },
  } as never);
  cloud.prewarm!({ disk: "d", region: "r", id: "run-b" });
  const t0 = Date.now();
  for (; !logs.some((l) => l.event === "remote.warm-failed"); await new Promise((r) => setTimeout(r, 100))) if (Date.now() - t0 > 40_000) throw new Error("no failure reported");
  assert.match(String(logs.find((l) => l.event === "remote.warm-failed")!.data.error), /was not ready in 6 s/);
  assert.ok(!logs.some((l) => l.event === "remote.ready"));
  await cloud.close!();
});
