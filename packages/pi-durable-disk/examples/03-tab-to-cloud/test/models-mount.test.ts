// The local brain's files under /models/ on the tab's own origin (serve.ts --models-dir): served whole, with their length and the page's isolation headers, so
// the page (?phone=1, or the laptop's page taken offline) can fetch them into OPFS; and nothing outside the directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { localServer } from "./_local.ts";

describe("the robot model's files mounted under /models/", () => {
  const parent = mkdtempSync(join(tmpdir(), "models-"));
  const models = join(parent, "models");
  const sibling = join(parent, "models-secret"); // shares the prefix of the models' directory
  const part = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
  let local: Awaited<ReturnType<typeof localServer>>;
  let base: string;
  before(async () => {
    mkdirSync(models, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(models, "robot-v5-00001-of-00002.gguf"), part);
    writeFileSync(join(models, "robot-v5.parts.json"), JSON.stringify({ parts: [] }));
    writeFileSync(join(models, "robot-v5.state.bin"), new Uint8Array(64));
    writeFileSync(join(sibling, "secret.txt"), "not for the page");
    local = await localServer({ staticRoots: { "/models/": models } });
    base = local.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves a part whole with its length and the page's isolation headers (cross-origin isolated pages may load it)", async () => {
    const r = await fetch(`${base}/models/robot-v5-00001-of-00002.gguf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), String(part.length), "a download knows its total");
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), part);
    for (const name of ["robot-v5.parts.json", "robot-v5.state.bin"]) assert.equal((await fetch(`${base}/models/${name}`)).status, 200, name);
    assert.equal((await fetch(`${base}/models/missing.gguf`)).status, 404);
  });

  it("does not leave the directory: dot segments, encoded ones, and a sibling that shares the prefix are 404", async () => {
    for (const path of ["/models/../models-secret/secret.txt", "/models/%2e%2e/models-secret/secret.txt", "/models/..%2fmodels-secret%2fsecret.txt"]) {
      const r = await fetch(`${base}${path}`);
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
      assert.doesNotMatch(await r.text(), /not for the page/);
    }
  });
});
