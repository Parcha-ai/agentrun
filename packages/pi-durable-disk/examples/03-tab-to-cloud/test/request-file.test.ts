// The user's message reaches a program on the other host as a FILE, byte for byte: a hostile topic is data, never part of a command.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer } from "../placement.ts";
import { REMOTE_LOCAL, remoteLocalHost } from "../pipe/remote-local.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

const HOSTILE = 'Make a model obsessed with x"; touch /tmp/pwned-by-topic; echo "$(id) `id` $HOME \\n\' --topic evil && rm -rf ~ #';

describe("the request file", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const placer: Placer = {
    requestFile: "obsession/request.txt",
    describe: (e) => e,
    async decide(q) {
      return { id: "d", phase: q.phase, question: PLACEMENT_QUESTIONS[q.phase], options: q.environments.map((id) => ({ id, label: id, probability: id === REMOTE_LOCAL.id ? 0.9 : 0.1 })), choice: q.phase === "start" ? REMOTE_LOCAL.id : "tab", latency_ms: 1, model: "scripted" };
    },
  };
  const cloud = remoteLocalHost();
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
    await cloud.close?.();
  });

  it("writes the message to the run's disk unchanged before the move, and nothing runs it", async () => {
    const { id, secret } = await local.server.createRun("request");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const page = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text: HOSTILE, requestId: "req-h" });
    for (const end = Date.now() + 30_000; !events.some((e) => e.event === "switch.start" && e.data.run === id); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("no move");
    const onDisk = readFileSync(join(local.root, "runs", id, "work", "obsession/request.txt"), "utf8");
    assert.equal(onDisk, HOSTILE, "byte for byte");
    assert.ok(events.findIndex((e) => e.event === "switch.start") >= 0);
    assert.ok(!events.some((e) => e.event === "placement.request-file-failed"));
    tab.close();
    page.close();
  });
});
