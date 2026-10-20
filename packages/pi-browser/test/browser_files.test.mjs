import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserExtension } from "../dist/durable.js";
import { FakeBackend, fakeDriver } from "../dist/testing/index.js";
import { MAX_UPLOAD_BYTES, createRedactor, pageTools, workspaceFiles } from "../dist/index.js";
import { startSite, totp } from "./fixtures/site.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratchSync = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const parse = (out) => JSON.parse(out.content[0].text);

function rig(t, { downloads = null, interrupted = null } = {}) {
  const workspace = scratchSync(t, "files-ws-");
  const outside = scratchSync(t, "files-out-");
  const driven = [];
  const driver = {
    url: async () => "https://shop.test/upload",
    snapshot: async () => "- textbox \"file\"",
    setInputFiles: async (selector, file) => { driven.push({ selector, name: file.name, mimeType: file.mimeType, sha256: sha(file.buffer) }); },
  };
  const opened = { sessions: 0, custody: [] };
  let cut = interrupted;
  const port = {
    session: async () => { opened.sessions += 1; return { driver, tag: "ar-run-1-1", sessionId: "sess-1", record: { lastUrl: "https://shop.test/upload" }, notice: null, interrupted: cut, recorded: false, effects: null, downloads }; },
    dispatching: async (effect) => { opened.custody.push(["dispatching", effect]); },
    journal: async () => {},
    mark: async (step, callId) => { opened.custody.push(["mark", step, callId]); if (cut?.callId === callId) cut = { ...cut, [step]: true }; },
    settle: async (callId) => { opened.custody.push(["settle", callId]); if (cut?.callId === callId) cut = null; },
    ended: async () => false, dropped: async () => { opened.custody.push(["dropped"]); },
  };
  const call = { callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (text) => text, evidence: { file: async () => null }, workspace, files: workspaceFiles(workspace) };
  return { workspace, outside, driven, opened, port, call, tools: pageTools() };
}

test("a workspace file resolves to its bytes, its own name and a type from its extension", async (t) => {
  const { workspace } = rig(t);
  fs.mkdirSync(path.join(workspace, "reports"));
  fs.writeFileSync(path.join(workspace, "reports", "q3.pdf"), "%PDF-1.7 bytes");
  const file = await workspaceFiles(workspace).resolve("reports/q3.pdf");
  assert.deepEqual([Buffer.from(file.bytes).toString(), file.name, file.mime], ["%PDF-1.7 bytes", "q3.pdf", "application/pdf"]);
  assert.equal((await workspaceFiles(workspace).resolve("./reports/q3.pdf")).name, "q3.pdf");
});

