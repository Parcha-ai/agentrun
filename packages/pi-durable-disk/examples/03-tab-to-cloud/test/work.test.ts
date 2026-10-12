// The HTTP routes of a run's work/ and of adoption: reading a file through the pipe or from the disk, writing one for
// the tab that holds the run (only at the allowed paths, after the barrier), and taking on a run released elsewhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PipeClient } from "../tab/pipe-client.ts";
import { toBase64 } from "../wire.ts";
import { localServer } from "./_local.ts";

const text = (s: string) => toBase64(new TextEncoder().encode(s));

describe("a run's work/ over HTTP", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  let barriers = 0;
  before(async () => {
    local = await localServer({
      tabWritable: ["designs.sqlite", "creature/body.json"],
      adminToken: "admin-test-token",
      hooks: { barrier: async () => void barriers++ },
      // The disk's S3 view of a parked run: here, the local directory the claims use.
      readObject: async (key) => new Uint8Array(readFileSync(join(local.root, key))),
    });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  });
  after(() => local.remove());

  const get = (id: string, path: string, secret: string) => fetch(`${base}/api/runs/${id}/work/${path}`, { headers: { authorization: `Bearer ${secret}` } });
  const put = (id: string, path: string, secret: string, tab: string, body: string) =>
    fetch(`${base}/api/runs/${id}/work/${path}`, { method: "PUT", headers: { authorization: `Bearer ${secret}`, "x-pda-tab": tab }, body });

  it("reads a file through the pipe, and from the disk once no pipe holds the run", async () => {
    const { id, secret } = await local.server.createRun("work-read");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    await a.syncFiles([{ path: "notes/a.txt", op: "write", data: text("from the tab\n") }]);
    const through = await get(id, "notes/a.txt", secret);
    assert.equal(through.status, 200);
    assert.equal(await through.text(), "from the tab\n");
    assert.equal((await get(id, "notes/missing.txt", secret)).status, 404);
    assert.equal((await get(id, "notes/a.txt", "wrong")).status, 404);
    for (const bad of ["../run.json", "notes/../../x", "/etc/passwd", "notes//a.txt"]) assert.equal((await get(id, encodeURIComponent(bad), secret)).status, 400, bad);
    a.close();
    const state = local.server.runs.get(id)!;
    for (let i = 0; i < 100 && state.pipe; i++) await new Promise((r) => setTimeout(r, 50));
    // Released: the disk's copy.
    const parked = await get(id, "notes/a.txt", secret);
    assert.equal(parked.status, 200);
    assert.equal(await parked.text(), "from the tab\n");
  });

  it("writes for the tab that holds the run, at the allowed paths only, after the barrier", async () => {
    const { id, secret } = await local.server.createRun("work-write");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const before = barriers;
    const ok = await put(id, "creature/body.json", secret, "a", '{"legs":4}');
    assert.equal(ok.status, 200);
    assert.ok(barriers > before);
    assert.equal(readFileSync(join(local.root, "runs", id, "work", "creature", "body.json"), "utf8"), '{"legs":4}');
    assert.equal(await (await get(id, "creature/body.json", secret)).text(), '{"legs":4}');
    // Not an allowed path, a path out of work/, another tab, the wrong secret.
    assert.equal((await put(id, "memory.sqlite", secret, "a", "x")).status, 403);
    assert.equal((await put(id, encodeURIComponent("../designs.sqlite"), secret, "a", "x")).status, 400);
    const other = await put(id, "designs.sqlite", secret, "b", "x");
    assert.equal(other.status, 409);
    assert.deepEqual(await other.json(), { error: "this tab does not hold the run", holder: "tab a" });
    assert.equal((await put(id, "designs.sqlite", "wrong", "a", "x")).status, 404);
    a.close();
  });

  it("adopts a run released elsewhere, with the admin token, and a page runs it from the link", async () => {
    // Another server on the same disk runs a run, writes a file and releases it, sealed.
    const other = await localServer({ root: local.root });
    const made = await other.server.createRun("elsewhere");
    const a = new PipeClient({ url: other.url, run: made.id, token: made.secret, tab: "a", mode: "write" });
    await a.ready;
    await a.syncFiles([{ path: "kept.txt", op: "write", data: text("kept\n") }]);
    a.close();
    await other.remove();
    const refused = await fetch(`${base}/api/runs/elsewhere/attach`, { method: "POST", headers: { authorization: "Bearer nope" } });
    assert.equal(refused.status, 404);
    const res = await fetch(`${base}/api/runs/elsewhere/attach`, { method: "POST", headers: { authorization: "Bearer admin-test-token" } });
    assert.equal(res.status, 200);
    const { run, link } = (await res.json()) as { run: string; link: string };
    assert.equal(run, "elsewhere");
    assert.match(link, /^\/run\/elsewhere#/);
    const secret = link.split("#")[1]!;
    const b = new PipeClient({ url: local.url, run, token: secret, tab: "b", mode: "write" });
    const attached = await b.ready;
    assert.ok(attached.t === "attached");
    assert.deepEqual(attached.files.map((f) => f.path), ["kept.txt"]);
    b.close();
    const missing = await fetch(`${base}/api/runs/nowhere/attach`, { method: "POST", headers: { authorization: "Bearer admin-test-token" } });
    assert.equal(missing.status, 409);
  });
});
