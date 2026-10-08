// browser_downloads on both providers: files into the host workspace, a manifest with SHA-256, dedupe across calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp as fs_cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DOWNLOADS_MANIFEST, fetchDownloads, recordingHandle, safeDownloadName } from "../dist/index.js";
import { browserbaseProvider } from "../dist/providers/browserbase.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";
import { CHROME, LOCAL_TELEMETRY, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = (name) => mkdtemp(path.join(process.env.TMPDIR || tmpdir(), name));
let keySeq = 0;
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });

async function browserbaseRig() {
  const fake = fakeBrowserbase();
  const provider = browserbaseProvider({ env: { BROWSERBASE_API_KEY: `dl-key-${(keySeq += 1)}` }, client: fake.sdk });
  const ref = await provider.create(spec("ar-dl-1-1"), new AbortController().signal);
  return { fake, provider, ref, workspace: await scratch("dl-workspace-") };
}
const manifestOf = async (workspace) => JSON.parse(await readFile(path.join(workspace, DOWNLOADS_MANIFEST), "utf8"));

test("browserbase downloads land in the workspace with their SHA-256; a second call fetches only what is new", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    fake.addDownload(ref.id, "report-1719265797164.pdf", "PDF-bytes-one");
    fake.addDownload(ref.id, "table-1719265797999.csv", "a,b\n1,2\n");
    const first = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.deepEqual(first.fetched.map((f) => [f.path, f.sizeBytes, f.sha256]), [
      ["downloads/report-1719265797164.pdf", 13, sha("PDF-bytes-one")],
      ["downloads/table-1719265797999.csv", 8, sha("a,b\n1,2\n")],
    ]);
    assert.equal(first.manifest, "downloads/manifest.json");
    assert.equal(await readFile(path.join(workspace, first.fetched[0].path), "utf8"), "PDF-bytes-one");
    assert.deepEqual((await manifestOf(workspace)).files.map((r) => [r.path, r.sha256, r.session]), first.fetched.map((f) => [f.path, f.sha256, ref.id]));

    const reads = () => fake.only("get").filter((c) => c.options.__binaryResponse).length;
    const readsAfterFirst = reads();
    fake.addDownload(ref.id, "later-1719265800000.txt", "late");
    const second = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.deepEqual(second.fetched.map((f) => f.path), ["downloads/later-1719265800000.txt"]);
    assert.deepEqual(second.already_fetched.map((f) => f.path), first.fetched.map((f) => f.path));
    assert.equal(reads() - readsAfterFirst, 1, "files already held are not read again");
    assert.equal((await manifestOf(workspace)).files.length, 3);
    const third = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.deepEqual([third.fetched.length, third.already_fetched.length], [0, 3]);
    assert.deepEqual((await readdir(path.join(workspace, "downloads"))).sort(), ["later-1719265800000.txt", "manifest.json", "report-1719265797164.pdf", "table-1719265797999.csv"], "no partial files are left");
    assert.equal(fake.only("get").filter((c) => c.path === "/v1/downloads").every((c) => c.options.query.sessionId === ref.id), true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a deleted file is fetched again; a name taken by different bytes keeps both; hostile names stay inside downloads/", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    fake.addDownload(ref.id, "a.txt", "one");
    await fetchDownloads({ provider, ref, session: ref.id, workspace });
    await rm(path.join(workspace, "downloads", "a.txt"));
    assert.equal((await fetchDownloads({ provider, ref, session: ref.id, workspace })).fetched.length, 1, "a manifest row without its file is not a download held");
    await writeFile(path.join(workspace, "downloads", "b.txt"), "someone else's bytes");
    fake.addDownload(ref.id, "b.txt", "the session's bytes");
    fake.addDownload(ref.id, "../../escape.txt", "x");
    const out = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.equal(await readFile(path.join(workspace, "downloads", "b.txt"), "utf8"), "someone else's bytes");
    const kept = out.fetched.find((f) => f.name.startsWith("b-"));
    assert.equal(kept.name, `b-${sha("the session's bytes").slice(0, 8)}.txt`);
    assert.equal(await readFile(path.join(workspace, kept.path), "utf8"), "the session's bytes");
    assert.ok(out.fetched.some((f) => f.path === "downloads/escape.txt"));
    assert.equal(existsSync(path.join(workspace, "..", "escape.txt")), false);
    assert.equal(safeDownloadName("../x/.hidden"), "hidden");
    assert.equal(safeDownloadName("manifest.json"), "download");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a file over the limit is skipped with its reason and the others still land; a symlinked downloads/ is refused", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    fake.addDownload(ref.id, "big.bin", "x".repeat(100));
    fake.addDownload(ref.id, "small.txt", "ok");
    const out = await fetchDownloads({ provider, ref, session: ref.id, workspace, maxBytes: 50 });
    assert.deepEqual(out.fetched.map((f) => f.name), ["small.txt"]);
    assert.deepEqual(out.skipped, [{ name: "big.bin", reason: "larger than the 50-byte limit" }]);
    const hostile = await scratch("dl-hostile-");
    const target = await scratch("dl-elsewhere-");
    await symlink(target, path.join(hostile, "downloads"));
    await assert.rejects(fetchDownloads({ provider, ref, session: ref.id, workspace: hostile }), /not a directory/);
    assert.deepEqual(await readdir(target), [], "nothing was written through the link");
    await rm(hostile, { recursive: true, force: true }); await rm(target, { recursive: true, force: true });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a third name for the same file name keeps all three: no rename ever replaces a file holding other bytes", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    const squat = `b-${sha("three").slice(0, 8)}.txt`;
    await mkdir(path.join(workspace, "downloads"), { recursive: true });
    await writeFile(path.join(workspace, "downloads", "b.txt"), "someone else's bytes");
    await writeFile(path.join(workspace, "downloads", squat), "a squatter on the digest name");
    fake.addDownload(ref.id, "b.txt", "three");
    const out = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.equal(await readFile(path.join(workspace, "downloads", "b.txt"), "utf8"), "someone else's bytes");
    assert.equal(await readFile(path.join(workspace, "downloads", squat), "utf8"), "a squatter on the digest name", "the first digest name was taken by other bytes and is untouched");
    assert.equal(out.fetched[0].name, `b-${sha("three").slice(0, 16)}.txt`, "the newcomer takes a longer digest");
    assert.equal(await readFile(path.join(workspace, out.fetched[0].path), "utf8"), "three");
    assert.deepEqual((await readdir(path.join(workspace, "downloads"))).sort(), ["b.txt", squat, out.fetched[0].name, "manifest.json"].sort());
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("the per-call limit counts files this call fetches: files fetched before never starve the ones behind them", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    for (let i = 0; i < 5; i += 1) fake.addDownload(ref.id, `f${i}.txt`, `body ${i}`);
    const first = await fetchDownloads({ provider, ref, session: ref.id, workspace, maxFiles: 2 });
    assert.deepEqual([first.fetched.length, first.skipped.length], [2, 3]);
    const second = await fetchDownloads({ provider, ref, session: ref.id, workspace, maxFiles: 2 });
    assert.deepEqual([second.fetched.length, second.already_fetched.length, second.skipped.length], [2, 2, 1], "the next two are fetched, not skipped behind the two already held");
    const third = await fetchDownloads({ provider, ref, session: ref.id, workspace, maxFiles: 2 });
    assert.deepEqual([third.fetched.length, third.already_fetched.length, third.skipped.length], [1, 4, 0], "the last one arrives");
    assert.equal((await manifestOf(workspace)).files.length, 5);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("two sessions that fetch identical bytes into one workspace each keep their record", async () => {
  const a = await browserbaseRig(); const b = await browserbaseRig();
  try {
    a.fake.addDownload(a.ref.id, "report.pdf", "same bytes");
    b.fake.addDownload(b.ref.id, "report.pdf", "same bytes");
    await fetchDownloads({ provider: a.provider, ref: a.ref, session: "session-a", workspace: a.workspace });
    await fs_cp(a.workspace, b.workspace, { recursive: true });
    await fetchDownloads({ provider: b.provider, ref: b.ref, session: "session-b", workspace: b.workspace });
    const rows = (await manifestOf(b.workspace)).files;
    assert.deepEqual(rows.map((r) => [r.path, r.session]).sort(), [["downloads/report.pdf", "session-a"], ["downloads/report.pdf", "session-b"]], "both sessions' records survive");
    assert.deepEqual((await readdir(path.join(b.workspace, "downloads"))).sort(), ["manifest.json", "report.pdf"]);
    // A later call by session A still finds its own row: nothing is fetched again.
    const again = await fetchDownloads({ provider: a.provider, ref: a.ref, session: "session-a", workspace: b.workspace });
    assert.deepEqual([again.fetched.length, again.already_fetched.length], [0, 1]);
  } finally { await rm(a.workspace, { recursive: true, force: true }); await rm(b.workspace, { recursive: true, force: true }); }
});

test("concurrent fetches into one workspace lose no record", async () => {
  const workspace = await scratch("dl-workspace-");
  const rigs = await Promise.all([1, 2, 3, 4].map(() => browserbaseRig()));
  try {
    rigs.forEach((r, i) => { r.fake.addDownload(r.ref.id, `c${i}.txt`, `concurrent ${i}`); r.fake.addDownload(r.ref.id, `d${i}.txt`, `concurrent d ${i}`); });
    await Promise.all(rigs.map((r, i) => fetchDownloads({ provider: r.provider, ref: r.ref, session: `s${i}`, workspace })));
    const rows = (await manifestOf(workspace)).files;
    assert.equal(rows.length, 8, "every call's rows are in the manifest");
    assert.deepEqual((await readdir(path.join(workspace, "downloads"))).sort(), [...rows.map((r) => r.name), "manifest.json"].sort(), "and no lock or temporary file is left");
  } finally { for (const r of rigs) await rm(r.workspace, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test("concurrent calls fetching different bytes under one name keep both files, and every manifest row matches the file it names", async () => {
  for (let round = 0; round < 12; round += 1) {
    const workspace = await scratch("dl-workspace-");
    const rigs = await Promise.all([1, 2, 3].map(() => browserbaseRig()));
    try {
      rigs.forEach((r, i) => r.fake.addDownload(r.ref.id, "report.pdf", `different bytes ${round} ${i}`));
      await Promise.all(rigs.map((r, i) => fetchDownloads({ provider: r.provider, ref: r.ref, session: `s${i}`, workspace })));
      const rows = (await manifestOf(workspace)).files;
      assert.equal(rows.length, 3, `round ${round}: three fetches, three records`);
      assert.equal(new Set(rows.map((r) => r.path)).size, 3, "three distinct files: none replaced another");
      for (const row of rows) assert.equal(sha(await readFile(path.join(workspace, row.path))), row.sha256, "the row's hash is the surviving file's");
    } finally { for (const r of rigs) await rm(r.workspace, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
  }
});

test("a download named like the lock or the manifest's temporary file blocks nothing", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    fake.addDownload(ref.id, "manifest.json.lock", "a file called that");
    fake.addDownload(ref.id, ".downloads.lock", "and a dotted one");
    const started = Date.now();
    const out = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.ok(Date.now() - started < 5_000, "no wait on a lock a download occupies");
    assert.deepEqual(out.fetched.map((f) => f.name).sort(), ["downloads.lock", "manifest.json.lock"], "both are files in downloads/ (the leading dot is stripped)");
    assert.equal((await manifestOf(workspace)).files.length, 2);
    assert.deepEqual((await readdir(workspace)).filter((n) => n.startsWith(".")), [], "no lock or temporary file is left in the workspace");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("two remote files that trim to one local name keep a record each", async () => {
  const { fake, provider, ref, workspace } = await browserbaseRig();
  try {
    fake.addDownload(ref.id, "a.txt", "identical");
    fake.addDownload(ref.id, " a.txt", "identical");
    const first = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.equal(first.fetched.length, 2);
    const rows = (await manifestOf(workspace)).files;
    assert.deepEqual(rows.map((r) => [r.path, r.remote.name]).sort(), [["downloads/a.txt", " a.txt"], ["downloads/a.txt", "a.txt"]], "one row per remote file");
    const again = await fetchDownloads({ provider, ref, session: ref.id, workspace });
    assert.deepEqual([again.fetched.length, again.already_fetched.length], [0, 2], "neither is read again");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a provider without the capability has no downloads, and the recording handle is session:<id>", async () => {
  assert.equal(cdpProvider({ endpoint: "http://127.0.0.1:1" }).downloads, undefined);
  assert.equal(typeof cdpProvider({ chrome: { executablePath: "x", profileRoot: "y" } }).downloads.list, "function");
  assert.equal(recordingHandle("sess_9"), "session:sess_9");
  const local = cdpProvider({ chrome: { executablePath: "x", profileRoot: "/nonexistent-root" } });
  await assert.rejects(local.downloads.list({ id: "local:1:1", tag: "../elsewhere" }), /one path segment/, "a ref's tag never reaches outside the profile root");
  await assert.rejects(local.downloads.read({ id: "local:1:1", tag: "a/b" }, "f", 10), /one path segment/);
});

test("a real Chrome downloads a file; the cdp provider lists it once finished, and it lands in the workspace with its SHA-256, once", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
  const server = http.createServer((req, res) => {
    if (req.url === "/file.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="fixture.bin"' }); return res.end(payload); }
    res.setHeader("content-type", "text/html"); res.end('<title>Downloads</title><a id="d" href="/file.bin">get</a>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await scratch("cdp-dl-");
  const workspace = await scratch("dl-workspace-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  let ref; let stagehand;
  try {
    ref = await provider.create(spec("cdp-dl-1"), new AbortController().signal);
    assert.deepEqual(await provider.downloads.list(ref), [], "nothing downloaded yet");
    let browser;
    try {
      browser = await localBrowser.connect({ cdpUrl: (await provider.attach(ref)).sdkCdpUrl });
      stagehand = await Stagehand.create({ browser, logging: { level: "off" }, telemetry: LOCAL_TELEMETRY });
    } catch (error) { if (skipIncapable(t, error)) return; throw error; }
    const [page] = await browser.context.pages();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => document.getElementById("d").click());
    let listed = [];
    for (const deadline = Date.now() + 20_000; !listed.length && Date.now() < deadline; ) { listed = await provider.downloads.list(ref); if (!listed.length) await new Promise((r) => setTimeout(r, 200)); }
    assert.deepEqual(listed.map((f) => [f.name, f.sizeBytes]), [["fixture.bin", payload.length]], "the finished file, never a .crdownload");
    const first = await fetchDownloads({ provider, ref, session: "local", workspace });
    assert.deepEqual(first.fetched.map((f) => [f.path, f.sizeBytes, f.sha256]), [["downloads/fixture.bin", payload.length, sha(payload)]]);
    assert.deepEqual(await readFile(path.join(workspace, "downloads", "fixture.bin")), payload);
    assert.equal((await manifestOf(workspace)).files[0].sha256, sha(payload));
    const again = await fetchDownloads({ provider, ref, session: "local", workspace });
    assert.deepEqual([again.fetched.length, again.already_fetched.length], [0, 1]);
  } finally {
    await stagehand?.close().catch(() => undefined);
    if (ref) await provider.release(ref);
    server.close();
    await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  }
});