test("a path that leaves the workspace, by '..', by being absolute or through a symlink, is refused", async (t) => {
  const { workspace, outside } = rig(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
  fs.mkdirSync(path.join(workspace, "sub"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
  fs.symlinkSync(outside, path.join(workspace, "linkdir"));
  const files = workspaceFiles(workspace);
  for (const [rel, why] of [
    ["../secret.txt", /'\.\.'/], ["sub/../../secret.txt", /'\.\.'/], [path.join(outside, "secret.txt"), /absolute/], ["C:\\Windows\\win.ini", /absolute/],
    ["link.txt", /outside the workspace/], ["linkdir/secret.txt", /outside the workspace/], ["", /name a file/], ["a\0b", /name a file/],
  ]) {
    const out = await files.resolve(rel);
    assert.ok("refused" in out, JSON.stringify(rel));
    assert.match(out.refused, why, JSON.stringify(rel));
  }
});

test("a symlink that stays inside the workspace resolves; a directory, a missing file and one over the limit do not", async (t) => {
  const { workspace } = rig(t);
  fs.writeFileSync(path.join(workspace, "real.txt"), "inside");
  fs.symlinkSync(path.join(workspace, "real.txt"), path.join(workspace, "alias.txt"));
  fs.mkdirSync(path.join(workspace, "dir"));
  fs.writeFileSync(path.join(workspace, "max.bin"), Buffer.alloc(MAX_UPLOAD_BYTES));
  fs.writeFileSync(path.join(workspace, "big.bin"), Buffer.alloc(MAX_UPLOAD_BYTES + 1));
  const files = workspaceFiles(workspace);
  assert.equal((await files.resolve("alias.txt")).name, "real.txt");
  assert.equal((await files.resolve("max.bin")).bytes.byteLength, MAX_UPLOAD_BYTES);
  assert.match((await files.resolve("big.bin")).refused, /over the 8388608-byte limit/);
  assert.match((await files.resolve("dir")).refused, /not a regular file/);
  assert.match((await files.resolve("nope.txt")).refused, /no file at nope\.txt/);
  assert.match((await workspaceFiles(workspace, { maxBytes: 3 }).resolve("real.txt")).refused, /over the 3-byte limit/);
});

test("a file swapped for a symlink out of the workspace after its check is refused, never followed", async (t) => {
  const { workspace, outside } = rig(t);
  fs.writeFileSync(path.join(workspace, "doc.txt"), "inside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  // Forced race: the swap lands between the realpath check and the open.
  const open = fs.promises.open;
  fs.promises.open = async (file, ...rest) => {
    if (String(file).endsWith(`${path.sep}doc.txt`)) { fs.rmSync(file); fs.symlinkSync(path.join(outside, "secret.txt"), file); }
    return open.call(fs.promises, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = open; syncBuiltinESMExports(); });
  assert.match((await workspaceFiles(workspace).resolve("doc.txt")).refused, /cannot be opened/);
});

test("a parent directory swapped for a symlink out of the workspace after the check is refused, never read", async (t) => {
  const { workspace, outside } = rig(t);
  fs.mkdirSync(path.join(workspace, "sub"));
  fs.writeFileSync(path.join(workspace, "sub", "doc.txt"), "inside");
  fs.writeFileSync(path.join(outside, "doc.txt"), "outside");
  // Forced race: the parent turns into an outward symlink between the realpath check and the open.
  const open = fs.promises.open;
  fs.promises.open = async (file, ...rest) => {
    if (String(file).endsWith(path.join("sub", "doc.txt"))) { fs.rmSync(path.join(workspace, "sub"), { recursive: true }); fs.symlinkSync(outside, path.join(workspace, "sub")); }
    return open.call(fs.promises, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = open; syncBuiltinESMExports(); });
  const out = await workspaceFiles(workspace).resolve("sub/doc.txt");
  assert.match(out.refused ?? "", /outside the workspace/, JSON.stringify(out.refused ?? Buffer.from(out.bytes).toString()));
});

test("a named pipe in the workspace is refused at once, never waited on", { timeout: 5_000 }, async (t) => {
  const { workspace } = rig(t);
  execFileSync("mkfifo", [path.join(workspace, "pipe")]);
  assert.match((await workspaceFiles(workspace).resolve("pipe")).refused, /not a regular file/);
});

test("a host's veto on a resolved file refuses it with the host's reason", async (t) => {
  const { workspace } = rig(t);
  fs.writeFileSync(path.join(workspace, "ledger.json"), "{}");
  fs.writeFileSync(path.join(workspace, "mine.txt"), "x");
  fs.symlinkSync(path.join(workspace, "ledger.json"), path.join(workspace, "alias.json"));
  const files = workspaceFiles(workspace, { refuse: (real) => (path.basename(real) === "ledger.json" ? "reserved by the host" : null) });
  assert.equal((await files.resolve("ledger.json")).refused, "ledger.json: reserved by the host");
  assert.equal((await files.resolve("alias.json")).refused, "alias.json: reserved by the host");
  assert.equal((await files.resolve("mine.txt")).name, "mine.txt");
});

test("browser_upload refuses a file outside the workspace or over the limit before it opens a session or calls the driver", async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.outside, "x"), "outside");
  fs.symlinkSync(path.join(r.outside, "x"), path.join(r.workspace, "out-link"));
  fs.writeFileSync(path.join(r.workspace, "big.bin"), Buffer.alloc(9 * 1024 * 1024));
  for (const rel of ["../x", path.join(r.outside, "x"), "out-link", "big.bin"]) {
    const out = await r.tools.browser_upload({ path: rel, selector: "input[type=file]" }, r.port, r.call);
    assert.equal(out.isError, true, rel);
    assert.deepEqual([parse(out).code, parse(out).effect, parse(out).retryable], ["refused", "none", false], rel);
  }
  assert.equal(r.opened.sessions, 0, "no session was opened for a refused file");
  assert.deepEqual(r.driven, [], "the driver never saw a refused file");
});

test("browser_upload sets the file input with the file's exact bytes and reports its name, size and SHA-256", async (t) => {
  const r = rig(t);
  const bytes = Buffer.from("invoice 2026-10, total 1,234.00\n");
  fs.writeFileSync(path.join(r.workspace, "invoice.csv"), bytes);
  const out = await r.tools.browser_upload({ path: "invoice.csv", selector: "#file" }, r.port, r.call);
  assert.equal(out.isError, undefined, out.content[0].text);
  assert.deepEqual(parse(out), { ok: true, uploaded: { name: "invoice.csv", bytes: bytes.length, sha256: sha(bytes) }, selector: "#file" });
  assert.deepEqual(r.driven, [{ selector: "#file", name: "invoice.csv", mimeType: "text/csv", sha256: sha(bytes) }]);
});

test("an upload is journaled before the file is set, and a connection that drops under it is reported, never repeated", async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  assert.equal(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, r.call)).ok, true);
  assert.deepEqual(r.opened.custody.map(([op, x]) => [op, op === "dispatching" ? x.tool : x]), [["dispatching", "browser_upload"], ["mark", "finished"]]);
  let tries = 0;
  const dropping = { ...r.port, session: async () => ({ ...(await r.port.session()), driver: { url: async () => "https://shop.test/", setInputFiles: async () => { tries += 1; throw Object.assign(new Error("closed"), { name: "CDPConnectionClosedError" }); } } }) };
  const out = parse(await r.tools.browser_upload({ path: "a.txt", selector: "#g" }, dropping, r.call));
  assert.deepEqual([out.code, out.effect, tries], ["browser_unavailable", "possibly_effected", 1]);
});

