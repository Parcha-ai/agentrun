// The stage's files under /show/ on the tab's own origin: served with the page's isolation headers, guarded against leaving the directory (a sibling directory sharing the prefix included), and the
// list a checkout caches (stageFiles) refuses anything that is not under /show/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stageFiles } from "../tab/offline-cache.ts";
import { localServer } from "./_local.ts";

describe("the stage mounted under /show/", () => {
  const parent = mkdtempSync(join(tmpdir(), "show-"));
  const show = join(parent, "stage");
  const sibling = join(parent, "stage-secret"); // shares the prefix of the stage's directory
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  before(async () => {
    mkdirSync(show, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(show, "index.html"), "<h1>stage</h1>");
    writeFileSync(join(show, "main.js"), "console.log(1)");
    writeFileSync(join(sibling, "secret.txt"), "not for the page");
    local = await localServer({ staticRoots: { "/show/": show } });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves the stage's files and its index at /show/, with the page's isolation headers and no cache", async () => {
    for (const path of ["/show/", "/show/index.html", "/show/main.js"]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(await (await fetch(`${base}/show/`)).text(), "<h1>stage</h1>");
    assert.equal((await fetch(`${base}/show/missing.js`)).status, 404);
  });

  it("does not leave the directory: dot segments, encoded ones, and a sibling that shares the prefix are 404", async () => {
    for (const path of ["/show/../stage-secret/secret.txt", "/show/%2e%2e/stage-secret/secret.txt", "/show/..%2fstage-secret%2fsecret.txt", "/show/../../etc/passwd"]) {
      const r = await fetch(`${base}${path}`);
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
      assert.doesNotMatch(await r.text(), /not for the page/);
    }
    const raw = await new Promise<number>((resolve) => {
      import("node:net").then(({ connect }) => {
        const url = new URL(base);
        const s = connect(Number(url.port), url.hostname, () => s.write("GET /show/../stage-secret/secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        let data = "";
        s.on("data", (d) => (data += d));
        s.on("close", () => resolve(/^HTTP\/1\.1 (\d+)/.exec(data) ? Number(/^HTTP\/1\.1 (\d+)/.exec(data)![1]) : 0));
      });
    });
    assert.ok(raw === 404 || raw === 400, `raw dot segments -> ${raw}`);
  });
});

describe("the list of the stage's files a checkout caches", () => {
  const list = (status: number, body?: unknown) => () => Promise.resolve(new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status }));
  it("is nothing when no stage is served, and the listed paths when one is (deduplicated)", async () => {
    assert.deepEqual(await stageFiles(list(404)), []);
    assert.deepEqual(await stageFiles(list(200, { files: ["/show/", "/show/main.js", "/show/main.js", "/show/img/a.png"] })), ["/show/", "/show/main.js", "/show/img/a.png"]);
  });
  it("refuses a list that names anything outside /show/, with a query, a fragment, dot segments or backslashes, or that is not a list", async () => {
    for (const bad of ["/run/x", "/api/runs/x/work/secret", "/show/../run/x", "/show/./a", "/show/a?x=1", "/show/a#b", "/show//x", "/show/a\\\\b", "https://evil.example/show/x", "show/x", 5]) {
      await assert.rejects(stageFiles(list(200, { files: ["/show/ok.js", bad] })), /only paths under \/show\//, String(bad));
    }
    await assert.rejects(stageFiles(list(200, "not json")), /not \{files/);
    await assert.rejects(stageFiles(list(200, { files: "x" })), /not \{files/);
    await assert.rejects(stageFiles(list(500)), /500/);
  });
});
