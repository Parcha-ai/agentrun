// The other half of a checkout: the browser's store and the files it wrote come back (POST /api/runs/<id>/checkin). The pipe checks that the store EXTENDS the head the checkout released, puts store and
// files on the disk and removes the mark last; anything that does not extend it is CHECKIN_DIVERGED and changes nothing; a crash after the check leaves the mark, so no fork and a retry works.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { PipeClient, remoteStorage } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";
import { cloudProvider } from "./_brain.ts";

const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("checking a run back in", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  let crashOnce = false;
  const scratch = mkdtempSync(join(tmpdir(), "checkin-test-"));
  before(async () => {
    local = await localServer({
      checkinGraceMs: 400,
      beforeCheckinMarkerRemoval: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error("the server crashed here");
        }
      },
    });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
    rmSync(scratch, { recursive: true, force: true });
  });

  const authed = (secret: string, tab?: string) => ({ authorization: `Bearer ${secret}`, ...(tab ? { "x-pda-tab": tab } : {}) });
  const copyOf = async (id: string, secret: string) => {
    const r = await fetch(`${base}/api/runs/${id}/store`, { headers: authed(secret) });
    return { bytes: Buffer.from(await r.arrayBuffer()), head: Number(r.headers.get("x-store-head")) };
  };
  const checkoutOf = (id: string, secret: string, tab: string, head: number) => fetch(`${base}/api/runs/${id}/checkout`, { method: "POST", headers: authed(secret, tab), body: JSON.stringify({ head }) });
  const checkin = (id: string, secret: string, tab: string, store: Uint8Array, changes: unknown[] = []) =>
    fetch(`${base}/api/runs/${id}/checkin`, { method: "POST", headers: authed(secret, tab), body: JSON.stringify({ tab, store: Buffer.from(store).toString("base64"), changes }) });

  /** A tab that holds a new run with a conversation and `commits` entries through pi's Harness over the pipe. */
  async function writer(name: string, commits = 3) {
    const { id, secret } = await local.server.createRun(name);
    const client = new PipeClient({ url: local.url, run: id, token: secret, tab: `tab-${name}`, mode: "write" });
    await client.ready;
    const models = createModels();
    models.setProvider(cloudProvider());
    const harness = await Harness.open(remoteStorage(client), { models, registry: createRegistry() }, ctx);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "pipe", modelId: "cloud-big" }, thinkingLevel: "off", instructions: null, extensions: [] } }, ctx);
    for (let n = 0; n < commits; n++) await conversation.submit({ type: "write", requestId: `n-${n}`, entry: { kind: "note", data: { n } } }, ctx);
    return { id, secret, client, conversation, tab: `tab-${name}` };
  }

  /** What the browser does while it holds the run: opens its copy and commits more to the SAME conversation. Returns the store's bytes. */
  async function offline(copy: Buffer, conversationId: unknown, more: number): Promise<Buffer> {
    const file = join(scratch, `b-${Math.random().toString(36).slice(2)}.sqlite`);
    writeFileSync(file, copy);
    const storage = await openNodeSqliteStorage(file);
    const models = createModels();
    models.setProvider(cloudProvider());
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, ctx);
    const c = await harness.conversation(conversationId as never, ctx);
    for (let n = 0; n < more; n++) await c!.submit({ type: "write", requestId: `off-${n}`, entry: { kind: "note", data: { offline: n } } }, ctx);
    await harness.close(ctx);
    return readFileSync(file);
  }

  async function checkedOut(name: string, commits = 3) {
    const w = await writer(name, commits);
    const copy = await copyOf(w.id, w.secret);
    assert.equal((await checkoutOf(w.id, w.secret, w.tab, copy.head)).status, 200);
    return { ...w, copy };
  }
  const headOf = (bytes: Buffer | string) => {
    const file = typeof bytes === "string" ? bytes : (() => { const f = join(scratch, `h-${Math.random().toString(36).slice(2)}.sqlite`); writeFileSync(f, bytes); return f; })();
    const db = new DatabaseSync(file, { readOnly: true });
    try { return (db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number }).next_seq - 1; } finally { db.close(); }
  };
  const runStore = (id: string) => join(local.root, "runs", id, "store", "run.sqlite");
  const marker = (id: string) => join(local.root, "runs", id, "store", "checkout.json");

  it("takes the store and the files back, removes the mark last, and the tab attaches as the writer and sees both", async () => {
    const w = await checkedOut("happy");
    const store = await offline(w.copy.bytes, w.conversation.id, 2);
    const res = await checkin(w.id, w.secret, w.tab, store, [{ path: "notes", op: "mkdir" }, { path: "notes/offline.txt", op: "write", data: b64("made offline\n") }]);
    assert.equal(res.status, 200, await res.clone().text());
    const done = (await res.json()) as { head: number; files: number };
    assert.equal(done.head, headOf(store));
    assert.equal(done.files, 2);
    assert.equal(existsSync(marker(w.id)), false, "the mark is gone");
    assert.equal(readFileSync(join(local.root, "runs", w.id, "work", "notes", "offline.txt"), "utf8"), "made offline\n", "the file is on the disk");
    const state = local.server.runs.get(w.id)!;
    assert.equal(state.checkedOut, undefined);
    assert.equal(state.placement.where, "parked");
    // the tab attaches as the writer: it sees the offline entries and the offline file
    const client = new PipeClient({ url: local.url, run: w.id, token: w.secret, tab: w.tab, mode: "write" });
    const attached = (await client.ready) as { t: string; files: { path: string }[] };
    assert.equal(attached.t, "attached");
    assert.ok(attached.files.some((f) => f.path === "notes/offline.txt"), "the restore has the file written offline");
    const models = createModels();
    models.setProvider(cloudProvider());
    const harness = await Harness.open(remoteStorage(client), { models, registry: createRegistry() }, ctx);
    const c = await harness.conversation(w.conversation.id, ctx);
    const kinds = ((await c!.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; data?: { offline?: number } }[]).filter((e) => e.kind === "note");
    assert.equal(kinds.filter((e) => e.data?.offline !== undefined).length, 2, "the entries written offline are in the conversation");
    assert.equal(kinds.length, 5, "and the ones from before");
    await harness.close(ctx).catch(() => undefined);
    client.close();
    for (let i = 0; i < 100 && local.server.runs.get(w.id)!.pipe; i++) await new Promise((r) => setTimeout(r, 100)); // the writer is gone: the claim is let go, and the store can be read
    assert.equal(headOf(runStore(w.id)) >= headOf(store), true, "the run's own store is the browser's (and what the tab committed since)");
  });

  it("a store that does not extend the released head is CHECKIN_DIVERGED and nothing at all changes", async () => {
    const w = await checkedOut("diverged");
    const before = { store: sha(readFileSync(runStore(w.id))), marker: readFileSync(marker(w.id), "utf8") };
    const refuse = async (store: Buffer, why: RegExp, table: string) => {
      const res = await checkin(w.id, w.secret, w.tab, store, [{ path: "must-not-appear.txt", op: "write", data: b64("x") }]);
      assert.equal(res.status, 409, await res.clone().text());
      const body = (await res.json()) as { code: string; table?: string; error: string };
      assert.equal(body.code, "CHECKIN_DIVERGED");
      assert.equal(body.table, table);
      assert.match(body.error, why);
      assert.equal(sha(readFileSync(runStore(w.id))), before.store, "the run's store is the bytes it was");
      assert.equal(readFileSync(marker(w.id), "utf8"), before.marker, "the mark is still there");
      assert.equal(existsSync(join(local.root, "runs", w.id, "work", "must-not-appear.txt")), false, "no file was written");
      assert.equal(local.server.runs.get(w.id)!.pipe, undefined, "the claim was let go");
      assert.ok(local.server.runs.get(w.id)!.checkedOut, "still checked out");
    };
    // a released entry rewritten
    const tampered = await offline(w.copy.bytes, w.conversation.id, 1);
    const tf = join(scratch, "tampered.sqlite");
    writeFileSync(tf, tampered);
    const db = new DatabaseSync(tf);
    db.exec("UPDATE entries SET record = replace(record, 'note', 'nope') WHERE id = (SELECT min(id) FROM entries WHERE record LIKE '%note%')");
    db.close();
    await refuse(readFileSync(tf), /entries/, "entries");
    // a store from before the last commit (behind the released head)
    const behind = (await writer("behind-src", 1)).id;
    void behind;
    const older = await (async () => { const r = await copyOf(w.id, w.secret).catch(() => undefined); return r; })();
    void older;
    const small = await offline(w.copy.bytes, w.conversation.id, 0);
    const smallFile = join(scratch, "behind.sqlite");
    writeFileSync(smallFile, small);
    const bdb = new DatabaseSync(smallFile);
    bdb.exec("DELETE FROM entries WHERE commit_seq = (SELECT max(commit_seq) FROM entries)");
    bdb.exec("UPDATE durable_metadata SET next_seq = next_seq - 1");
    bdb.close();
    await refuse(readFileSync(smallFile), /behind|entries/, "durable_metadata");
    // a new entry that claims a sequence inside the released prefix
    const forged = join(scratch, "forged.sqlite");
    writeFileSync(forged, await offline(w.copy.bytes, w.conversation.id, 1));
    const fdb = new DatabaseSync(forged);
    fdb.exec("UPDATE entries SET commit_seq = 1 WHERE id = (SELECT max(id) FROM entries)");
    fdb.close();
    await refuse(readFileSync(forged), /past the released head/, "entries");
    // and an honest check-in still works afterwards
    const good = await checkin(w.id, w.secret, w.tab, await offline(w.copy.bytes, w.conversation.id, 1));
    assert.equal(good.status, 200);
  });

  it("a crash after the check and before the mark is removed leaves the mark: no fork, and the same check-in sent again works", async () => {
    const w = await checkedOut("crash");
    const store = await offline(w.copy.bytes, w.conversation.id, 2);
    crashOnce = true;
    const first = await checkin(w.id, w.secret, w.tab, store, [{ path: "a.txt", op: "write", data: b64("a") }]);
    assert.equal(first.status, 500);
    assert.equal(existsSync(marker(w.id)), true, "the mark is still there");
    for (let i = 0; i < 50 && local.server.runs.get(w.id)!.pipe; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(headOf(runStore(w.id)), headOf(store), "the store was already in place");
    assert.ok(local.server.runs.get(w.id)!.checkedOut, "still checked out");
    const attach = new PipeClient({ url: local.url, run: w.id, token: w.secret, tab: "someone", mode: "write", takeover: true });
    await assert.rejects(attach.ready, (e: Error & { code?: string }) => e.code === "CHECKED_OUT" || /checked out/.test(e.message));
    assert.equal(local.server.runs.get(w.id)!.pipe, undefined, "no claim: nothing forked");
    // the server restarts; the mark is read from the disk and the run is still checked out
    const second = await localServer({ root: local.root });
    try {
      const adopted = await second.server.adoptRun(w.id);
      assert.equal(second.server.runs.get(w.id)!.placement.where, "checked-out");
      const again = new PipeClient({ url: second.url, run: w.id, token: adopted.secret, tab: "opens-the-link", mode: "write" });
      await assert.rejects(again.ready, (e: Error & { code?: string }) => e.code === "CHECKED_OUT" || /checked out/.test(e.message));
    } finally {
      await second.remove();
    }
    const retry = await checkin(w.id, w.secret, w.tab, store, [{ path: "a.txt", op: "write", data: b64("a") }]);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal(existsSync(marker(w.id)), false);
    assert.equal(readFileSync(join(local.root, "runs", w.id, "work", "a.txt"), "utf8"), "a");
  });

  it("after a check-in a restarted server finds a plain run: the mark is gone, the tab attaches and sees the extended store", async () => {
    const w = await checkedOut("restart");
    const store = await offline(w.copy.bytes, w.conversation.id, 1);
    assert.equal((await checkin(w.id, w.secret, w.tab, store)).status, 200);
    // nobody attaches in time: the claim is let go (the grace is 400 ms here)
    for (let i = 0; i < 60 && local.server.runs.get(w.id)!.pipe; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(local.server.runs.get(w.id)!.pipe, undefined, "the claim was released when no tab attached");
    const second = await localServer({ root: local.root });
    try {
      const adopted = await second.server.adoptRun(w.id);
      assert.equal(second.server.runs.get(w.id)!.checkedOut, undefined);
      const client = new PipeClient({ url: second.url, run: w.id, token: adopted.secret, tab: "back", mode: "write" });
      assert.equal(((await client.ready) as { t: string }).t, "attached");
      client.close();
    } finally {
      await second.remove();
    }
    assert.equal(headOf(runStore(w.id)) >= headOf(store), true);
  });

  it("only a checked-out run can be checked in, with the secret", async () => {
    const w = await writer("not-out");
    const copy = await copyOf(w.id, w.secret);
    assert.equal((await checkin(w.id, w.secret, w.tab, copy.bytes)).status, 409, "not checked out");
    assert.equal((await checkin(w.id, "wrong", w.tab, copy.bytes)).status, 404);
    w.client.close();
  });
});