test("an upload a hold fenced before the file was set is settled as not sent", async (t) => {
  const { fenced } = await import("../dist/core/custody.js");
  const r = rig(t);
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  const held = { fence: 1, failure: { ok: false, code: "waiting_for_human", retryable: false, effect: "none", message: "held" } };
  let tried = 0;
  const driver = fenced({ url: async () => "https://shop.test/", setInputFiles: async () => { tried += 1; } }, 0, () => held);
  const holding = { ...r.port, session: async () => ({ ...(await r.port.session()), driver }) };
  assert.equal(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, holding, r.call)).code, "waiting_for_human");
  assert.equal(tried, 0);
  assert.deepEqual(r.opened.custody.map(([op, x]) => [op, op === "dispatching" ? x.tool : x]), [["dispatching", "browser_upload"], ["settle", "c1"]]);
});

test("an upload the page rejects names the upload, not code the model never wrote", async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  const missing = { ...r.port, session: async () => ({ ...(await r.port.session()), driver: { url: async () => "https://shop.test/", setInputFiles: async () => { throw new Error("No node found for selector: #nope"); } } }) };
  const out = parse(await r.tools.browser_upload({ path: "a.txt", selector: "#nope" }, missing, r.call));
  assert.deepEqual([out.code, out.effect], ["code_error", "possibly_effected"]);
  assert.equal(out.message, "Your browser_upload call threw: No node found for selector: #nope");
});

