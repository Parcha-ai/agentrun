// `serveHome` and the `pi-durable-agent` bin: a local page over an agent home, read straight from its SQLite files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports as syncExports } from "node:module";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentHomeError, readAgentHome, setAlias, setBindings, setPrompts, startRun } from "../dist/index.js";
import { agentReader, openReadOnly, signature } from "../dist/serve/read.js";
import { serveHome } from "../dist/serve/index.js";
import { main as serveMain } from "../dist/serve/command.js";
import { buildSignedInHome, PRACTICE_ORIGIN, SIGN_IN_MARKER, signedInHomeSkip } from "./fixtures/signed-in-home.mjs";
import { scratch } from "./support.mjs";

const skip = { skip: signedInHomeSkip, timeout: 60_000 };
const CLI = fileURLToPath(new URL("../dist/serve/cli.js", import.meta.url));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
const SECRET_KINDS = ["browser.profiles", "agent.vault", "agent.leases", "agent.bindings", "agent.aliases"];
const SIDE = ["-wal", "-shm", "-journal"];

/** Every file and directory under `dir` with what a read could change: size, mtime and a hash of the bytes. */
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).map((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    const info = statSync(file);
    return { path: path.relative(dir, file), dir: entry.isDirectory(), size: entry.isDirectory() ? 0 : info.size, mtimeMs: info.mtimeMs, sha: entry.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : "" };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** One request with the Host header chosen by the caller (fetch refuses to set it); an empty `host` sends none. */
function request(url, { method = "GET", host, target = "/" } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: target, method, setHost: host === undefined, headers: host === undefined || host === "" ? {} : { host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const hasSideFiles = (file) => SIDE.some((suffix) => existsSync(`${file}${suffix}`));

/** Every file under `dir` that is not one of SQLite's side files, with size, mtime and a hash: the main databases, and the home's other files. */
const files = (dir) => snapshot(dir).filter((entry) => !entry.dir && !SIDE.some((suffix) => entry.path.endsWith(suffix)));

/** Every row of the tables a store keeps its documents and entries in, from an independent read-only connection. */
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(["documents", "document_revisions", "entries"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((row) => ({ ...row }))]));
  } finally {
    db.close();
  }
}

/** The fixture's signed-in home plus a host's alias and bindings, a second run that holds the sign-in's lease, and a run
 *  store with a few entries, so every kind a viewer must never see is present with a value that is easy to search for. */
async function seededHome() {
  const dir = await scratch();
  const built = await buildSignedInHome(dir);
  await setPrompts(built.home, [
    { id: "kind", role: "question", label: "Kind", text: "What kind of organisation is it?", criteria: { gone: "A variant that is about to be retired.", other: "Anything else." } },
    { id: "generic", role: "generic", label: "Generic", text: "Say what the page shows." },
    { id: "gone", role: "overlay", label: "Gone", text: "A variant that is retired by the next set.", when: { question: "kind", option: "gone", threshold: 0.8 } },
    { id: "base", role: "base", label: "Base", text: "Read the practice site." },
  ]);
  await setPrompts(built.home, [
    { id: "kind", role: "question", label: "Kind", text: "What kind of organisation is it?", criteria: { public: "Its shares trade publicly.", other: "Anything else." } },
    { id: "generic", role: "generic", label: "Generic", text: "Say what the page shows." },
    { id: "public", role: "overlay", label: "Public", text: "Start with the filings.", when: { question: "kind", option: "public", threshold: 0.8 } },
    { id: "base", role: "base", label: "Base", text: "Read the practice site." },
  ]);
  await setAlias(built.home, "other-host", "ALIAS-MARKER-4471");
  await setBindings(built.home, "other-host", { browser: "BINDING-MARKER-4471" });
  const holder = await startRun(built.home, { runId: "holder", host: "other-host", leaseMs: 7_654_321, prompt: { id: "generic", reason: "no overlay applies", confidence: 0.4 } });
  const state = await readAgentHome(built.home);
  return { ...built, dir, holder, state };
}

function insertEntries(storePath, count, { from = 1, pause = 0 } = {}) {
  const db = new DatabaseSync(storePath, { timeout: 10_000 });
  try {
    const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, ?, ?)");
    for (let n = from; n < from + count; n++) {
      insert.run(n, n, JSON.stringify({ id: n, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: `message ${n}`, timestamp: Date.UTC(2026, 9, 22, 12, 0, n % 60) }] }));
      if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
    }
  } finally {
    db.close();
  }
}

