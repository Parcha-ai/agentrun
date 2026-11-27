// `agentrun template install SOURCE` on a server that takes uploads alone. Such a server refuses a GitHub source in one of
// two structured ways (serve's API-only profile: 422 input_invalid with the field `source` not_allowed; a hosted tier: 422
// files_only), and the command then reads the package from GitHub itself (serve's own reader, here pointed at a faux
// GitHub) at the commit its ref is at, and uploads its files as `agentrun deploy` uploads a folder's ({files}), with
// --dry-run passed on. An upload keeps no publisher, so that path needs --trust unless it is a dry run, and it reads
// nothing before. Any other answer is as before: one request, GitHub never read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { serve } from "../../serve/test/support.mjs";
import { filesBody } from "../lib/deploy.mjs";
import { cli, scratch } from "./support.mjs";

const KYB = new URL("../../serve/templates/kyb/", import.meta.url).pathname;
const SHA = "a".repeat(40);
const ID = "github:acme/agents/templates/kyb";
const SOURCE = `${ID}@main`;

/** The kyb package's files by path, as the faux repository holds them under templates/kyb/. */
function kybFiles(dir = KYB, at = "", files = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) kybFiles(path, `${at}${name}/`, files);
    else files.set(`${at}${name}`, readFileSync(path));
  }
  return files;
}

const hidden = (path) => path.split("/").some((part) => part.startsWith("."));

/** What the command must upload, in the upload's encoding: every file of the package's folder at the commit, as serve's
 *  own import of the source reads the folder, but a hidden one (an upload never keeps one, so it is never sent). */
const expected = (extra = EXTRA) => filesBody(new Map([...kybFiles(), ...extra.filter(([path]) => !hidden(path)).map(([path, text]) => [path, Buffer.from(text)])]));

/** A ustar entry: its header (with a pax record before it for a path past 100 bytes) and its data, padded. */
function entry(path, { type = "0", data = Buffer.alloc(0) } = {}) {
  const blocks = [];
  if (Buffer.byteLength(path) > 100) {
    const record = ` path=${path}\n`;
    let length = record.length + 1;
    while (String(length).length + record.length !== length) length = String(length).length + record.length;
    blocks.push(...entry("PaxHeader", { type: "x", data: Buffer.from(`${length}${record}`) }));
    path = path.slice(-100);
  }
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  return blocks;
}

/** What the faux repository holds in the package's folder beside the package: a note at its root, which a package may
 *  hold, and hidden files. */
const EXTRA = [["NOTES.md", "A note beside the package.\n"], [".env", "KEY=not-a-package-file\n"], ["skills/.cache/x", "cached\n"]];

/** A GitHub-shaped tarball at `sha`: one top folder, a file beside the package, and the kyb package under
 *  templates/<folder>/ (kyb by default, the name its agent.md gives) with `extra` ([path, text]) in its folder too. */
function tarball({ sha = SHA, extra = EXTRA, folder = "kyb" } = {}) {
  const top = `acme-agents-${sha.slice(0, 7)}`;
  const blocks = [...entry("pax_global_header", { type: "g", data: Buffer.from(`52 comment=${sha}\n`) }), ...entry(`${top}/`, { type: "5" }), ...entry(`${top}/README.md`, { data: Buffer.from("# agents\n") }), ...entry(`${top}/templates/`, { type: "5" }), ...entry(`${top}/templates/${folder}/`, { type: "5" })];
  const walk = (dir, at) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        blocks.push(...entry(`${top}/${at}${name}/`, { type: "5" }));
        walk(path, `${at}${name}/`);
      } else blocks.push(...entry(`${top}/${at}${name}`, { data: readFileSync(path) }));
    }
  };
  walk(KYB, `templates/${folder}/`);
  for (const [path, text] of extra) blocks.push(...entry(`${top}/templates/${folder}/${path}`, { data: Buffer.from(text) }));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A faux GitHub: `resolve(ref)` the commit a ref is at now (main and HEAD at SHA by default), a tarball by commit (or by
 *  a ref, at the commit it is at then) through the redirect GitHub sends, and the requests sent. */