test("the same upload after an interruption that may have sent it is not repeated", async (t) => {
  const first = rig(t);
  fs.writeFileSync(path.join(first.workspace, "a.txt"), "a");
  await first.tools.browser_upload({ path: "a.txt", selector: "#f" }, first.port, first.call);
  const interrupted = { ...first.opened.custody[0][1], at: "2026-10-13T00:00:00Z", sent: [{ requestId: "1", method: "POST", origin: "https://shop.test", path: "/upload", at: "x", held: null, irreversible: null }] };
  const r = rig(t, { interrupted });
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  const again = { ...r.call, callId: "c2" };
  const out = await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, again);
  assert.equal(parse(out).code, "effect_unknown");
  assert.match(parse(out).message, /Your browser_upload call c1 on https:\/\/shop\.test\/upload was interrupted.*This is the same upload/s);
  assert.deepEqual(r.driven, []);
  assert.deepEqual(r.opened.custody, [["mark", "told", "c1"], ["mark", "refused", "c1"]]);

  assert.equal(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, { ...again, callId: "c3" })).code, "effect_unknown");
  assert.deepEqual(r.driven, []);
  await r.tools.snapshot({}, r.port, { ...again, callId: "c4" });
  assert.deepEqual(r.opened.custody.at(-1), ["settle", "c1"]);
  assert.equal(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, { ...again, callId: "c5" })).ok, true);
  assert.equal(r.driven.length, 1);
});

test("an upload cut by a crash is never judged harmless: with a holding observer that saw no request, the identical retry is effect_unknown and the file is not set a second time", async (t) => {
  // Setting a file into an input sends no request, so "observed, nothing sent" says nothing about whether the file is set.
  for (const finished of [false, true]) {
    const first = rig(t);
    fs.writeFileSync(path.join(first.workspace, "a.txt"), "a");
    await first.tools.browser_upload({ path: "a.txt", selector: "#f" }, first.port, first.call);
    const interrupted = { ...first.opened.custody[0][1], at: "2026-10-13T00:00:00Z", observed: true, watched: true, sent: [], ...(finished ? { finished: true } : {}) };
    assert.equal(interrupted.tool, "browser_upload");
    const r = rig(t, { interrupted });
    fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
    const out = parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, { ...r.call, callId: "c2" }));
    assert.equal(out.code, "effect_unknown", `finished=${finished}`);
    assert.equal(out.effect, "possibly_effected");
    assert.match(out.message, /Your browser_upload call c1 on https:\/\/shop\.test\/upload (was interrupted|ran, but the process stopped).*This is the same upload/s);
    assert.doesNotMatch(out.message, /safe to run again/, "an upload is never told as safe to run again");
    assert.deepEqual(r.driven, [], "the file was not set a second time");
    assert.deepEqual(r.opened.custody, [["mark", "told", "c1"], ["mark", "refused", "c1"]], "told once and refused, never settled by the retry");
    await r.tools.snapshot({}, r.port, { ...r.call, callId: "c3" });
    assert.deepEqual(r.opened.custody.at(-1), ["settle", "c1"], "a look settles it");
    assert.equal(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, { ...r.call, callId: "c4" })).ok, true, "after the look the upload goes through once");
    assert.equal(r.driven.length, 1);
  }
});

/** The name a host call fails with when the browser never answers it within its deadline (core/unanswered.ts). */
const unanswered = (what) => Object.assign(new Error(`${what} had no answer from the browser within 60000 ms`), { name: "UnansweredHostCallError" });

/** The rig's port with a driver whose file input never answers while `state.hung` holds; once it answers, each set is recorded. */
function hanging(r) {
  const state = { hung: true, set: [] };
  const driver = {
    url: async () => "https://shop.test/upload",
    snapshot: async () => "- textbox \"file\"",
    page: async () => ({ url: "https://shop.test/upload", title: "Upload", text: "Upload a file", html: "<html><body><h1>Upload</h1><input type=file id=f></body></html>" }),
    setInputFiles: async (selector, file) => { if (state.hung) throw unanswered("locator.setInputFiles"); state.set.push([selector, file.name]); },
  };
  return { state, port: { ...r.port, session: async () => ({ ...(await r.port.session()), driver }) } };
}