/** An assistant entry that calls a tool and never gets a result: the call is open. */
function insertOpenCall(storePath, id) {
  const db = new DatabaseSync(storePath, { timeout: 10_000 });
  try {
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, ?, ?)").run(id, id, JSON.stringify({
      id, conversationId: 1, kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: "notes.md" } }], stopReason: "toolUse", usage: { cost: { total: 0.01 } }, timestamp: Date.UTC(2026, 9, 22, 12, 0, 0) }],
    }));
  } finally {
    db.close();
  }
}

test("a full serve session leaves every main database file byte-identical and no row changed, and the handle it reads through cannot write", skip, async () => {
  const seeded = await seededHome();
  const stores = [path.join(seeded.home.dir, "agent.sqlite"), seeded.runStore, seeded.holder.storePath];
  insertEntries(seeded.holder.storePath, 3);
  const [before, rowsBefore] = [files(seeded.home.dir), stores.map(rows)];
  const tmp = await scratch();
  const kept = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const served = await serveHome(seeded.home);
  try {
    for (const target of ["/", "/page.css", "/page.js", "/api/agent", "/api/runs", `/api/runs/${seeded.runId}`, "/api/runs/holder", "/nope"]) await request(served.url, { target });
    await request(served.url, { method: "POST", target: "/api/agent" });
  } finally {
    await served.close();
    if (kept === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = kept;
  }
  assert.deepEqual(files(seeded.home.dir), before, "no file but a SQLite side file changed or was added, and no mtime moved: the main databases are byte-identical");
  assert.deepEqual(stores.map(rows), rowsBefore, "no document, revision or entry row changed");
  assert.deepEqual(readdirSync(tmp), [], "the snapshot's directory is gone");
  for (const store of stores) {
    const db = openReadOnly(store);
    try {
      assert.throws(() => db.exec("CREATE TABLE intruder (a)"), /readonly/i);
      assert.throws(() => db.exec("DELETE FROM durable_metadata"), /readonly/i);
    } finally {
      db.close();
    }
  }
  assert.deepEqual(files(seeded.home.dir), before, "opening and failing to write changed nothing either");
});

test("a store with a writer behind it is read through its log: the handle still cannot write, and the main file and the log are not touched", skip, async () => {
  const seeded = await seededHome();
  const writer = new DatabaseSync(seeded.holder.storePath);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(hasSideFiles(seeded.holder.storePath), true, "the writer's open made the side files");
    const bytes = (suffix = "") => readFileSync(`${seeded.holder.storePath}${suffix}`);
    const [main, wal] = [bytes(), bytes("-wal")];
    const db = openReadOnly(seeded.holder.storePath);
    try {
      assert.throws(() => db.exec("CREATE TABLE intruder (a)"), /readonly/i);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get().n, 0);
    } finally {
      db.close();
    }
    assert.ok(main.equals(bytes()) && wal.equals(bytes("-wal")), "reading wrote neither the main file nor the log");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("no response holds a saved sign-in, session, lease, binding or alias: their values, their kinds, or their file", skip, async () => {
  const seeded = await seededHome();
  const secrets = [
    SIGN_IN_MARKER, PRACTICE_ORIGIN, "ALIAS-MARKER-4471", "BINDING-MARKER-4471", "vault.keys", "ciphertext", ...SECRET_KINDS,
    ...Object.values(seeded.state.leases).map((lease) => lease.expiresAt),
    ...Object.values(seeded.state.profiles).flatMap((profile) => [profile.ref, profile.provider]).filter(Boolean),
    ...Object.values(await vaultRecords(seeded.home.dir)).flatMap((record) => [record.keyId, record.iv]),
  ];
  assert.ok(secrets.length > 10, "the home really has them");
  for (const secret of secrets) assert.ok(String(secret).length >= 8, `${String(secret)} is long enough to search for`);
  const served = await serveHome(seeded.home);
  try {
    const bodies = [];
    for (const target of ["/", "/page.css", "/page.js", "/api/agent", "/api/runs", `/api/runs/${seeded.runId}`, "/api/runs/holder", "/api/runs/none", "/vault.keys", "/agent.sqlite", "/api/vault", "/api/leases"]) {
      const res = await request(served.url, { target });
      bodies.push(`${res.status} ${JSON.stringify(res.headers)} ${res.body}`);
    }
    const everything = bodies.join("\n");
    for (const secret of secrets) assert.ok(!everything.includes(String(secret)), `a response holds ${String(secret)}`);
    assert.ok(everything.includes("Signed-in fixture"), "and the agent itself is there");
  } finally {
    await served.close();
  }
});

async function vaultRecords(dir) {
  const db = new DatabaseSync(`file:${path.join(dir, "agent.sqlite")}?mode=ro&immutable=1`, { readOnly: true });
  try {
    const found = {};
    for (const { id, key_value: key } of db.prepare("SELECT id, key_value FROM documents WHERE kind = ?").all(JSON.stringify("agent.vault"))) {
      found[JSON.parse(key)] = JSON.parse(db.prepare("SELECT content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(id).content);
    }
    return found;
  } finally {
    db.close();
  }
}

test("the agent view holds only what an export may carry, is read from a snapshot that is removed, and is re-read only when the store's files change", skip, async () => {
  const seeded = await seededHome();
  const tmp = await scratch();
  const kept = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const made = [];
  const mkdtemp = fsp.mkdtemp;
  fsp.mkdtemp = (...args) => (made.push(String(args[0])), mkdtemp(...args));
  syncExports();
  try {
    const read = agentReader(seeded.home.dir);
    const view = await read();
    assert.deepEqual(Object.keys(view).sort(), ["definition", "identity", "prompts", "runs", "skills", "source"], "no leases, profiles, bindings, aliases or vault: not even by name");
    assert.deepEqual(made.length, 1);
    assert.match(made[0], /pi-durable-agent-serve-$/);
    assert.deepEqual(readdirSync(tmp), [], "the snapshot's directory is removed once it is read");
    assert.equal(await read(), view, "the same files give the same view, without a second snapshot");
    assert.equal(made.length, 1);
    await setPrompts(seeded.home, [{ id: "base", role: "base", label: "Base", text: "Changed." }, { id: "generic", role: "generic", label: "Generic", text: "Also." }]);
    const changed = await read();
    assert.notEqual(changed, view, "a change to the store is a new snapshot");
    assert.deepEqual(changed.prompts.map((prompt) => prompt.id), ["base", "generic"]);
    assert.equal(made.length, 2);
    assert.deepEqual(readdirSync(tmp), []);
    const broken = agentReader(path.join(seeded.dir, "nowhere"));
    await assert.rejects(broken(), (error) => error instanceof AgentHomeError && error.code === "missing");
    await assert.rejects(broken(), AgentHomeError, "a failed read is not cached");
    assert.equal(made.length, 4);
    assert.deepEqual(readdirSync(tmp), [], "a failed read removes its directory too");
  } finally {
    fsp.mkdtemp = mkdtemp;
    syncExports();
    if (kept === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = kept;
  }
});

test("the server snapshots the agent store once for requests that change nothing, and again after a change", skip, async () => {
  const seeded = await seededHome();
  const tmp = await scratch();
  const kept = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const made = [];
  const mkdtemp = fsp.mkdtemp;
  fsp.mkdtemp = (...args) => (String(args[0]).endsWith("pi-durable-agent-serve-") && made.push(1), mkdtemp(...args));
  syncExports();
  const served = await serveHome(seeded.home);
  try {
    for (const target of ["/api/agent", "/api/runs", "/api/runs/holder", "/api/runs/holder", "/api/agent"]) assert.equal((await request(served.url, { target })).status, 200, target);
    assert.equal(made.length, 1, "five requests, one snapshot");
    await startRun(seeded.home, { runId: "another", host: "h" });
    const runs = JSON.parse((await request(served.url, { target: "/api/runs" })).body);
    assert.ok(runs.some((run) => run.id === "another"), "a change to the home is served");
    assert.equal(made.length, 2);
  } finally {
    await served.close();
    fsp.mkdtemp = mkdtemp;
    syncExports();
    if (kept === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = kept;
  }
});

test("what says a store changed: its size and mtime, and its log's", async () => {
  const dir = await scratch();
  const file = path.join(dir, "store.sqlite");
  assert.equal(signature(file), "none|none");
  writeFileSync(file, "a");
  const first = signature(file);
  writeFileSync(`${file}-wal`, "");
  assert.equal(signature(file), first, "an empty log is nothing: opening a store read-only leaves one");
  writeFileSync(`${file}-wal`, "w");
  const withLog = signature(file);
  assert.notEqual(withLog, first, "commits in the log are a change");
  writeFileSync(`${file}-wal`, "ww");
  assert.notEqual(signature(file), withLog, "a commit into the log is a change");
  assert.equal(signature(file), signature(file), "and nothing changing is none");
  writeFileSync(file, "ab");
  assert.notEqual(signature(file), withLog.replace(/^[^|]*/, ""), "the main file counts too");
});

test("a run read while another process appends to it: every response is a whole snapshot, and the rows only grow", skip, async () => {
  const seeded = await seededHome();
  const store = seeded.holder.storePath;
  const total = 400;
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { timeout: 10000 });
    const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, ?, ?)");
    for (let n = 1; n <= ${total}; n++) {
      insert.run(n, n, JSON.stringify({ id: n, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "message " + n, timestamp: Date.UTC(2026, 9, 22, 12, 0, n % 60) }] }));
      if (n === 1) console.log("started");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    db.close();
    console.log("done");
  `, store], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = [];
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  child.stdout.on("data", (chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    if (lines.includes("done")) finished();
  });
  const served = await serveHome(seeded.home);
  try {
    while (!lines.includes("started")) await new Promise((resolve) => setTimeout(resolve, 5));
    let last = 0;
    let reads = 0;
    let partial = 0;
    const lengths = new Set();
    while (!lines.includes("done")) {
      const res = await request(served.url, { target: "/api/runs/holder" });
      assert.equal(res.status, 200, res.body);
      const { run, rows } = JSON.parse(res.body);
      assert.equal(run.live, true);
      assert.ok(rows.length >= last, `rows went from ${last} to ${rows.length}`);
      rows.forEach((row, at) => assert.equal(row.summary, `You: message ${at + 1}`, "the rows are the first n entries, in order, none half written"));
      if (rows.length < total) partial++;
      lengths.add(rows.length);
      last = rows.length;
      reads++;
    }
    await done;
    const final = JSON.parse((await request(served.url, { target: "/api/runs/holder" })).body);
    assert.equal(final.rows.length, total, "every entry the other process appended is there once it is done");
    assert.ok(reads > 3 && partial > 0, `the reads (${reads}) overlapped the appends (${partial} saw a partial run)`);
    assert.ok(lengths.size > 3, `the reader saw the writer's commits as they landed (${lengths.size} different lengths)`);
  } finally {
    await served.close();
    child.kill();
  }
});

test("a foreign Host, another port, a POST and a path out of the home are all refused, and every answer carries the security headers", skip, async () => {
  const seeded = await seededHome();
  const served = await serveHome(seeded.home);
  try {
    const { port } = new URL(served.url);
    assert.equal(served.url, `http://127.0.0.1:${port}/`);
    assert.equal((await request(served.url, { host: `127.0.0.1:${port}`, target: "/api/agent" })).status, 200);
    assert.equal((await request(served.url, { host: `localhost:${port}`, target: "/api/agent" })).status, 200);
    assert.equal((await request(served.url, { host: `LOCALHOST:${port}`, target: "/api/agent" })).status, 200, "a Host is case-insensitive");
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `localhost.evil.example:${port}`, `127.0.0.1:${port}.evil.example`, `[::1]:${port}`]) {
      const res = await request(served.url, { host, target: "/api/agent" });
      assert.equal(res.status, 421, `Host ${JSON.stringify(host)}`);
      assert.doesNotMatch(res.body, /Signed-in/, "a refused request gets no data");
    }
    const none = await request(served.url, { host: "", target: "/api/agent" });
    assert.ok([400, 421].includes(none.status) && !none.body.includes("Signed-in"), `no Host at all is refused (${none.status})`);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await request(served.url, { method, target: "/api/agent" });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "GET, HEAD");
    }
    assert.equal((await request(served.url, { method: "POST", host: "evil.example", target: "/api/agent" })).status, 421, "the Host is judged first");
    const head = await request(served.url, { method: "HEAD", target: "/api/agent" });
    assert.deepEqual([head.status, head.body], [200, ""]);
    for (const target of ["/api/runs/..%2f..%2fagent.sqlite", "/api/runs/a%00b", "/api/runs/-x", "/api/runs/.hidden-not-an-id-.", `/api/runs/${"a".repeat(129)}`, "/api/runs/%2fetc%2fpasswd"]) {
      const res = await request(served.url, { target });
      assert.equal(res.status, 400, `${target} is not a run id`);
      assert.match(JSON.parse(res.body).error, /run id/);
    }
    for (const target of ["/api/runs/%2e%2e", "/api/runs/a/b", "/api/runs/"]) assert.equal((await request(served.url, { target })).status, 404, target);
    assert.equal((await request(served.url, { target: "/api/runs/constructor" })).status, 404, "a name like an Object property is not a run");
    assert.equal((await request(served.url, { target: "/api/runs/toString" })).status, 404);
    assert.equal((await request(served.url, { target: "/api/runs/none" })).status, 404);
    for (const target of ["//evil.example/api/agent", "//", "api/agent", "http://evil.example/api/agent", "*"]) assert.equal((await request(served.url, { target })).status, 400, `${target} is not a path`);
    assert.equal((await request(served.url, { target: "/../../etc/passwd" })).status, 404);
    for (const target of ["/", "/page.css", "/page.js", "/api/agent", "/api/runs", "/api/runs/none", "/missing"]) {
      const res = await request(served.url, { target });
      assert.equal(res.headers["content-security-policy"], CSP, target);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.deepEqual(Object.keys(res.headers).filter((name) => name.startsWith("access-control-")), [], "no CORS header: a page on another origin cannot read it");
    }
    assert.match((await request(served.url, { target: "/api/agent" })).headers["content-type"], /^application\/json; charset=utf-8$/);
    assert.match((await request(served.url, { target: "/" })).headers["content-type"], /^text\/html/);
    const outside = Object.values(os.networkInterfaces()).flat().find((address) => address && address.family === "IPv4" && !address.internal);
    if (outside) {
      const refused = await new Promise((resolve) => {
        const socket = net.connect({ host: outside.address, port: Number(port) });
        socket.once("connect", () => (socket.destroy(), resolve("connected")));
        socket.once("error", (error) => resolve(error.code));
      });
      assert.equal(refused, "ECONNREFUSED", "the server is not on this machine's other addresses");
    }
  } finally {
    await served.close();
  }
});

