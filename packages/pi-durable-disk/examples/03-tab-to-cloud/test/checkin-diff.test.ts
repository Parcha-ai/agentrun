// The page's side of a check-in: what changed in the workspace while the run was checked out, as the changes the server applies, and the request that carries them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baselineOf, CheckinError, diffWorkspace, postCheckin, type Snapshot } from "../tab/checkin.ts";
import { sha256Hex, toBase64 } from "../wire.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const snap = (entries: Record<string, string | null>): Snapshot => new Map(Object.entries(entries).map(([p, v]) => [p, v === null ? { kind: "directory" as const } : { kind: "file" as const, data: enc(v) }]));

describe("what the workspace changed while the run was checked out", () => {
  it("is nothing when nothing changed, and a file's whole content, a new directory, and a removal otherwise", async () => {
    const before = snap({ notes: null, "notes/a.txt": "one", "keep.txt": "same", "old.txt": "gone soon", "dir": null, "dir/inner.txt": "x" });
    const baseline = await baselineOf(before);
    assert.deepEqual(await diffWorkspace(baseline, before), []);
    const now = snap({ notes: null, "notes/a.txt": "one, edited", "keep.txt": "same", "fresh": null, "fresh/b.txt": "born offline", "top.txt": "new" });
    const changes = await diffWorkspace(baseline, now);
    assert.deepEqual(changes.filter((c) => c.op === "delete").map((c) => c.path), ["dir/inner.txt", "old.txt", "dir"].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1)), "removals: children before their directory");
    assert.deepEqual(changes.filter((c) => c.op === "mkdir").map((c) => c.path), ["fresh"]);
    const writes = changes.filter((c) => c.op === "write") as { path: string; data: string }[];
    assert.deepEqual(writes.map((c) => c.path).sort(), ["fresh/b.txt", "notes/a.txt", "top.txt"]);
    assert.equal(Buffer.from(writes.find((c) => c.path === "notes/a.txt")!.data, "base64").toString(), "one, edited");
    assert.ok(!changes.some((c) => c.path === "keep.txt"), "an unchanged file is not sent");
    assert.ok(changes.findIndex((c) => c.path === "fresh") < changes.findIndex((c) => c.path === "fresh/b.txt"), "a new directory before what is in it");
  });

  it("sees a file that became empty, and a file that became a directory", async () => {
    const baseline = await baselineOf(snap({ "a.txt": "text", x: "file" }));
    const changes = await diffWorkspace(baseline, snap({ "a.txt": "", x: null }));
    assert.deepEqual(changes.find((c) => c.path === "a.txt"), { path: "a.txt", op: "write", data: "" });
    assert.deepEqual(changes.find((c) => c.path === "x"), { path: "x", op: "mkdir" });
  });

  it("the baseline records each file's size and SHA-256 and each directory", async () => {
    const baseline = await baselineOf(snap({ d: null, "d/f": "hello" }));
    assert.deepEqual(baseline, { d: { kind: "directory" }, "d/f": { kind: "file", size: 5, sha256: await sha256Hex(enc("hello")) } });
  });
});

describe("the check-in request", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const o = { run: "r1", secret: "s3cret", tab: "tab-1", store: enc("sqlite bytes"), changes: [] as never[] };

  it("posts the tab, the store and the changes to the run's check-in route with the run's secret, and answers the head the server holds", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const done = await postCheckin({ ...o, fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ head: 9, files: 2 })); }) as unknown as typeof fetch });
    assert.deepEqual(done, { head: 9, files: 2 });
    assert.equal(seen!.url, "/api/runs/r1/checkin");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer s3cret");
    assert.deepEqual(JSON.parse(seen!.init.body as string), { tab: "tab-1", store: toBase64(o.store), changes: [] });
  });

  it("a refusal keeps the server's code and message; a server that is not reached is NETWORK", async () => {
    await assert.rejects(postCheckin({ ...o, fetch: reply(409, { error: "the store on disk is at 6, released 4", code: "CHECKIN_DIVERGED" }) }), (e: CheckinError) => e.code === "CHECKIN_DIVERGED" && /released 4/.test(e.message) && e.status === 409);
    await assert.rejects(postCheckin({ ...o, fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch }), (e: CheckinError) => e.code === "NETWORK");
    await assert.rejects(postCheckin({ ...o, fetch: reply(200, {}) }), (e: CheckinError) => e.code === "BAD_REPLY");
  });
});