test("an upload whose file input never answers is told as possibly applied; the identical upload is refused until a look, a different file is not", async (t) => {
  const r = rig(t);
  for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(r.workspace, name), name);
  const { state, port } = hanging(r);
  const up = (file, callId) => r.tools.browser_upload({ path: file, selector: "#f" }, port, { ...r.call, callId });
  const cut = parse(await up("a.txt", "c1"));
  assert.deepEqual([cut.ok, cut.code, cut.effect, cut.retryable], [false, "browser_unavailable", "possibly_effected", true], JSON.stringify(cut));
  assert.match(cut.message, /did not answer your browser_upload/);
  assert.match(cut.message, /look at the page with snapshot or browser_read before you upload it again/i);
  state.hung = false;
  const again = parse(await up("a.txt", "c2"));
  assert.deepEqual([again.code, again.effect, again.retryable], ["effect_unknown", "possibly_effected", true], JSON.stringify(again));
  assert.deepEqual(state.set, [], "the identical upload was not repeated");
  // Word for word the refusal after an interruption (the test above): the model reads one rule.
  assert.equal(again.message, "This is the same upload, and it may already have taken effect, so it is not repeated now: look at the page with snapshot or browser_read before you upload it again.");
  assert.equal(parse(await up("b.txt", "c3")).ok, true, "a different file is not blocked");
  assert.equal(parse(await up("a.txt", "c4")).code, "effect_unknown", "an upload in between is not a look");
  await r.tools.snapshot({}, port, { ...r.call, callId: "c5" });
  assert.equal(parse(await up("a.txt", "c6")).ok, true, "a snapshot cleared it");
  assert.deepEqual(state.set, [["#f", "b.txt"], ["#f", "a.txt"]]);
});

test("browser_read clears the refusal of an unanswered upload too", async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  const { state, port } = hanging(r);
  const up = (callId) => r.tools.browser_upload({ path: "a.txt", selector: "#f" }, port, { ...r.call, callId });
  assert.equal(parse(await up("c1")).code, "browser_unavailable");
  state.hung = false;
  assert.equal(parse(await up("c2")).code, "effect_unknown");
  const read = await r.tools.browser_read({}, port, { ...r.call, callId: "c3" });
  assert.equal(read.isError, undefined, read.content[0].text);
  assert.equal(parse(await up("c4")).ok, true, "browser_read cleared it");
  assert.deepEqual(state.set, [["#f", "a.txt"]]);
});

test("browser_upload with no workspace, no selector or a driver that cannot set files is refused", async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.workspace, "a.txt"), "a");
  assert.match(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, r.port, { ...r.call, files: undefined })).message, /no workspace/);
  assert.match(parse(await r.tools.browser_upload({ path: "a.txt", selector: "  " }, r.port, r.call)).message, /selector/);
  const bare = { ...r.port, session: async () => ({ ...(await r.port.session()), driver: { url: async () => "https://shop.test/" } }) };
  assert.match(parse(await r.tools.browser_upload({ path: "a.txt", selector: "#f" }, bare, r.call)).message, /cannot set a file input/);
});