test("serveHome refuses what is not a home or a port, ignores a host option, and closes on abort", skip, async (t) => {
  const seeded = await seededHome();
  await assert.rejects(serveHome({ dir: path.join(seeded.dir, "nowhere") }), (error) => error instanceof AgentHomeError && error.code === "missing");
  for (const port of [-1, 65_536, 1.5, "80", Number.NaN]) await assert.rejects(serveHome(seeded.home, { port }), (error) => error instanceof AgentHomeError && error.code === "invalid", String(port));
  const controller = new AbortController();
  const served = await serveHome(seeded.home, { host: "0.0.0.0", signal: controller.signal });
  t.after(() => served.close());
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await request(served.url, { target: "/api/agent" })).status, 200);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(request(served.url, { target: "/api/agent" }), (error) => error.code === "ECONNREFUSED");
  await served.close();
  const aborted = new AbortController();
  aborted.abort();
  const never = await serveHome(seeded.home, { signal: aborted.signal });
  t.after(() => never.close());
  await assert.rejects(request(never.url, { target: "/" }), (error) => error.code === "ECONNREFUSED", "an aborted signal closes it at once");
});

test("the API's shapes: the agent, the runs newest first, a run's rows, and what a bad store says", skip, async () => {
  const seeded = await seededHome();
  insertEntries(seeded.holder.storePath, 3);
  insertOpenCall(seeded.holder.storePath, 10);
  insertOpenCall(seeded.runStore, 1);
  const served = await serveHome(seeded.home);
  try {
    const agent = JSON.parse((await request(served.url, { target: "/api/agent" })).body);
    assert.deepEqual(Object.keys(agent).sort(), ["counts", "definition", "identity", "prompts", "skills", "source"]);
    assert.deepEqual([agent.identity.name, agent.identity.formatVersion], ["Signed-in fixture", 1]);
    assert.deepEqual(agent.skills.map(({ path: file, size }) => [file, size]), [["practice/SKILL.md", Buffer.byteLength("# Practice\n\nSign in, then read the page.\n")]]);
    assert.match(agent.skills[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal("content" in agent.skills[0], false, "a skill's text is not sent");
    assert.deepEqual(agent.prompts.map((prompt) => [prompt.id, prompt.role]), [["base", "base"], ["public", "overlay"], ["generic", "generic"], ["kind", "question"]], "base, overlays, generic, then the question");
    assert.deepEqual(agent.prompts[1].when, { question: "kind", option: "public", threshold: 0.8 });
    assert.deepEqual(agent.prompts[3].criteria, { public: "Its shares trade publicly.", other: "Anything else." });
    assert.equal(agent.source, null);
    assert.deepEqual(agent.counts, { skills: 1, prompts: 3, questions: 1, runs: 2, live: 1 }, "prompts counts the variants; the question is counted on its own");

    const runs = JSON.parse((await request(served.url, { target: "/api/runs" })).body);
    assert.deepEqual(runs.map((run) => [run.id, run.live]), [["holder", true], ["signed-in", false]], "newest first");
    const done = runs.find((run) => run.id === "signed-in");
    assert.deepEqual(Object.keys(done).sort(), ["endedAt", "id", "live", "outcome", "prompt", "startedAt"], "no host, no path, no final answer");
    assert.deepEqual(done.prompt, { id: "generic", reason: "no overlay applies" });
    assert.equal(done.outcome, "completed");
    assert.deepEqual(runs.find((run) => run.id === "holder").prompt, { id: "generic", reason: "no overlay applies", confidence: 0.4 }, "a recorded confidence is served");

    const live = JSON.parse((await request(served.url, { target: "/api/runs/holder" })).body);
    assert.equal(live.run.live, true);
    assert.deepEqual(live.rows.slice(0, 3).map((row) => [row.kind, row.summary]), [["user_message", "You: message 1"], ["user_message", "You: message 2"], ["user_message", "You: message 3"]]);
    assert.deepEqual(live.rows.slice(3).map((row) => row.kind), ["tool_use", "usage"], "a live run's open call is running: no result row");
    const ended = JSON.parse((await request(served.url, { target: `/api/runs/${seeded.runId}` })).body);
    assert.deepEqual(ended.rows.map((row) => row.kind), ["tool_use", "tool_result", "usage"], "an ended run's open call is settled");
    assert.deepEqual([ended.rows[1].tool_status, ended.rows[1].summary], ["failed", "Read notes.md interrupted"]);
    assert.equal(ended.run.id, "signed-in");

    const missing = await request(served.url, { target: "/api/runs/none" });
    assert.deepEqual([missing.status, JSON.parse(missing.body)], [404, { error: "no such run" }]);
  } finally {
    await served.close();
  }
});

test("a run's store that is a link out of the home is not read", skip, async () => {
  const seeded = await seededHome();
  const outside = path.join(await scratch(), "elsewhere");
  mkdirSync(outside);
  cpSync(seeded.holder.storePath, path.join(outside, "run.sqlite"));
  renameSync(path.join(seeded.holder.dir, "store"), path.join(seeded.holder.dir, "store.moved"));
  symlinkSync(outside, path.join(seeded.holder.dir, "store"));
  const served = await serveHome(seeded.home);
  try {
    const res = await request(served.url, { target: "/api/runs/holder" });
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error, /not inside the home/);
    assert.equal((await request(served.url, { target: "/api/runs/signed-in" })).status, 200, "the other runs are read");
  } finally {
    await served.close();
  }
});

test("a store that is not a store, or one from a newer pi-durable, is a plain 500 that does not say where it is", skip, async () => {
  const seeded = await seededHome();
  const served = await serveHome(seeded.home);
  try {
    const db = new DatabaseSync(seeded.holder.storePath);
    db.exec("UPDATE durable_schema SET version = 2");
    db.close();
    const newer = await request(served.url, { target: "/api/runs/holder" });
    assert.equal(newer.status, 500);
    assert.match(JSON.parse(newer.body).error, /pi-durable schema 2; this version reads 1/);
    assert.ok(!newer.body.includes(seeded.dir), "no path in the answer");
    const agent = new DatabaseSync(path.join(seeded.home.dir, "agent.sqlite"));
    agent.exec("UPDATE durable_schema SET version = 3");
    agent.close();
    const refused = await request(served.url, { target: "/api/agent" });
    assert.equal(refused.status, 500);
    assert.match(JSON.parse(refused.body).error, /schema 3/);
  } finally {
    await served.close();
  }
});

test("the pi-durable-agent bin prints a loopback address for a home, serves it, and stops on SIGINT", skip, async (t) => {
  const seeded = await seededHome();
  const before = files(seeded.home.dir);
  const run = (args) => spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const child = run(["serve", seeded.home.dir]);
  const fixed = run(["serve", seeded.home.dir, "--port", "0"]);
  t.after(() => [child, fixed].forEach((process) => process.kill()));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  while (!out.includes("\n")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(out, /^http:\/\/127\.0\.0\.1:\d+\/\n$/, "one line: the address, nothing opened");
  const url = out.trim();
  assert.equal(JSON.parse((await request(url, { target: "/api/agent" })).body).identity.name, "Signed-in fixture");
  child.kill("SIGINT");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(err, "");
  assert.deepEqual(files(seeded.home.dir), before, "the bin changed nothing in the home but SQLite's side files");

  await new Promise((resolve) => fixed.stdout.once("data", resolve));
  fixed.kill("SIGTERM");
  assert.equal((await new Promise((resolve) => fixed.once("exit", (code) => resolve(code)))), 0);
});

test("the bin says what is wrong: a missing home is exit 1, a bad command or port is exit 2 with the usage", skip, async () => {
  const exit = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let [out, err] = ["", ""];
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.once("exit", (code) => resolve({ code, out, err }));
  });
  const missing = await exit(["serve", path.join(await scratch(), "none")]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /is not an agent home/);
  assert.equal(missing.out, "");
  for (const args of [[], ["serve"], ["show", "x"], ["serve", "x", "--port", "99999"], ["serve", "x", "--port", "abc"], ["serve", "x", "y"], ["serve", "x", "--nope"]]) {
    const result = await exit(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, /usage: pi-durable-agent serve <dir> \[--port <n>\]/);
  }
  const help = await exit(["--help"]);
  assert.deepEqual([help.code, /usage: pi-durable-agent serve/.test(help.out)], [0, true]);
});

