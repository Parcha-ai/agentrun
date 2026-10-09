// The pipe's protocol on a local directory: pi's storage conformance suite through a real WebSocket, write-through with
// its barrier ordering, restore, takeover and the epoch fence, the model proxy and its budget.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerConformance } from "./_conformance.ts";
import { PipeClient, remoteStorage } from "../tab/pipe-client.ts";
import { PipeLostError, toBase64 } from "../wire.ts";
import { localServer, modelStub } from "./_local.ts";

const text = (s: string) => toBase64(new TextEncoder().encode(s));

describe("storage conformance through the pipe", async () => {
  const local = await localServer({ scratchStores: true });
  const { id, secret } = await local.server.createRun("conf");
  let n = 0;
  after(() => local.remove());
  registerConformance("pipe", async (use) => {
    const client = new PipeClient({ url: local.url, run: id, token: secret, tab: `case-${++n}`, mode: "write", takeover: true });
    await client.ready;
    try {
      await use(remoteStorage(client));
    } finally {
      client.close();
    }
  });
});

describe("the pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let model: Awaited<ReturnType<typeof modelStub>>;
  let barrierCalls = 0;
  before(async () => {
    model = await modelStub(() => "hello from the stub");
    local = await localServer({
      model: { baseUrl: model.url, model: "gpt-stub", budgetTokens: 40 },
      writerGraceMs: 600,
      hooks: { barrier: async () => void barrierCalls++ },
    });
  });
  after(async () => {
    await local.remove();
    await model.close();
  });

  it("refuses a hello with the wrong secret", async () => {
    const { id } = await local.server.createRun("auth");
    const client = new PipeClient({ url: local.url, run: id, token: "wrong", tab: "t", mode: "write" });
    await assert.rejects(client.ready);
  });

  it("writes files under work/, syncs, and only then answers; restores them on the next attach", async () => {
    const { id, secret } = await local.server.createRun("files");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    const attached = await a.ready;
    assert.equal(attached.t, "attached");
    const before = barrierCalls;
    await a.syncFiles([
      { path: "notes/hello.txt", op: "write", data: text("hi\n") },
      { path: "empty", op: "mkdir" },
    ]);
    assert.equal(barrierCalls, before + 1);
    const work = join(local.root, "runs", id, "work");
    assert.equal(readFileSync(join(work, "notes/hello.txt"), "utf8"), "hi\n");
    assert.ok(existsSync(join(work, "empty")));
    for (const bad of ["../store/run.sqlite", "/etc/passwd", "a/./b", "a//b", ""]) {
      await assert.rejects(a.syncFiles([{ path: bad, op: "write", data: text("x") }]), /unsafe|relative/);
    }
    // A symbolic link the cloud's agent left is never followed by a write.
    symlinkSync("../store", join(work, "link"));
    await assert.rejects(a.syncFiles([{ path: "link/run.sqlite", op: "write", data: text("x") }]), /not a directory/);
    await a.syncFiles([{ path: "notes/hello.txt", op: "delete" }]);
    a.close();
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write" });
    const again = (await b.ready) as Extract<Awaited<typeof b.ready>, { t: "attached" }>;
    const paths = again.files.map((f) => `${f.kind}:${f.path}`).sort();
    assert.deepEqual(paths, ["directory:empty", "directory:notes", "symlink:link"]);
    b.close();
  });

  it("a takeover moves the run: the old tab's next call fails, the new one commits", async () => {
    const { id, secret } = await local.server.createRun("takeover");
    const lostA: string[] = [];
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onLost: (code) => lostA.push(code) });
    await a.ready;
    const sa = remoteStorage(a);
    const conv = await sa.mintId();
    assert.ok(conv);
    // Without takeover, a second device only watches.
    const viewer = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write" });
    assert.equal((await viewer.ready).t, "viewing");
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true });
    const attachedB = await b.ready;
    assert.equal(attachedB.t, "attached");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lostA, ["MOVED"]);
    await assert.rejects(sa.mintId(), (e: unknown) => e instanceof PipeLostError);
    await assert.rejects(a.syncFiles([{ path: "x", op: "write", data: text("x") }]), (e: unknown) => e instanceof PipeLostError);
    assert.ok(await remoteStorage(b).mintId());
    viewer.close();
    b.close();
  });

  it("proxies model calls with its own model name and stops at the budget", async () => {
    const { id, secret } = await local.server.createRun("model");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const first = await a.fetch("http://ignored/v1/chat/completions", { body: JSON.stringify({ model: "something-else", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(first.status, 200);
    const body = await first.text();
    assert.match(body, /hello from the stub/);
    assert.equal(model.requests.at(-1)!.model, "gpt-stub");
    assert.equal(model.requests.at(-1)!.stream, true);
    const second = await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) });
    await second.text();
    // 15 + 15 tokens spent of 40; the third call is still allowed, the fourth refused.
    await (await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) })).text();
    const refused = await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) });
    assert.equal(refused.status, 429);
    a.close();
  });

  it("a tab that stops pinging is gone: the pipe releases the run", async () => {
    const { id, secret } = await local.server.createRun("gone");
    const placements: string[] = [];
    local.server.on("placement", (run, p) => run === id && placements.push(p.where));
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 60_000 });
    await a.ready;
    await new Promise((r) => setTimeout(r, 1_500));
    assert.deepEqual(placements.slice(-2), ["moving", "parked"]);
    assert.equal(local.server.runs.get(id)!.pipe, undefined);
    const record = JSON.parse(readFileSync(join(local.root, "runs", id, "run.json"), "utf8"));
    assert.equal(record.status, "paused");
    assert.equal(typeof record.sealedSeq, "number");
    a.close();
    mkdirSync(join(local.root, "unused"), { recursive: true });
  });
});