async function fauxGitHub(t, { resolve = (ref) => (ref === "main" || ref === "HEAD" ? SHA : undefined), tarballs = { [SHA]: tarball() } } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}${req.headers.authorization ? " (token)" : ""}`);
    const path = new URL(req.url, "http://faux").pathname;
    let match;
    if ((match = /^\/repos\/acme\/agents\/commits\/([^/]+)$/.exec(path))) {
      const sha = resolve(decodeURIComponent(match[1]));
      return sha ? res.writeHead(200, { "content-type": "text/plain" }).end(sha) : res.writeHead(404).end("{}");
    }
    if ((match = /^\/repos\/acme\/agents\/tarball\/([^/]+)$/.exec(path))) {
      const sha = tarballs[match[1]] ? match[1] : resolve(decodeURIComponent(match[1]));
      return sha ? res.writeHead(302, { location: `/codeload/acme/agents/legacy.tar.gz/${sha}` }).end() : res.writeHead(404).end("{}");
    }
    if ((match = /^\/codeload\/acme\/agents\/legacy\.tar\.gz\/([0-9a-f]{40})$/.exec(path)) && tarballs[match[1]]) return res.writeHead(200, { "content-type": "application/x-gzip" }).end(tarballs[match[1]]);
    res.writeHead(404).end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => (server.closeAllConnections(), server.close(done))));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A loopback proxy in front of `to` that keeps each API request's body as JSON: what the command sent. */
async function recorder(t, to) {
  const sent = [];
  const target = new URL(to);
  const proxy = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url.startsWith("/v2/")) sent.push([req.method, req.url, raw.length ? JSON.parse(raw.toString("utf8")) : undefined]);
      const out = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      out.on("error", () => res.writeHead(502).end());
      out.end(raw);
    });
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => (proxy.closeAllConnections(), proxy.close(done))));
  return { base: `http://127.0.0.1:${proxy.address().port}${target.pathname}`, sent };
}

/** A fake AgentRun whose POST /v2/templates/import answers `answer(body)` ([status, json], or [status, text] for a body
 *  that is not JSON), keeping each body. */
async function fakeServer(t, answer) {
  const sent = [];
  const server = createServer((req, res) => {
    // Bytes kept whole until the end: a character split across two chunks is read as one.
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url.startsWith("/v2/")) return res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sent.push([req.method, req.url, body]);
      const [status, json] = answer(body);
      res.writeHead(status, { "content-type": typeof json === "string" ? "text/plain" : "application/json" }).end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => (server.closeAllConnections(), server.close(done))));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, sent };
}

/** The command against `base` with its token, reading GitHub at `github` (a test's seam, honoured under a test runner
 *  alone, which this file is run by: said here so the command never reads the real GitHub). */
