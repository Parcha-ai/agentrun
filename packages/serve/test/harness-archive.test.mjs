// The owner's install of an archive harness (harness-archive.ts: Goose, `agentrun harness install goose`), whole or not at
// all, as a first-use install is (harness-install.ts):
//   - the archive is downloaded and its sha256 checked against the pin before anything unpacks it;
//   - it is unpacked into a fresh folder beside the harness's own, the binary's sha256 checked there, and only then is the
//     folder renamed into place and made read-only;
//   - every failure is named by a code (a platform the pin has no binary for, a download that fails, an archive or a
//     binary that is not the pinned one) and says the command that tries again;
//   - a crash between the unpack and the rename leaves the fresh folder and never a half install, and the next install
//     removes it;
//   - a rerun with the pinned binary in place downloads nothing.
// The archive is a small fake one (system tar and bzip2 pack it here), served on loopback, its digests passed as the pin.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const { ARCHIVE_CODES, ArchiveInstallFailed, installArchive } = await import("../dist/harness-archive.js");

const PLATFORM = "linux-x86_64";
const RETRY = "agentrun harness install goose";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A fake release: a `goose` script packed as `./goose` in a .tar.bz2, with the archive's and the binary's sha256. */
async function fakeRelease(t, body = "#!/bin/sh\necho fake goose\n") {
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  writeFileSync(join(tree, "goose"), body);
  chmodSync(join(tree, "goose"), 0o755);
  const archive = join(dir, "goose.tar.bz2");
  const packed = spawnSync("tar", ["-cjf", archive, "-C", tree, "./goose"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  return { bytes, archiveSha: sha256(bytes), binarySha: sha256(Buffer.from(body)) };
}

/** The archive on loopback at `path` (any other path 404), each request counted. Its close destroys every socket. */
async function origin(t, bytes, path = "/goose.tar.bz2") {
  const sockets = new Set();
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    if (req.url !== path) return void res.writeHead(404).end("no such file");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) }).end(bytes);
  });
  server.on("connection", (socket) => (sockets.add(socket), socket.on("close", () => sockets.delete(socket))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  t.after(close);
  return { url, asked, close };
}

/** The harness an install is given: Goose under a pin of the fake release's digests (`over` replaces the platform's). */
const harnessOf = (url, release, over = {}) => ({
  id: "goose",
  label: "Goose",
  retry: RETRY,
  pin: { id: "goose", version: "1.59.2", archives: { [PLATFORM]: { url: `${url}/goose.tar.bz2`, format: "tar.bz2", sha256: release.archiveSha, cmd: "./goose", binarySha256: release.binarySha, ...over } } },
});

/** A data directory's harnesses folder, and Goose's folder in it. */
async function place(t) {
  const harnesses = join(await scratch(t), "harnesses");
  return { harnesses, dir: join(harnesses, "goose") };
}

/** What installs left beside the harness's folder (its fresh folders, the install it replaced). */
const leftovers = (harnesses) => (existsSync(harnesses) ? readdirSync(harnesses).filter((name) => name.startsWith(".goose-")) : []);

/** A rejection with code `code` whose message says the command that tries again. */
const failsWith = (code) => (error) => {
  assert.ok(error instanceof ArchiveInstallFailed, `${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  assert.ok(error.message.includes(RETRY), `the message says the command that tries again: ${error.message}`);
  return true;
};

test("the failure codes are named", () => {
  assert.deepEqual(ARCHIVE_CODES, {
    platform: "HARNESS_PLATFORM_UNSUPPORTED",
    download: "HARNESS_DOWNLOAD_FAILED",
    archive: "HARNESS_ARCHIVE_MISMATCH",
    unpack: "HARNESS_UNPACK_FAILED",
    binary: "HARNESS_BINARY_MISMATCH",
    busy: "HARNESS_INSTALL_BUSY",
  });
});

test("a good archive: downloaded once, checked, unpacked beside, renamed into place and read-only, with no folder left beside it", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  const steps = [];
  const done = await installArchive(harnessOf(served.url, release), dir, { platform: PLATFORM, onStep: (step) => void steps.push(step) });
  assert.deepEqual(done, { installed: "now", binary: join(dir, "goose") });
  assert.deepEqual(steps, ["downloaded", "unpacked", "verified"], "the archive is checked as it downloads, the binary once unpacked");
  assert.deepEqual(served.asked, ["/goose.tar.bz2"]);
  assert.equal(sha256(readFileSync(done.binary)), release.binarySha);
  assert.equal(statSync(done.binary).mode & 0o222, 0, "the binary is read-only");
  assert.ok(statSync(done.binary).mode & 0o100, "and its owner may run it");
  assert.equal(statSync(dir).mode & 0o222, 0, "its folder is read-only");
  assert.deepEqual(readdirSync(dir), ["goose"], "the folder holds what the archive unpacked, never the archive");
  assert.deepEqual(leftovers(harnesses), []);
});

test("a rerun with the pinned binary in place is a no-op: nothing is downloaded and nothing moves", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { dir } = await place(t);
  const harness = harnessOf(served.url, release);
  await installArchive(harness, dir, { platform: PLATFORM });
  const before = statSync(join(dir, "goose"));
  assert.deepEqual(await installArchive(harness, dir, { platform: PLATFORM }), { installed: "already", binary: join(dir, "goose") });
  assert.deepEqual(served.asked, ["/goose.tar.bz2"], "one download, the first install's");
  assert.equal(statSync(join(dir, "goose")).ino, before.ino, "the same file");
});

test("a binary in place that is not the pinned one is replaced whole by a rerun", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "goose"), "#!/bin/sh\necho another goose\n");
  writeFileSync(join(dir, "stray"), "left by hand");
  const done = await installArchive(harnessOf(served.url, release), dir, { platform: PLATFORM });
  assert.equal(done.installed, "now");
  assert.equal(sha256(readFileSync(done.binary)), release.binarySha);
  assert.deepEqual(readdirSync(dir), ["goose"], "the old folder went whole");
  assert.deepEqual(leftovers(harnesses), []);
});

test("an archive whose sha256 is not the pin's is refused before it is unpacked: HARNESS_ARCHIVE_MISMATCH, nothing in place", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  const steps = [];
  await assert.rejects(installArchive(harnessOf(served.url, release, { sha256: "0".repeat(64) }), dir, { platform: PLATFORM, onStep: (step) => void steps.push(step) }), failsWith("HARNESS_ARCHIVE_MISMATCH"));
  assert.deepEqual(steps, [], "never unpacked");
  assert.equal(existsSync(dir), false);
  assert.deepEqual(leftovers(harnesses), []);
});

test("a binary whose sha256 is not the pin's is refused before it is put in place: HARNESS_BINARY_MISMATCH, nothing in place", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  await assert.rejects(installArchive(harnessOf(served.url, release, { binarySha256: "1".repeat(64) }), dir, { platform: PLATFORM }), (error) => failsWith("HARNESS_BINARY_MISMATCH")(error) && error.message.includes(release.binarySha));
  assert.equal(existsSync(dir), false);
  assert.deepEqual(leftovers(harnesses), []);
});

test("a download that fails is HARNESS_DOWNLOAD_FAILED: a status other than 200, and an origin that is not there", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  await assert.rejects(installArchive(harnessOf(served.url, release, { url: `${served.url}/missing.tar.bz2` }), dir, { platform: PLATFORM }), (error) => failsWith("HARNESS_DOWNLOAD_FAILED")(error) && /404/.test(error.message));
  const gone = served.url;
  await served.close();
  await assert.rejects(installArchive(harnessOf(gone, release), dir, { platform: PLATFORM }), failsWith("HARNESS_DOWNLOAD_FAILED"));
  assert.equal(existsSync(dir), false);
  assert.deepEqual(leftovers(harnesses), []);
});

test("a platform the pin has no binary digest for is HARNESS_PLATFORM_UNSUPPORTED, before anything is downloaded", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { dir } = await place(t);
  await assert.rejects(installArchive(harnessOf(served.url, release), dir, { platform: "windows-x86_64" }), (error) => failsWith("HARNESS_PLATFORM_UNSUPPORTED")(error) && /windows-x86_64/.test(error.message));
  const unmeasured = harnessOf(served.url, release);
  delete unmeasured.pin.archives[PLATFORM].binarySha256;
  await assert.rejects(installArchive(unmeasured, dir, { platform: PLATFORM }), failsWith("HARNESS_PLATFORM_UNSUPPORTED"));
  assert.deepEqual(served.asked, []);
  assert.equal(existsSync(dir), false);
});

test("tar runs with a fixed argument list on the verified archive, and with no key of the server's in its environment", async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { dir } = await place(t);
  const bin = await scratch(t);
  const seen = join(bin, "seen.json");
  const tar = join(bin, "tar");
  // The stand-in writes what it was given to `seen`, named in its code; after "--", tar's arguments are no node options.
  writeFileSync(tar, `#!/bin/sh\nnode -e 'require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(1), env: process.env }))' -- "$@"\nexec tar "$@"\n`);
  chmodSync(tar, 0o755);
  await installArchive(harnessOf(served.url, release), dir, { platform: PLATFORM, tar, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "fake-test-key", OPENROUTER_API_KEY: "fake-test-key", AGENTRUN_API_KEY: "fake-test-key" } });
  const { argv, env } = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(argv.length, 6, argv.join(" "));
  assert.deepEqual([argv[0], argv[2], argv[4], argv[5]], ["-xjf", "-C", "--no-same-owner", "--no-same-permissions"]);
  assert.match(argv[1], /archive\.tar\.bz2$/, "the downloaded archive");
  assert.ok(!argv[3].startsWith(dir), "unpacked into a folder beside the harness's, never into it");
  assert.deepEqual(Object.keys(env).filter((name) => /_API_KEY$/.test(name)), [], "no key reaches tar");
});