test("the package says it has a bin and a ./serve entry, and the bin starts with a shebang", { timeout: 60_000 }, () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.bin, { "pi-durable-agent": "./dist/serve/cli.js" });
  assert.deepEqual(manifest.exports["./serve"], { types: "./dist/serve/index.d.ts", default: "./dist/serve/index.js" });
  assert.ok(readFileSync(CLI, "utf8").startsWith("#!/usr/bin/env node\n"));
  for (const file of ["page.html", "page.css", "page.js"]) assert.ok(existsSync(new URL(`../dist/serve/${file}`, import.meta.url)), `the build copies ${file}`);
  assert.match(readFileSync(new URL("../dist/serve/page.html", import.meta.url), "utf8"), /<link rel="stylesheet" href="\/?page\.css">[\s\S]*<script src="\/?page\.js"[^>]*><\/script>/);
});

test("an interrupt while the server is still starting stops it: main returns 0 and prints no address", { timeout: 60_000 }, async () => {
  const dir = await scratch();
  writeFileSync(path.join(dir, "agent.sqlite"), "");
  const within = async (promise) => {
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve("still running"), 3_000)));
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const early of [false, true]) {
    const stop = new AbortController();
    if (early) stop.abort();
    const out = [];
    const ran = serveMain(["serve", dir], { out: (line) => out.push(line), err: (line) => out.push(line), signal: stop.signal });
    stop.abort();
    assert.equal(await within(ran), 0, early ? "a signal already aborted" : "a signal aborted during startup");
    assert.deepEqual(out, []);
  }
});