const installer = (base, github, token = "tok") => {
  const { env } = scratch("template-install");
  const full = { ...env, AGENTRUN_BASE_URL: base, AGENTRUN_API_KEY: token, AGENTRUN_TEST_GITHUB_API: github.url, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child" };
  return (...args) => cli(full, ["template", "install", ...args], { timeout: 120_000 });
};

const READ_FIRST = /takes uploaded packages only[\s\S]*Read it first \(--dry-run\), then run this again with --trust\./;
const READ_HERE = new RegExp(`takes uploaded packages only, so this command read ${ID} from GitHub itself at ${SHA}`);

test("on an API-only serve, which refuses a GitHub source, the command reads the package from GitHub at its commit and uploads exactly its files: a dry run stores nothing, --trust stores it, neither refuses with nothing read", { timeout: 180_000 }, async (t) => {
  const hosted = await serve(t, { runner: false, apiOnly: true });
  const proxy = await recorder(t, hosted.baseUrl);
  const github = await fauxGitHub(t);
  const install = installer(proxy.base, github, hosted.token);
  const files = expected();
  const stored = async () => (await hosted.store.importedTemplates.list()).map((row) => [row.id, Object.keys(row.files).sort()]);

  const untrusted = await install(SOURCE);
  assert.equal(untrusted.code, 1, untrusted.err);
  assert.equal(untrusted.out, "");
  assert.match(untrusted.err, READ_FIRST);
  assert.deepEqual(github.seen, [], "nothing is read from GitHub without --trust or --dry-run");
  assert.deepEqual(proxy.sent, [["POST", "/v2/templates/import", { source: SOURCE }]]);

  const preview = await install(SOURCE, "--dry-run");
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.err, READ_HERE);
  const shown = preview.json();
  assert.deepEqual([shown.id, shown.source, shown.sha, shown.publisher, shown.stored, shown.template.id], ["upload:kyb", `${ID}@${SHA}`, SHA, null, false, "upload:kyb"]);
  assert.match(shown.instructions, /\S/, "a dry run prints the package whole");
  assert.deepEqual(github.seen, ["GET /repos/acme/agents/commits/main", `GET /repos/acme/agents/tarball/${SHA}`, `GET /codeload/acme/agents/legacy.tar.gz/${SHA}`], "the ref is resolved, then the tarball read at its commit, anonymously");
  assert.deepEqual(proxy.sent.slice(1), [["POST", "/v2/templates/import", { source: SOURCE, dry_run: true }], ["POST", "/v2/templates/import", { files, dry_run: true }]]);
  assert.deepEqual(await stored(), [], "a dry run stores nothing");

  const imported = await install(SOURCE, "--trust");
  assert.equal(imported.code, 0, imported.err);
  assert.match(imported.err, READ_HERE);
  const done = imported.json();
  assert.deepEqual([done.id, done.source, done.sha, done.publisher, done.stored, done.publisher_trusted], ["upload:kyb", `${ID}@${SHA}`, SHA, null, true, true]);
  // The upload carries no trust_publisher: an upload asks none, and the server refuses one.
  assert.deepEqual(proxy.sent.slice(3), [["POST", "/v2/templates/import", { source: SOURCE, trust_publisher: true }], ["POST", "/v2/templates/import", { files }]]);
  assert.deepEqual(await stored(), [["upload:kyb", files.map((file) => file.path).sort()]]);
});

test("on a server that refuses a source as files_only (a hosted tier), the command uploads the package's files with the flags' meaning", { timeout: 120_000 }, async (t) => {
  const github = await fauxGitHub(t);
  const target = await fakeServer(t, (body) => {
    if (body.source !== undefined) return [422, { error: { code: "files_only", message: "This install imports a package's files only, never a source.", retryable: false } }];
    const stored = body.dry_run !== true;
    return [stored ? 201 : 200, { template: { id: "upload:kyb", name: "kyb", source: "upload:kyb", sha: "f".repeat(64), publisher: "" }, instructions: "Check the business.", skill_files: { "kyb/SKILL.md": "# kyb" }, publisher_trusted: true, stored, replaced: null, console_url: "http://127.0.0.1/#/templates" }];
  });
  const install = installer(target.base, github);
  const files = expected();

  const untrusted = await install(SOURCE);
  assert.equal(untrusted.code, 1, untrusted.err);
  assert.match(untrusted.err, READ_FIRST);
  assert.doesNotMatch(untrusted.err, /files_only/, "the refusal the command acts on is not printed as a failure");
  assert.deepEqual(github.seen, []);

  const preview = await install(SOURCE, "--dry-run");
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.err, READ_HERE);
  assert.deepEqual(preview.json(), { id: "upload:kyb", source: `${ID}@${SHA}`, sha: SHA, publisher: null, publisher_trusted: true, stored: false, replaced: null, console_url: "http://127.0.0.1/#/templates", instructions: "Check the business.", skill_files: { "kyb/SKILL.md": "# kyb" }, template: { id: "upload:kyb", name: "kyb", source: "upload:kyb", sha: "f".repeat(64), publisher: "" } });

  const imported = await install(SOURCE, "--trust");
  assert.equal(imported.code, 0, imported.err);
  assert.deepEqual(imported.json(), { id: "upload:kyb", source: `${ID}@${SHA}`, sha: SHA, publisher: null, publisher_trusted: true, stored: true, replaced: null, console_url: "http://127.0.0.1/#/templates" });

  assert.deepEqual(target.sent, [
    ["POST", "/v2/templates/import", { source: SOURCE }],
    ["POST", "/v2/templates/import", { source: SOURCE, dry_run: true }],
    ["POST", "/v2/templates/import", { files, dry_run: true }],
    ["POST", "/v2/templates/import", { source: SOURCE, trust_publisher: true }],
    ["POST", "/v2/templates/import", { files }],
  ]);
});

