// `agentrun template install SOURCE` on a server that takes uploads alone. Such a server refuses a GitHub source in one of
// two structured ways (serve's API-only profile: 422 input_invalid with the field `source` not_allowed; a hosted tier: 422
// files_only), and the command then reads the package from GitHub itself (serve's own reader, here pointed at a faux
// GitHub) at the commit its ref is at, and uploads its files as `agentrun deploy` uploads a folder's ({files}), with
// --dry-run passed on. An upload keeps no publisher, so that path needs --trust unless it is a dry run, and it reads
// nothing before. Any other answer is as before: one request, GitHub never read.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { serve } from "../../serve/test/support.mjs";
import { packageFiles } from "../lib/deploy.mjs";
import { cli, scratch } from "./support.mjs";

const KYB = new URL("../../serve/templates/kyb/", import.meta.url).pathname;
const SHA = "a".repeat(40);
const ID = "github:acme/agents/templates/kyb";
const SOURCE = `${ID}@main`;

/** What `agentrun deploy` uploads of the same folder: the files the install must send, no more. */
const expected = () => packageFiles(KYB, (code, message) => new Error(`${code}: ${message}`));

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

/** A GitHub-shaped tarball: one top folder, a file beside the package, and the kyb package under templates/kyb/ with what
 *  is in its folder but no part of a package (a note at its root, another folder, hidden files). */
function tarball() {
  const top = "acme-agents-aaaaaaa";
  const blocks = [...entry("pax_global_header", { type: "g", data: Buffer.from(`52 comment=${SHA}\n`) }), ...entry(`${top}/`, { type: "5" }), ...entry(`${top}/README.md`, { data: Buffer.from("# agents\n") }), ...entry(`${top}/templates/`, { type: "5" }), ...entry(`${top}/templates/kyb/`, { type: "5" })];
  const walk = (dir, at) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        blocks.push(...entry(`${top}/${at}${name}/`, { type: "5" }));
        walk(path, `${at}${name}/`);
      } else blocks.push(...entry(`${top}/${at}${name}`, { data: readFileSync(path) }));
    }
  };
  walk(KYB, "templates/kyb/");
  for (const [path, text] of [["NOTES.md", "A note beside the package.\n"], [".env", "KEY=not-a-package-file\n"], ["notes/draft.md", "A draft.\n"], ["skills/.cache/x", "cached\n"]]) blocks.push(...entry(`${top}/templates/kyb/${path}`, { data: Buffer.from(text) }));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A faux GitHub: a ref resolved to SHA, the tarball at SHA through the redirect GitHub sends, and the requests sent. */
async function fauxGitHub(t) {
  const seen = [];
  const body = tarball();
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}${req.headers.authorization ? " (token)" : ""}`);
    const path = new URL(req.url, "http://faux").pathname;
    if (/^\/repos\/acme\/agents\/commits\/(main|HEAD)$/.test(path)) return res.writeHead(200, { "content-type": "text/plain" }).end(SHA);
    if (path === `/repos/acme/agents/tarball/${SHA}`) return res.writeHead(302, { location: `/codeload/acme/agents/legacy.tar.gz/${SHA}` }).end();
    if (path === `/codeload/acme/agents/legacy.tar.gz/${SHA}`) return res.writeHead(200, { "content-type": "application/x-gzip" }).end(body);
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

/** A fake AgentRun whose POST /v2/templates/import answers `answer(body)` ([status, json]), keeping each body. */
async function fakeServer(t, answer) {
  const sent = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!req.url.startsWith("/v2/")) return res.writeHead(404).end();
      const body = JSON.parse(raw);
      sent.push([req.method, req.url, body]);
      const [status, json] = answer(body);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
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
  const files = await expected();
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
  const files = await expected();

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
