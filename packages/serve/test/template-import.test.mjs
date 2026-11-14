// Installing a template package from GitHub (POST /v2/templates/import). The source's ref is resolved to a full commit SHA
// first, the tarball at that SHA is read from GitHub's own hosts alone (a faux GitHub here, the one host a test's server
// may read), and the package's folder is taken out of it in memory and checked by the same checker the bundled packages
// pass. A dry run stores nothing; an import is stored, listed beside the bundled packages under its own id, applied with
// its provenance kept on the agent, loaded again after a restart, replaced by a re-import and removed by DELETE. A link
// in the package, a redirect off GitHub, a source on another host, and a first import from an untrusted publisher are
// refused.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { storeOn } from "./store-helpers.mjs";
import { serve } from "./support.mjs";

const KYB = new URL("../templates/kyb/", import.meta.url).pathname;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ID = "github:acme/agents/templates/kyb";
const enc = encodeURIComponent;

/** A ustar entry: its header (with a pax record before it for a path past 100 bytes) and its data, padded. */
function entry(path, { type = "0", data = Buffer.alloc(0), link = "" } = {}) {
  const blocks = [];
  if (Buffer.byteLength(path) > 100) {
    let record = ` path=${path}\n`;
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
  header.write(link, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  return blocks;
}

/** A GitHub-shaped tarball (gzip): its pax global header, one top folder, the kyb package under templates/kyb/ and a file
 *  beside it that is not the package's; `extra` adds entries under the package's folder. */
function tarball(extra = []) {
  const top = "acme-agents-aaaaaaa";
  const blocks = [...entry("pax_global_header", { type: "g", data: Buffer.from(`52 comment=${SHA_A}\n`) }), ...entry(`${top}/`, { type: "5" }), ...entry(`${top}/README.md`, { data: Buffer.from("# agents\n") }), ...entry(`${top}/templates/`, { type: "5" }), ...entry(`${top}/templates/kyb/`, { type: "5" })];
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
  for (const [path, options] of extra) blocks.push(...entry(`${top}/templates/kyb/${path}`, options));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A faux GitHub: the API's commit and tarball routes, the tarball host it redirects to, and the requests it was sent.
 *  `refs` maps a repository's refs to SHAs; `tarballs` each SHA's tarball; `elsewhere` sends a repository's tarball off
 *  GitHub. */
async function fauxGitHub(t, { refs = { main: SHA_A, HEAD: SHA_A }, tarballs = { [SHA_A]: tarball() }, elsewhere = false } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, "http://faux");
    let match;
    if ((match = /^\/repos\/acme\/agents\/commits\/([^/]+)$/.exec(url.pathname))) {
      const sha = refs[decodeURIComponent(match[1])] ?? (Object.values(refs).includes(match[1]) ? match[1] : undefined);
      if (!sha) return res.writeHead(404).end(JSON.stringify({ message: "No commit found" }));
      return res.writeHead(200, { "content-type": "text/plain" }).end(sha);
    }
    if ((match = /^\/repos\/acme\/agents\/tarball\/([0-9a-f]{40})$/.exec(url.pathname))) {
      const location = elsewhere ? `http://example.invalid/acme/agents/legacy.tar.gz/${match[1]}` : `/codeload/acme/agents/legacy.tar.gz/${match[1]}`;
      return res.writeHead(302, { location }).end();
    }
    if ((match = /^\/codeload\/acme\/agents\/legacy\.tar\.gz\/([0-9a-f]{40})$/.exec(url.pathname)) && tarballs[match[1]]) {
      return res.writeHead(200, { "content-type": "application/x-gzip" }).end(tarballs[match[1]]);
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, refs, tarballs };
}

test("a source reads as github:<owner>/<repo>[/<path>][@<ref>], or a github.com tree URL made into it; anything else is refused", async () => {
  const { parseSource } = await import("../dist/template-source.js");
  assert.deepEqual(parseSource("github:Parcha-ai/agentrun/packages/serve/templates/kyb@main"), { owner: "Parcha-ai", repo: "agentrun", path: "packages/serve/templates/kyb", ref: "main", id: "github:Parcha-ai/agentrun/packages/serve/templates/kyb", source: "github:Parcha-ai/agentrun/packages/serve/templates/kyb@main" });
  assert.deepEqual(parseSource("github:acme/agents"), { owner: "acme", repo: "agents", path: null, ref: null, id: "github:acme/agents", source: "github:acme/agents" });
  assert.deepEqual(parseSource("https://github.com/acme/agents/tree/v1.2.0/templates/kyb"), { owner: "acme", repo: "agents", path: "templates/kyb", ref: "v1.2.0", id: ID, source: `${ID}@v1.2.0` });
  assert.deepEqual(parseSource("https://github.com/acme/agents.git"), { owner: "acme", repo: "agents", path: null, ref: null, id: "github:acme/agents", source: "github:acme/agents" });
  for (const bad of ["", "kyb", "gitlab:acme/agents", "https://gitlab.com/acme/agents", "http://github.com/acme/agents", "https://github.com.evil.example/acme/agents", "https://user@github.com/acme/agents", "https://github.com/acme/agents/blob/main/x", "https://github.com/acme/agents?x=1", "github:acme/agents/../secrets", "github:acme/agents//kyb", "github:acme", "github:-acme/agents", "github:acme/agents@main@dev", "github:acme/agents@../x"]) {
    assert.throws(() => parseSource(bad), (error) => error.code === "input_invalid" && error.extra.fields[0].field === "source", `refused: ${JSON.stringify(bad)}`);
  }
});

test("an import from GitHub: a dry run shows the package whole and stores nothing; the first import from a publisher needs its trust; it is listed beside the bundled one, applied with its provenance, and kept across a restart", { timeout: 120_000 }, async (t) => {
  const github = await fauxGitHub(t);
  const server = await serve(t, { templateImportApi: github.url, runner: false });
  const { api } = server;

  const preview = await api("POST", "/templates/import", { source: `${ID}@main`, dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.template.id, preview.body.template.name, preview.body.template.bundled, preview.body.template.source, preview.body.template.sha, preview.body.template.publisher], [ID, "kyb", false, `${ID}@main`, SHA_A, "acme"]);
  assert.deepEqual([preview.body.stored, preview.body.publisher_trusted, preview.body.replaced], [false, false, null]);
  assert.equal(new URL(preview.body.console_url).hash, `#/templates/install?src=${enc(`${ID}@main`)}`, "a dry run links to the install page");
  assert.equal(preview.body.instructions, readFileSync(join(KYB, "agent.md"), "utf8").replace(/^---[\s\S]*?\n---\n/, "").trim(), "the instructions in full");
  assert.equal(preview.body.skill_files["kyb/SKILL.md"], readFileSync(join(KYB, "skills/kyb/SKILL.md"), "utf8"), "each skill file in full");
  assert.ok(preview.body.skill_files["kyb/RED-FLAGS.md"], "the rules beside the skill");
  assert.ok(github.seen.indexOf(`GET /repos/acme/agents/commits/main`) < github.seen.findIndex((line) => line.includes("/tarball/")), `the ref is resolved before the tarball is read: ${github.seen}`);
  assert.ok(github.seen.includes(`GET /repos/acme/agents/tarball/${SHA_A}`), "the tarball is read at the SHA, never at the ref");
  const before = (await api("GET", "/templates")).body.templates;
  assert.deepEqual(before.filter((one) => !one.bundled), [], "a dry run stores nothing");
  const bundledKyb = before.find((one) => one.id === "kyb");
  assert.deepEqual([bundledKyb.bundled, bundledKyb.source, bundledKyb.sha, bundledKyb.publisher], [true, null, null, null]);

  const untrusted = await api("POST", "/templates/import", { source: `${ID}@main` });
  assert.equal(untrusted.status, 422, JSON.stringify(untrusted.body));
  assert.deepEqual(untrusted.body.error.fields.map((f) => [f.field, f.reason]), [["trust_publisher", "missing"]]);
  assert.deepEqual((await api("GET", "/templates")).body.templates.filter((one) => !one.bundled), [], "an untrusted publisher's package is not stored");

  const imported = await api("POST", "/templates/import", { source: `${ID}@main`, trust_publisher: true });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual([imported.body.stored, imported.body.publisher_trusted, imported.body.template.sha], [true, true, SHA_A]);
  assert.equal(new URL(imported.body.console_url).hash, `#/templates/${enc(ID)}`, "an import links to its apply page");
  const listed = (await api("GET", "/templates")).body.templates;
  assert.deepEqual(listed.filter((one) => one.name === "kyb").map((one) => [one.id, one.bundled]), [["kyb", true], [ID, false]], "the bundled kyb and the imported one are two packages");

  const applied = await api("POST", `/templates/${enc(ID)}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.template, ID);
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body;
  assert.deepEqual(agent.template, { id: ID, version: "0.1.0", sha: SHA_A }, "the agent keeps the package it came from and its commit");
  const bundledApplied = await api("POST", "/templates/kyb/apply", { parameters: {} });
  assert.equal(bundledApplied.status, 201, JSON.stringify(bundledApplied.body));
  assert.deepEqual((await api("GET", `/agents/${bundledApplied.body.agent_id}`)).body.template, { id: "kyb", version: "0.1.0", sha: null });

  // The publisher is trusted from now on: a re-import at a new SHA needs no tick, and replaces the package.
  github.refs.main = SHA_B;
  github.tarballs[SHA_B] = tarball([["NOTES.md", { data: Buffer.from("A note at the root of the package.\n") }]]);
  const again = await api("POST", "/templates/import", { source: `${ID}@main` });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.deepEqual([again.body.template.sha, again.body.replaced], [SHA_B, SHA_A]);
  assert.deepEqual((await api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => [one.id, one.sha]), [[ID, SHA_B]], "one package per id");
  // A source pinned to a commit (what the console's install page sends, the SHA its preview showed) reads that commit,
  // wherever its branch has moved since.
  const pinned = await api("POST", "/templates/import", { source: `${ID}@${SHA_A}`, dry_run: true });
  assert.deepEqual([pinned.status, pinned.body.template.sha, pinned.body.skill_files["kyb/SKILL.md"] !== undefined], [200, SHA_A, true], JSON.stringify(pinned.body.error ?? {}));

  // A restart loads it again from the store, beside the bundled packages.
  await server.stop();
  const restarted = await serve(t, { data: server.data, templateImportApi: github.url, runner: false });
  assert.deepEqual((await restarted.api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => [one.id, one.sha, one.publisher]), [[ID, SHA_B, "acme"]]);

  assert.equal((await restarted.api("DELETE", "/templates/kyb")).status, 403, "a bundled package can't be removed");
  assert.equal((await restarted.api("DELETE", `/templates/${enc(ID)}`)).status, 204);
  assert.equal((await restarted.api("DELETE", `/templates/${enc(ID)}`)).status, 404);
  assert.equal((await restarted.api("POST", `/templates/${enc(ID)}/apply`, { parameters: {} })).status, 404);
  assert.deepEqual((await restarted.api("GET", `/agents/${applied.body.agent_id}`)).body.template, { id: ID, version: "0.1.0", sha: SHA_A }, "an agent applied from it stays as it is");
});

test("an import is refused, storing nothing: a source off GitHub, a ref GitHub does not have, a redirect off GitHub's hosts, a symbolic or hard link in the package, a special file, and a package that does not check", { timeout: 60_000 }, async (t) => {
  const github = await fauxGitHub(t, { refs: { main: SHA_A, HEAD: SHA_A, link: SHA_B, hard: "c".repeat(40), fifo: "d".repeat(40), broken: "e".repeat(40), linkfirst: "f".repeat(40) } });
  github.tarballs[SHA_B] = tarball([["skills/kyb/escape.md", { type: "2", link: "../../../../../etc/passwd" }]]);
  // A link early in a large tarball (GitHub's are megabytes): the refusal comes while the download is still arriving,
  // and the import answers at once, never waiting on a download nothing reads any more.
  github.tarballs["f".repeat(40)] = tarball([["skills/kyb/escape.md", { type: "2", link: "/etc/passwd" }], ["skills/kyb/zz-big.bin", { data: randomBytes(4 << 20) }]]);
  github.tarballs["c".repeat(40)] = tarball([["rules/HARD.md", { type: "1", link: "acme-agents-aaaaaaa/README.md" }]]);
  github.tarballs["d".repeat(40)] = tarball([["rules/pipe.md", { type: "6" }]]);
  github.tarballs["e".repeat(40)] = tarball([["extra/x.md", { data: Buffer.from("x") }]]);
  const { api } = await serve(t, { templateImportApi: github.url, runner: false });
  const refused = async (body, field, pattern, status = 422) => {
    const answer = await api("POST", "/templates/import", { trust_publisher: true, ...body });
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    if (field) assert.equal(answer.body.error.fields[0].field, field, JSON.stringify(answer.body));
    assert.match(answer.body.error.message, pattern);
  };
  await refused({ source: "https://gitlab.com/acme/agents/-/tree/main/kyb" }, "source", /github\.com alone/);
  await refused({ source: `${ID}@nope` }, "source", /has no ref nope in acme\/agents/);
  await refused({ source: `${ID}@link` }, "package", /skills\/kyb\/escape\.md is a symbolic link/);
  const began = Date.now();
  await refused({ source: `${ID}@linkfirst`, dry_run: true }, "package", /skills\/kyb\/escape\.md is a symbolic link/);
  assert.ok(Date.now() - began < 10_000, `refused at once, in ${Date.now() - began} ms`);
  await refused({ source: `${ID}@hard` }, "package", /rules\/HARD\.md is a hard link/);
  await refused({ source: `${ID}@fifo` }, "package", /rules\/pipe\.md is not a regular file or a folder/);
  await refused({ source: `${ID}@broken` }, "package", /a package's folders are skills\/, rules\/ and evals\//);
  await refused({ source: "github:acme/agents/templates/none@main" }, "source", /has no folder templates\/none/);
  await refused({ source: `${ID}@main`, dry_run: "yes" }, "dry_run", /dry_run is true or false/);
  assert.deepEqual((await api("GET", "/templates")).body.templates.filter((one) => !one.bundled), []);
  assert.ok(!github.seen.some((line) => line.includes("example.invalid")));

  const away = await fauxGitHub(t, { elsewhere: true });
  const second = await serve(t, { templateImportApi: away.url, runner: false });
  const answer = await second.api("POST", "/templates/import", { source: `${ID}@main`, dry_run: true });
  assert.equal(answer.status, 502, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, "github_failed");
  assert.match(answer.body.error.message, /example\.invalid, which is not one of GitHub's own hosts/);
});

test("each read limit refuses the import when passed, and an aborted read ends at once: the download, the unpacked tarball, the package's bytes and its files", { timeout: 60_000 }, async (t) => {
  const { fetchPackageFiles, ImportRefused, parseSource } = await import("../dist/template-source.js");
  const github = await fauxGitHub(t);
  const reach = (limits) => ({ api: github.url, hosts: [new URL(github.url).host], limits });
  const source = parseSource(`${ID}@main`);
  const read = (limits, signal = new AbortController().signal) => fetchPackageFiles(source, SHA_A, reach(limits), signal);
  assert.ok((await read({})).has("agent.md"), "within every limit, the package is read");
  const refused = async (limits, pattern) => {
    const began = Date.now();
    await assert.rejects(read(limits), (error) => error instanceof ImportRefused && pattern.test(error.message), JSON.stringify(limits));
    assert.ok(Date.now() - began < 10_000, `refused at once: ${JSON.stringify(limits)}`);
  };
  await refused({ downloadBytes: 1000 }, /tarball is (\d+ bytes, )?over the 1000/);
  await refused({ unpackedBytes: 20_000 }, /unpacks to over the 20000 bytes/);
  await refused({ packageBytes: 1000 }, /package's files are over the 1000 bytes/);
  await refused({ files: 3 }, /holds over 3 files/);

  // A download that stalls: the request's signal (its close, or the time limit) ends the read, which answers at once.
  const stalled = createServer((req, res) => {
    if (req.url.includes("/tarball/")) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      res.write(tarball().subarray(0, 4096));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => stalled.listen(0, "127.0.0.1", done));
  t.after(() => { stalled.closeAllConnections(); stalled.close(); });
  const url = `http://127.0.0.1:${stalled.address().port}`;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const began = Date.now();
  await assert.rejects(fetchPackageFiles(source, SHA_A, { api: url, hosts: [new URL(url).host] }, stop.signal), ImportRefused);
  assert.ok(Date.now() - began < 5_000, `an aborted read ends at once, in ${Date.now() - began} ms`);
});

test("the store keeps each imported package by id, its files as read: a put replaces the one under its id, and a remove says whether one was there", async (t) => {
  const { store } = await storeOn(t);
  const rows = store.importedTemplates;
  await rows.put({ id: ID, source: `${ID}@main`, sha: SHA_A, publisher: "acme", files: { "agent.md": Buffer.from("---\n").toString("base64") } });
  await rows.put({ id: "github:acme/other", source: "github:acme/other", sha: SHA_A, publisher: "acme", files: {} });
  await rows.put({ id: ID, source: `${ID}@v2`, sha: SHA_B, publisher: "acme", files: { "agent.md": "eA==" } });
  assert.deepEqual((await rows.list()).map(({ importedAt, ...row }) => (assert.equal(typeof importedAt, "number"), row)), [
    { id: "github:acme/agents/templates/kyb", source: `${ID}@v2`, sha: SHA_B, publisher: "acme", files: { "agent.md": "eA==" } },
    { id: "github:acme/other", source: "github:acme/other", sha: SHA_A, publisher: "acme", files: {} },
  ]);
  assert.equal(await rows.remove(ID), true);
  assert.equal(await rows.remove(ID), false);
  assert.deepEqual((await rows.list()).map((row) => row.id), ["github:acme/other"]);
});

test("a server open adds the imported packages' table to a store an earlier build of this schema version made, with no version change", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { DatabaseSync } = await import("node:sqlite");
  const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
  const dir = mkdtempSync(join(tmpdir(), "agentrun-imported-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.db");
  await (await openSqliteStore({ file, role: "server" })).close();
  const raw = new DatabaseSync(file);
  const version = raw.prepare("SELECT schema_version FROM store_meta").get().schema_version;
  raw.exec("DROP TABLE imported_templates");
  raw.close();
  const reopened = await openSqliteStore({ file, role: "server" });
  t.after(() => reopened.close());
  await reopened.importedTemplates.put({ id: ID, source: ID, sha: SHA_A, publisher: "acme", files: {} });
  assert.deepEqual((await reopened.importedTemplates.list()).map((row) => row.id), [ID]);
  const after = new DatabaseSync(file, { readOnly: true });
  assert.equal(after.prepare("SELECT schema_version FROM store_meta").get().schema_version, version, "the version is unchanged");
  after.close();
});
