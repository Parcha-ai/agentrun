// Checking a run out to a browser: a consistent copy of the run's store while the tab holds it (GET /api/runs/<id>/store), and the one-way handover
// (POST /api/runs/<id>/checkout): the claim is released only when the copy's head is the store's head, and nothing runs the run again afterwards.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { PipeClient, remoteStorage } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";
import { cloudProvider } from "./_brain.ts";

const headOf = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number }).next_seq - 1;
  } finally {
    db.close();
  }
};

describe("checking a run out to a browser", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  /** How long the disk's barrier takes: a write-through in flight holds the checkout's wait. */
  let barrierMs = 0;
  const scratch = mkdtempSync(join(tmpdir(), "checkout-test-"));
  before(async () => {
    local = await localServer({ hooks: { barrier: async () => void (barrierMs && (await new Promise((r) => setTimeout(r, barrierMs)))) } });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
    rmSync(scratch, { recursive: true, force: true });
  });

  const authed = (secret: string, tab?: string) => ({ authorization: `Bearer ${secret}`, ...(tab ? { "x-pda-tab": tab } : {}) });
  const copyOf = (id: string, secret: string) => fetch(`${base}/api/runs/${id}/store`, { headers: authed(secret) });
  const checkout = (id: string, secret: string, tab: string, head: unknown) => fetch(`${base}/api/runs/${id}/checkout`, { method: "POST", headers: authed(secret, tab), body: JSON.stringify({ head }) });

  /** A tab that holds a new run and has committed `commits` entries through pi's Harness over the pipe. */
  async function writer(name: string, commits = 3) {
    const { id, secret } = await local.server.createRun(name);
    const frames: PipeFrame[] = [];
    const client = new PipeClient({ url: local.url, run: id, token: secret, tab: `tab-${name}`, mode: "write", onFrame: (f) => frames.push(f) });
    await client.ready;
    const models = createModels();
    models.setProvider(cloudProvider());
    const harness = await Harness.open(remoteStorage(client), { models, registry: createRegistry() }, ctx);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "pipe", modelId: "cloud-big" }, thinkingLevel: "off", instructions: null, extensions: [] } }, ctx);
    const note = (n: number) => conversation.submit({ type: "write", requestId: `note-${n}`, entry: { kind: "note", data: { n } } }, ctx);
    for (let n = 0; n < commits; n++) await note(n);
    return { id, secret, client, frames, harness, conversation, note, tab: `tab-${name}` };
  }

  it("serves a consistent copy of the store while the tab holds the run, and removes its own file", async () => {
    const w = await writer("snap");
    const res = await copyOf(w.id, w.secret);
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const file = join(scratch, "snap.sqlite");
    writeFileSync(file, bytes);
    const head = Number(res.headers.get("x-store-head"));
    assert.ok(head >= 3, `head ${head}`);
    assert.equal(headOf(file), head, "the copy's own head is the header's");
    const tmp = join(local.root, "runs", w.id, "tmp");
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp).filter((f) => f.startsWith("snapshot-")) : [], [], "no snapshot file is left under the run's tmp/");
    // the writer commits on; a second copy has the later head
    await w.note(99);
    const again = await copyOf(w.id, w.secret);
    assert.ok(Number(again.headers.get("x-store-head")) > head);
    await again.arrayBuffer();
    w.client.close();
  });

  it("refuses a copy without the run's secret, and when no tab holds the run", async () => {
    const w = await writer("snap-auth", 1);
    assert.equal((await copyOf(w.id, "wrong")).status, 404);
    assert.equal((await copyOf("nowhere", w.secret)).status, 404);
    const { id, secret } = await local.server.createRun("snap-idle");
    assert.equal((await copyOf(id, secret)).status, 409, "a parked run has no store to copy");
    w.client.close();
  });

  it("a checkout whose copy is behind the store is refused, releases nothing, and the tab keeps running", async () => {
    const w = await writer("behind");
    const copy = await copyOf(w.id, w.secret);
    const head = Number(copy.headers.get("x-store-head"));
    await copy.arrayBuffer();
    await w.note(50); // the store moves on after the copy
    const refused = await checkout(w.id, w.secret, w.tab, head);
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { code: string; head: number };
    assert.equal(body.code, "HEAD_MISMATCH");
    assert.ok(body.head > head);
    assert.equal(local.server.runs.get(w.id)!.checkedOut, undefined, "not checked out");
    await w.note(51); // still the tab's: the commit goes through
    assert.equal(w.frames.some((f) => f.t === "lost"), false, "the tab was not told it lost the run");
    w.client.close();
  });

  it("only the tab that runs the run may check it out, with its secret", async () => {
    const w = await writer("who", 1);
    const head = Number((await copyOf(w.id, w.secret)).headers.get("x-store-head"));
    assert.equal((await checkout(w.id, w.secret, "some-other-tab", head)).status, 409);
    assert.equal((await checkout(w.id, "wrong", w.tab, head)).status, 404);
    assert.equal((await checkout(w.id, w.secret, w.tab, "x")).status, 400);
    assert.equal(local.server.runs.get(w.id)!.checkedOut, undefined);
    w.client.close();
  });

  it("a checkout with the matching head releases the claim, tells the tab, and nothing can run the run again", async () => {
    const w = await writer("out");
    const copy = await copyOf(w.id, w.secret);
    const head = Number(copy.headers.get("x-store-head"));
    await copy.arrayBuffer();
    const viewerFrames: PipeFrame[] = [];
    const viewer = new PipeClient({ url: local.url, run: w.id, token: w.secret, tab: "viewer", mode: "view", onFrame: (f) => viewerFrames.push(f) });
    await viewer.ready;

    const res = await checkout(w.id, w.secret, w.tab, head);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { head });
    const state = local.server.runs.get(w.id)!;
    assert.equal(state.checkedOut?.head, head);
    assert.equal(state.pipe, undefined, "the pipe's claim is released");
    assert.equal(state.placement.where, "checked-out");

    // the tab was told, by name
    for (let i = 0; i < 50 && !w.frames.some((f) => f.t === "lost"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(w.frames.filter((f) => f.t === "lost").map((f) => (f as { code: string }).code), ["CHECKED_OUT"]);
    // what a viewer sees
    assert.ok(viewerFrames.some((f) => f.t === "placement" && f.placement.where === "checked-out"), "viewers are told the run is checked out");

    // the released store's head is the head the copy had
    const released = join(local.root, "runs", w.id, "store", "run.sqlite");
    assert.equal(headOf(released), head);

    // no write attach, a typed refusal, and no claim taken
    const again = new PipeClient({ url: local.url, run: w.id, token: w.secret, tab: "second", mode: "write", takeover: true });
    await assert.rejects(again.ready, (e: Error & { code?: string }) => e.code === "CHECKED_OUT" || /checked out/.test(e.message));
    assert.equal(state.pipe, undefined, "the refused attach opened no pipe");
    // no copy, no second checkout, no move
    assert.equal((await copyOf(w.id, w.secret)).status, 409);
    assert.equal((await checkout(w.id, w.secret, w.tab, head)).status, 409);
    const refusedFrames: PipeFrame[] = [];
    const operator = new PipeClient({ url: local.url, run: w.id, token: w.secret, tab: "operator", mode: "operator", onFrame: (f) => refusedFrames.push(f) });
    await operator.ready;
    operator.send({ t: "switch", to: "tab" });
    operator.send({ t: "submit", text: "hello?", requestId: "r1" });
    for (let i = 0; i < 50 && refusedFrames.filter((f) => f.t === "switch-refused" || f.t === "submit-refused").length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(refusedFrames.some((f) => f.t === "switch-refused" && /checked out/.test(f.message)), "a move is refused");
    assert.ok(refusedFrames.some((f) => f.t === "submit-refused" && /checked out/.test(f.message)), "a message is refused");
    viewer.close();
    operator.close();
  });

  it("a storage call that reaches the pipe after the checkout began is refused, never committed, so the released store is the copy's", async () => {
    const w = await writer("late", 2);
    const copy = await copyOf(w.id, w.secret);
    const head = Number(copy.headers.get("x-store-head"));
    await copy.arrayBuffer();
    // A write-through in flight holds the checkout (the barrier takes a while); a commit sent meanwhile must not get into the store.
    barrierMs = 400;
    const inflight = w.client.syncFiles([{ path: "late.txt", op: "write", data: Buffer.from("x").toString("base64") }]).then(() => "synced", () => "refused");
    await new Promise((r) => setTimeout(r, 50));
    const done = checkout(w.id, w.secret, w.tab, head);
    await new Promise((r) => setTimeout(r, 100));
    const racing = await w.note(77).then(() => "committed", (e: Error) => e.message);
    barrierMs = 0;
    const res = await done;
    await inflight;
    assert.match(racing, /checked out|CHECKED_OUT/, "the commit was refused by name");
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(headOf(join(local.root, "runs", w.id, "store", "run.sqlite")), head, "nothing got into the store after the copy");
    w.client.close();
  });
});