test("browser_downloads copies the session's files into the workspace with a manifest row and SHA-256 each", async (t) => {
  const files = { "report.csv": "q,rev\nQ1,100\n", "../../escape.txt": "contained" };
  const downloads = {
    list: async () => Object.entries(files).map(([name, body]) => ({ name, sizeBytes: Buffer.byteLength(body), modifiedAt: "2026-10-13T00:00:00Z" })),
    read: async (_ref, name) => (async function* () { yield Buffer.from(files[name]); })(),
  };
  const r = rig(t, { downloads });
  const first = parse(await r.tools.browser_downloads({}, r.port, r.call));
  assert.equal(first.ok, true);
  assert.deepEqual(first.fetched.map((f) => [f.name, f.sha256]), [["report.csv", sha(files["report.csv"])], ["escape.txt", sha(files["../../escape.txt"])]]);
  assert.equal(fs.readFileSync(path.join(r.workspace, "downloads", "report.csv"), "utf8"), files["report.csv"]);
  assert.ok(!fs.existsSync(path.join(r.workspace, "..", "escape.txt")), "a hostile name stays inside downloads/");
  const manifest = JSON.parse(fs.readFileSync(path.join(r.workspace, "downloads", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map((row) => [row.path, row.session, row.remote.name]), [["downloads/report.csv", "sess-1", "report.csv"], ["downloads/escape.txt", "sess-1", "../../escape.txt"]]);
  const again = parse(await r.tools.browser_downloads({}, r.port, r.call));
  assert.deepEqual([again.fetched.length, again.already_fetched.length], [0, 2]);
});

// The tool hands fetchDownloads the run's redactor, so a registered value across the 200-character cut of a skipped file's reason leaves no fragment in what the tool returns.
test("browser_downloads redacts a skipped file's read error whole before the 200-character cut", async (t) => {
  const token = "run-token-0123456789";
  const downloads = {
    list: async () => [{ name: "a.pdf", sizeBytes: 3, modifiedAt: null }],
    read: async () => { throw new Error(`${"r".repeat(192)}${token} and more`); },
  };
  const r = rig(t, { downloads });
  const out = await r.tools.browser_downloads({}, r.port, { ...r.call, redact: createRedactor(() => [token]) });
  assert.equal(parse(out).skipped.length, 1);
  assert.doesNotMatch(out.content[0].text, /run-t/);
});

test("a manifest that is there but not a downloads manifest is refused and left as it was", async (t) => {
  const downloads = { list: async () => [{ name: "a.txt", sizeBytes: 1, modifiedAt: null }], read: async () => (async function* () { yield Buffer.from("a"); })() };
  for (const kept of ['{"files": [{"name": "earlier.pdf"}]}', "{ not json"]) {
    const r = rig(t, { downloads });
    fs.mkdirSync(path.join(r.workspace, "downloads"));
    fs.writeFileSync(path.join(r.workspace, "downloads", "manifest.json"), kept);
    const out = await r.tools.browser_downloads({}, r.port, r.call);
    assert.equal(out.isError, true);
    assert.deepEqual([parse(out).code, parse(out).retryable], ["refused", false]);
    assert.match(parse(out).message, /fix or move it/);
    assert.equal(fs.readFileSync(path.join(r.workspace, "downloads", "manifest.json"), "utf8"), kept);
  }
});

test("browser_downloads on a provider that keeps no downloads, or with no workspace, is refused", async (t) => {
  const r = rig(t);
  assert.match(parse(await r.tools.browser_downloads({}, r.port, r.call)).message, /cannot list the files/);
  const s = rig(t, { downloads: { list: async () => [], read: async () => (async function* () {})() } });
  assert.match(parse(await s.tools.browser_downloads({}, s.port, { ...s.call, workspace: undefined })).message, /no workspace/);
});

test("the browser section names upload and downloads only for an agent offered them", async (t) => {
  const backend = new FakeBackend();
  const { extension } = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null }, workspace: () => scratchSync(t, "files-section-") });
  const render = (tools) => extension.sections[0].render({ agent: { tools: tools.map((name) => ({ name })) }, read: { snapshot: async () => undefined }, conversationId: 1 }, {});
  const all = await render(["snapshot", "browser_downloads", "browser_upload"]);
  assert.match(all, /- browser_downloads: /);
  assert.match(all, /- browser_upload: /);
  const some = await render(["snapshot"]);
  assert.doesNotMatch(some, /browser_upload|- browser_downloads/);
  assert.match(some, /cannot be collected from the browser/);
});

test("the fixture's code step signs in only after the password step, never on a code alone", async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  await fetch(`${site.base}/totp-enrol`, { method: "POST", body: new URLSearchParams({ code: totp(site.totpSecret()) }) });
  assert.equal(site.totpEnrolled(), true);
  const direct = await fetch(`${site.base}/login/code`, { method: "POST", body: new URLSearchParams({ code: totp(site.totpSecret()) }), redirect: "manual" });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("set-cookie"), null);
  assert.match(await direct.text(), /Sign in with your password first/);
});

test("the durable extension lists browser_upload and browser_downloads only for a host with a workspace or a files port", (t) => {
  const backend = new FakeBackend();
  const base = { provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null } };
  const names = (options) => createBrowserExtension({ ...base, ...options }).tools.map((tool) => tool.name).filter((name) => name === "browser_upload" || name === "browser_downloads");
  assert.deepEqual(names({}), []);
  assert.deepEqual(names({ workspace: () => scratchSync(t, "files-list-") }), ["browser_downloads", "browser_upload"]);
  assert.deepEqual(names({ files: { resolve: async () => ({ refused: "no" }) } }), ["browser_upload"]);
});