test("a server that takes the source, or refuses it any other way, gets the one request it got before, and GitHub is never read here", { timeout: 120_000 }, async (t) => {
  const github = await fauxGitHub(t);
  let answer;
  const target = await fakeServer(t, (body) => answer(body));
  const install = installer(target.base, github);

  answer = (body) => [201, { template: { id: ID, name: "kyb", source: body.source, sha: SHA, publisher: "acme" }, publisher_trusted: true, stored: true, replaced: null, console_url: "http://127.0.0.1/#/templates/x" }];
  const imported = await install(SOURCE, "--trust");
  assert.equal(imported.code, 0, imported.err);
  assert.deepEqual(imported.json(), { id: ID, source: SOURCE, sha: SHA, publisher: "acme", publisher_trusted: true, stored: true, replaced: null, console_url: "http://127.0.0.1/#/templates/x" });
  assert.doesNotMatch(imported.err, /uploaded packages only/);

  for (const refusal of [
    { code: "input_invalid", message: "bad source", fields: [{ field: "source", reason: "bad_format", message: "bad source" }] },
    { code: "input_invalid", message: "not allowed", fields: [{ field: "trust_publisher", reason: "not_allowed", message: "not allowed" }] },
    { code: "github_failed", message: "GitHub did not answer." },
  ]) {
    answer = () => [refusal.code === "github_failed" ? 502 : 422, { error: refusal }];
    const refused = await install(SOURCE, "--trust");
    assert.equal(refused.code, 1, refused.err);
    assert.equal(JSON.parse(refused.err.split("\n")[0]).error.code, refusal.code, "the server's refusal, as it is");
    assert.doesNotMatch(refused.err, /uploaded packages only/);
  }
  assert.equal(target.sent.length, 4, "one request each");
  assert.deepEqual(github.seen, []);
});

// The fallback keys on the two refusals alone, each by its status, code and field: anything else that merely looks like
// one (a 500 or a 400 with that code, a message that says files_only, another field not_allowed, a body that is no JSON)
// is printed as the server sent it, with the exit it always had.
test("only a 422 files_only, or a 422 input_invalid naming source not_allowed, starts the fallback: every other refusal is printed as sent, with its usual exit, one request, GitHub never read", { timeout: 120_000 }, async (t) => {
  const github = await fauxGitHub(t);
  let answer;
  const target = await fakeServer(t, () => answer);
  const install = installer(target.base, github);
  const filesOnly = { code: "files_only", message: "This install imports a package's files only, never a source." };
  const sourceNotAllowed = { code: "input_invalid", message: "not here", fields: [{ field: "source", reason: "not_allowed", message: "not here" }] };
  const cases = [
    [500, { error: { code: "internal", message: "files_only: this install imports a package's files only" } }, 1],
    [500, { error: filesOnly }, 1],
    [502, { error: filesOnly }, 1],
    [400, { error: filesOnly }, 1],
    [403, { error: filesOnly }, 4],
    [400, { error: sourceNotAllowed }, 1],
    [500, { error: sourceNotAllowed }, 1],
    [422, { error: { code: "input_invalid", message: "files_only", fields: [{ field: "trust_publisher", reason: "not_allowed", message: "files_only" }] } }, 1],
    [422, { error: { code: "input_invalid", message: "bad", fields: [{ field: "files", reason: "not_allowed", message: "bad" }] } }, 1],
    [422, { error: { code: "input_invalid", message: "bad", fields: [{ field: "source", reason: "bad_format", message: "bad" }] } }, 1],
    [422, { error: { code: "input_invalid", message: "source not_allowed", fields: [] } }, 1],
    [422, { error: { code: "not_allowed", message: "files_only", field: "source", reason: "not_allowed" } }, 1],
    [422, { error: { message: "files_only" }, code: "files_only" }, 1],
    [422, "files_only", 1],
    [400, "This install imports a package's files only, never a source.", 1],
  ];
  for (const [status, body, exit] of cases) {
    const before = target.sent.length;
    answer = [status, body];
    const refused = await install(SOURCE, "--trust");
    const what = `${status} ${JSON.stringify(body)}`;
    assert.equal(refused.code, exit, `${what}: ${refused.err}`);
    assert.equal(refused.out, "", what);
    assert.ok(refused.err.startsWith(typeof body === "string" ? body : JSON.stringify(body)), `${what}: the refusal as the server sent it: ${refused.err}`);
    assert.doesNotMatch(refused.err, /uploaded packages only/, what);
    assert.equal(target.sent.length - before, 1, `${what}: one request`);
  }
  assert.deepEqual(github.seen, [], "GitHub is never read");
});