test("a crash between the unpack and the rename leaves a fresh folder beside the harness and no install; the next install removes it", { timeout: 60_000 }, async (t) => {
  const release = await fakeRelease(t);
  const served = await origin(t, release.bytes);
  const { harnesses, dir } = await place(t);
  const harness = harnessOf(served.url, release);
  // The install in a process of its own that dies (exit 9) once the binary is unpacked and verified, before the rename.
  const script = `const { installArchive } = await import(${JSON.stringify(new URL("../dist/harness-archive.js", import.meta.url).href)});
await installArchive(${JSON.stringify(harness)}, ${JSON.stringify(dir)}, { platform: ${JSON.stringify(PLATFORM)}, onStep: (step) => { if (step === "verified") process.exit(9); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 9, stderr);
  assert.equal(existsSync(dir), false, "no half install in place");
  assert.equal(leftovers(harnesses).length, 1, "the fresh folder it worked in stays beside it");
  const done = await installArchive(harness, dir, { platform: PLATFORM });
  assert.equal(done.installed, "now");
  assert.equal(sha256(readFileSync(done.binary)), release.binarySha);
  assert.deepEqual(leftovers(harnesses), [], "the crashed install's folder went");
});

/** A fake Cursor release: a launcher at ./dist-package/cursor-agent and a file of code beside it, packed as a .tar.gz,
 *  with the archive's and the launcher's sha256 and the tree digest of every file (acp's treeDigest). */
async function fakeCursor(t, code = "console.log('cursor');\n") {
  const { treeDigest } = await import("@parcha/agentrun-harness-acp");
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "dist-package"), { recursive: true });
  const launcher = "#!/bin/sh\nexec node index.js \"$@\"\n";
  writeFileSync(join(tree, "dist-package", "cursor-agent"), launcher);
  chmodSync(join(tree, "dist-package", "cursor-agent"), 0o755);
  writeFileSync(join(tree, "dist-package", "index.js"), code);
  const archive = join(dir, "cursor.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "./dist-package"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  return { bytes, archiveSha: sha256(bytes), binarySha: sha256(Buffer.from(launcher)), treeSha: await treeDigest(tree), treeDigest };
}

/** Cursor under a pin of the fake release's digests, with acp's treeDigest to take a tree's. */
const cursorOf = (url, release, over = {}) => ({
  id: "cursor",
  label: "Cursor",
  retry: "agentrun harness install cursor",
  tree: release.treeDigest,
  pin: { id: "cursor", version: "2026.11.13-eacade1", archives: { [PLATFORM]: { url: `${url}/cursor.tar.gz`, format: "tar.gz", sha256: release.archiveSha, cmd: "./dist-package/cursor-agent", binarySha256: release.binarySha, treeSha256: release.treeSha, ...over } } },
});

test("a tar.gz archive (Cursor's) unpacks by tar -xzf, its launcher and every file beside it checked against the pin, and a rerun downloads nothing", async (t) => {
  const release = await fakeCursor(t);
  const served = await origin(t, release.bytes, "/cursor.tar.gz");
  const harnesses = join(await scratch(t), "harnesses");
  const dir = join(harnesses, "cursor");
  const done = await installArchive(cursorOf(served.url, release), dir, { platform: PLATFORM });
  assert.deepEqual(done, { installed: "now", binary: join(dir, "dist-package", "cursor-agent") });
  assert.equal(await release.treeDigest(dir), release.treeSha, "what is in place is the pinned tree");
  const again = await installArchive(cursorOf(served.url, release), dir, { platform: PLATFORM });
  assert.equal(again.installed, "already");
  assert.deepEqual(served.asked, ["/cursor.tar.gz"], "the rerun downloaded nothing");
});

test("a file beside the launcher that is not the pin's is refused before anything is put in place: HARNESS_BINARY_MISMATCH", async (t) => {
  const release = await fakeCursor(t);
  const pinned = await fakeCursor(t, "console.log('the pinned code');\n");
  const served = await origin(t, release.bytes, "/cursor.tar.gz");
  const dir = join(await scratch(t), "harnesses", "cursor");
  // The archive and the launcher are the pin's; one file of its code is not.
  const harness = cursorOf(served.url, release, { treeSha256: pinned.treeSha });
  await assert.rejects(installArchive(harness, dir, { platform: PLATFORM }), (error) => error.code === "HARNESS_BINARY_MISMATCH" && /tree sha256/.test(error.message) && error.message.includes("agentrun harness install cursor"));
  assert.equal(existsSync(dir), false, "nothing in place");
  // A pin that holds a tree digest with no way given to take one is refused before anything downloads.
  const { tree: _tree, ...blind } = cursorOf(served.url, release);
  await assert.rejects(installArchive(blind, dir, { platform: PLATFORM }), (error) => error.code === "HARNESS_PLATFORM_UNSUPPORTED");
  assert.deepEqual(served.asked, ["/cursor.tar.gz"], "the blind install downloaded nothing");
});

test("a format this installer does not unpack is refused before anything downloads", async (t) => {
  const release = await fakeCursor(t);
  const served = await origin(t, release.bytes, "/cursor.tar.gz");
  const dir = join(await scratch(t), "harnesses", "cursor");
  await assert.rejects(installArchive(cursorOf(served.url, release, { format: "7z" }), dir, { platform: PLATFORM }), (error) => error.code === "HARNESS_PLATFORM_UNSUPPORTED" && /tar\.bz2, tar\.gz and zip/.test(error.message));
  assert.deepEqual(served.asked, []);
});