/** Each file a server stores for an imported package, by path: its sha256. */
async function storedFiles(server) {
  const rows = await server.store.importedTemplates.list();
  assert.equal(rows.length, 1, JSON.stringify(rows.map((row) => row.id)));
  const [row] = rows;
  return { id: row.id, sha: row.sha, files: Object.fromEntries(Object.entries(row.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, data]) => [path, createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")])) };
}

// The same source from the same faux GitHub, installed through a serve that reads GitHub itself and through the fallback
// on an API-only serve: both resolve the ref to the same commit and store the same package, file for file.
test("the fallback stores the very package, at the very commit, that a serve importing the source itself stores", { timeout: 180_000 }, async (t) => {
  const github = await fauxGitHub(t);
  const direct = await serve(t, { runner: false, templateImportApi: github.url });
  const hosted = await serve(t, { runner: false, apiOnly: true });

  const bySource = await installer(direct.baseUrl, github, direct.token)(SOURCE, "--trust");
  assert.equal(bySource.code, 0, bySource.err);
  assert.doesNotMatch(bySource.err, /uploaded packages only/, "that serve took the source");
  const byUpload = await installer(hosted.baseUrl, github, hosted.token)(SOURCE, "--trust");
  assert.equal(byUpload.code, 0, byUpload.err);
  assert.match(byUpload.err, READ_HERE);
  assert.deepEqual([bySource.json().sha, byUpload.json().sha], [SHA, SHA], "the same ref resolved to the same commit");

  const imported = await storedFiles(direct);
  const uploaded = await storedFiles(hosted);
  assert.deepEqual([imported.id, imported.sha, uploaded.id], [ID, SHA, "upload:kyb"]);
  // One rule on both paths: neither keeps a hidden file or folder (the faux package has .env and skills/.cache/x).
  assert.deepEqual(Object.keys(imported.files).filter(hidden), [], "serve's own import keeps no hidden path");
  assert.deepEqual(uploaded.files, imported.files, "the same files, byte for byte");
});

// A folder the package's import refuses (another folder beside skills/, rules/ and evals/) is refused through the
// fallback too, in the same words, and nothing is stored on either server.
test("a package the server's own import refuses is refused through the fallback too, in the same words", { timeout: 180_000 }, async (t) => {
  const github = await fauxGitHub(t, { tarballs: { [SHA]: tarball({ extra: [...EXTRA, ["notes/draft.md", "A draft.\n"]] }) } });
  const direct = await serve(t, { runner: false, templateImportApi: github.url });
  const hosted = await serve(t, { runner: false, apiOnly: true });
  const problems = (refused) => JSON.parse(refused.err.split("\n").find((line) => line.startsWith("{"))).error.fields.map((one) => [one.field, one.reason, one.message]);

  const bySource = await installer(direct.baseUrl, github, direct.token)(SOURCE, "--trust");
  const byUpload = await installer(hosted.baseUrl, github, hosted.token)(SOURCE, "--trust");
  assert.equal(bySource.code, 1, bySource.err);
  assert.equal(byUpload.code, 1, byUpload.err);
  assert.match(byUpload.err, READ_HERE);
  assert.deepEqual(problems(bySource), [["package", "invalid", "notes/: a package's folders are skills/, rules/ and evals/"]]);
  assert.deepEqual(problems(byUpload), problems(bySource));
  assert.deepEqual([await direct.store.importedTemplates.list(), await hosted.store.importedTemplates.list()], [[], []]);
});

test("a package whose agent.md names another folder is refused through the fallback too, as the server's own import refuses it, and nothing is stored", { timeout: 180_000 }, async (t) => {
  // A source's package is named by its folder; an upload is named by its agent.md. Without a check here, kyb's files
  // under templates/renamed/ would be stored as upload:kyb, in place of any upload of that name.
  const github = await fauxGitHub(t, { tarballs: { [SHA]: tarball({ folder: "renamed" }) } });
  const direct = await serve(t, { runner: false, templateImportApi: github.url });
  const hosted = await serve(t, { runner: false, apiOnly: true });
  const source = "github:acme/agents/templates/renamed@main";

  const bySource = await installer(direct.baseUrl, github, direct.token)(source, "--trust");
  const byUpload = await installer(hosted.baseUrl, github, hosted.token)(source, "--trust");
  assert.equal(bySource.code, 1, bySource.err);
  assert.match(bySource.err, /name is the folder's name, \\"renamed\\"/);
  assert.equal(byUpload.code, 1, `exit ${byUpload.code}: ${byUpload.out} ${byUpload.err}`);
  assert.match(byUpload.err, /agent\.md names the package "kyb", and a package's name is its folder's, "renamed"/);
  assert.match(byUpload.err, /nothing was uploaded/);
  assert.deepEqual([await direct.store.importedTemplates.list(), await hosted.store.importedTemplates.list()], [[], []]);
});

// The pin: the ref is resolved to a commit once, before anything else is read, and the tarball is read at that commit,
// so a branch that moves meanwhile changes nothing that is uploaded.
test("a ref that moves after it was resolved changes nothing: the tarball is read at the commit resolved first", { timeout: 120_000 }, async (t) => {
  const SHA_B = "b".repeat(40);
  let resolved = 0;
  const github = await fauxGitHub(t, { resolve: (ref) => (ref === "main" ? (resolved++ ? SHA_B : SHA) : undefined), tarballs: { [SHA]: tarball(), [SHA_B]: tarball({ sha: SHA_B, extra: [...EXTRA, ["rules/MOVED.md", "Moved since.\n"]] }) } });
  const target = await fakeServer(t, (body) => (body.source !== undefined ? [422, { error: { code: "files_only", message: "files only" } }] : [201, { template: { id: "upload:kyb", source: "upload:kyb", sha: "f".repeat(64), publisher: "" }, publisher_trusted: true, stored: true, replaced: null, console_url: "http://127.0.0.1/#/templates" }]));
  const done = await installer(target.base, github)(SOURCE, "--trust");
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json().sha, SHA);
  assert.deepEqual(github.seen, ["GET /repos/acme/agents/commits/main", `GET /repos/acme/agents/tarball/${SHA}`, `GET /codeload/acme/agents/legacy.tar.gz/${SHA}`]);
  assert.deepEqual(target.sent.at(-1)[2], { files: expected() }, "the package at the first commit, nothing of the moved one");
});

// The limits are the server's import's (IMPORT_LIMITS, through its reader): a package past them is refused here, while it
// is read, and nothing is uploaded.
test("a package past the server's import limits is refused while it is read, and nothing is uploaded", { timeout: 120_000 }, async (t) => {
  const { IMPORT_LIMITS } = await import("../../serve/dist/template-source.js");
  const many = Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, i) => [`skills/many/f${i}.md`, `${i}\n`]);
  const github = await fauxGitHub(t, { tarballs: { [SHA]: tarball({ extra: many }) } });
  const target = await fakeServer(t, () => [422, { error: { code: "files_only", message: "files only" } }]);
  const refused = await installer(target.base, github)(SOURCE, "--trust");
  assert.equal(refused.code, 1, refused.err);
  assert.equal(refused.out, "");
  assert.match(refused.err, new RegExp(`could not be read from GitHub, so nothing was uploaded: The package holds over ${IMPORT_LIMITS.files} files\\.`));
  assert.equal(target.sent.length, 1, "the source alone: no upload");
});
