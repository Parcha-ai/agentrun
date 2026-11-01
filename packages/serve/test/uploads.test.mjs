// Uploads: POST /v2/files reserves a file, PUT /v2/files/{file_id} sends its bytes (streamed, checked against the
// reservation), and a run's file_ids are copied into its work/inputs/ before its process starts. The console's session
// sends the bytes as any content type, from the page's own origin only.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ROUTES, takesBytes } from "../dist/server.js";
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, pathProblem, suffixed } from "../dist/uploads.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, cookieOf, follow, scratch, serve } from "./support.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A PUT of `chunks` (a Buffer, or Buffers written one after another) to `path` on the server at `port`. */
function put(port, path, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "PUT", path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    (async () => {
      for (const chunk of Buffer.isBuffer(chunks) ? [chunks] : chunks) if (!req.write(chunk)) await new Promise((done) => req.once("drain", done));
      req.end();
    })().catch(reject);
  });
}

/** The server's token as a Bearer header. */
const bearer = (server) => ({ authorization: `Bearer ${server.token}` });

/** A file reserved and sent with the server's token: its ready File. */
async function upload(server, path, bytes, extra = {}) {
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length, ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await put(server.port, `/v2${made.body.upload.url}`, bytes, { ...bearer(server), "content-type": "application/octet-stream" });
  assert.equal(sent.status, 200, sent.text);
  return sent.json;
}

const fileList = async (api, runId) => {
  const list = await api("GET", `/runs/${runId}/files`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  return list.body.files;
};

test("reserve, then send the bytes: pending, then ready, binary-safe, kept 0600 under files/<id>/, the answers the contract's", async (t) => {
  const server = await serve(t);
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  const check = (name, value) => assert.deepEqual(schemaProblems(doc, { $ref: `#/components/schemas/${name}` }, value), [], `${name}: ${JSON.stringify(value)}`);
  // Every byte value, then random ones.
  const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(70_000)]);
  const made = await server.api("POST", "/files", { path: "data/blob.bin", size_bytes: bytes.length, content_type: "application/x-test" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  check("FileUpload", made.body);
  const { file, upload: where } = made.body;
  assert.match(file.file_id, UUID7, "a UUIDv7, as the store mints agent and run ids");
  assert.deepEqual({ ...file, file_id: undefined, created_at: undefined }, { file_id: undefined, path: "data/blob.bin", size_bytes: bytes.length, content_type: "application/x-test", sha256: null, status: "pending", created_at: undefined, expires_at: null });
  assert.deepEqual([where.method, where.url], ["PUT", `/files/${file.file_id}`], "relative to the server URL, /v2");
  assert.ok(Date.parse(where.expires_at) > Date.parse(file.created_at));
  const sent = await put(server.port, `/v2${where.url}`, [bytes.subarray(0, 1000), bytes.subarray(1000)], { ...bearer(server), "content-type": "application/octet-stream" });
  assert.equal(sent.status, 200, sent.text);
  check("File", sent.json);
  assert.deepEqual(sent.json, { ...file, sha256: sha(bytes), status: "ready" });
  const dir = join(server.data, "files", file.file_id);
  assert.deepEqual((await readdir(dir)).sort(), ["bytes", "file.json"], "no temporary file left");
  assert.ok((await readFile(join(dir, "bytes"))).equals(bytes), "the bytes as sent");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "file.json"), "utf8")), sent.json);
  for (const name of ["bytes", "file.json"]) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  // A content type is optional; with none the file is octet-stream. A reservation is a create: Idempotency-Key replays it.
  const once = await server.api("POST", "/files", { path: "empty.txt", size_bytes: 0 }, { "idempotency-key": "k1" });
  const again = await server.api("POST", "/files", { path: "empty.txt", size_bytes: 0 }, { "idempotency-key": "k1" });
  assert.deepEqual([once.status, again.status, again.headers.get("idempotent-replayed")], [201, 201, "true"]);
  assert.equal(again.body.file.file_id, once.body.file.file_id);
  assert.equal(once.body.file.content_type, "application/octet-stream");
  const empty = await put(server.port, `/v2/files/${once.body.file.file_id}`, Buffer.alloc(0), bearer(server));
  assert.deepEqual([empty.status, empty.json.status, empty.json.sha256], [200, "ready", sha(Buffer.alloc(0))], "an empty file, with no content type sent");
});

test("a reservation is checked as the contract's FileCreate: 422 by field, 400 for a path that is not a file path, 413 over the limit", async (t) => {
  const { api } = await serve(t);
  const refused = async (body, status, code) => {
    const answer = await api("POST", "/files", body);
    assert.deepEqual([answer.status, answer.body.error?.code], [status, code], JSON.stringify(body));
    return answer.body.error;
  };
  assert.deepEqual((await refused({ size_bytes: 1 }, 422, "input_invalid")).fields.map((f) => [f.field, f.reason]), [["path", "missing"]]);
  assert.deepEqual((await refused({ path: "a", size_bytes: -1, sha256: "ABC", extra: 1 }, 422, "input_invalid")).fields.map((f) => [f.field, f.reason]), [["extra", "not_allowed"], ["size_bytes", "wrong_type"], ["sha256", "bad_format"]]);
  for (const path of ["/abs.txt", "a//b.txt", "a/", "../up.txt", "a/./b", ".hidden", "a/.git/config", "back\\slash", "nul\0", "x".repeat(256), "a".repeat(1025)]) await refused({ path, size_bytes: 1 }, 400, "invalid_file_path");
  const over = await refused({ path: "big.bin", size_bytes: MAX_UPLOAD_BYTES + 1 }, 413, "payload_too_large");
  assert.deepEqual(over.details, { limit: "max_upload_bytes" });
  assert.equal((await api("POST", "/files", { path: "max.bin", size_bytes: MAX_UPLOAD_BYTES })).status, 201, "the limit itself is taken");
  assert.equal((await api("POST", "/files", { path: "folders/keep/their/names.txt", size_bytes: 1 })).status, 201);
});

test("a PUT is checked against its reservation: over the limit 413, a wrong length or hash 422 at the field, the same bytes again change nothing, other bytes are 422, an unknown file 404", async (t) => {
  const server = await serve(t);
  const { api, port } = server;
  const hello = Buffer.from("hello");
  const made = (await api("POST", "/files", { path: "a.txt", size_bytes: 5, sha256: sha(hello) })).body.file;
  const at = `/v2/files/${made.file_id}`;
  const record = async () => JSON.parse(await readFile(join(server.data, "files", made.file_id, "file.json"), "utf8"));
  const field = (answer) => [answer.status, answer.json?.error?.code, answer.json?.error?.fields?.map((f) => f.field)];
  assert.deepEqual(field(await put(port, at, Buffer.from("hell"), bearer(server))), [422, "input_invalid", ["size_bytes"]], "short");
  assert.deepEqual(field(await put(port, at, Buffer.from("hello!"), bearer(server))), [422, "input_invalid", ["size_bytes"]], "long");
  assert.deepEqual(field(await put(port, at, Buffer.from("jello"), bearer(server))), [422, "input_invalid", ["sha256"]], "the reserved hash");
  // Over the limit, streamed: read to its end and refused, only the reserved length ever written.
  const mib = Buffer.alloc(2 ** 20);
  const huge = await put(port, at, [...Array.from({ length: MAX_UPLOAD_BYTES / mib.length }, () => mib), Buffer.from("x")], bearer(server));
  assert.deepEqual([huge.status, huge.json.error.code, huge.json.error.details], [413, "payload_too_large", { limit: "max_upload_bytes" }]);
  assert.equal((await record()).status, "pending", "every refusal leaves the file pending");
  assert.deepEqual(await readdir(join(server.data, "files", made.file_id)), ["file.json"], "and no bytes, temporary or not");
  const sent = await put(port, at, hello, bearer(server));
  assert.deepEqual([sent.status, sent.json.status], [200, "ready"]);
  // Ready: the same bytes again are a no-op; any others are refused, and the bytes stay.
  const same = await put(port, at, hello, bearer(server));
  assert.deepEqual([same.status, same.json], [200, sent.json]);
  assert.deepEqual(field(await put(port, at, Buffer.from("world"), bearer(server))), [422, "input_invalid", ["sha256"]]);
  assert.deepEqual(field(await put(port, at, Buffer.from("hello, world"), bearer(server))), [422, "input_invalid", ["size_bytes"]]);
  assert.equal(await readFile(join(server.data, "files", made.file_id, "bytes"), "utf8"), "hello");
  // With no hash reserved, a ready file is checked against its own: other bytes of the same length are refused too.
  const plain = await upload(server, "b.txt", Buffer.from("abc"));
  assert.equal(plain.sha256, sha(Buffer.from("abc")));
  assert.deepEqual(field(await put(port, `/v2/files/${plain.file_id}`, Buffer.from("xyz"), bearer(server))), [422, "input_invalid", ["sha256"]]);
  // Two PUTs at once with other bytes: one makes it ready, the other is checked against it.
  const raced = (await api("POST", "/files", { path: "c.txt", size_bytes: 3 })).body.file;
  const both = await Promise.all(["aaa", "bbb"].map((text) => put(port, `/v2/files/${raced.file_id}`, Buffer.from(text), bearer(server))));
  assert.deepEqual(both.map((b) => b.status).sort(), [200, 422], both.map((b) => b.text).join("\n"));
  const won = both.find((b) => b.status === 200).json;
  assert.equal(sha(await readFile(join(server.data, "files", raced.file_id, "bytes"))), won.sha256);
  assert.deepEqual(await readdir(join(server.data, "files", raced.file_id)).then((names) => names.sort()), ["bytes", "file.json"]);
  // No such file.
  for (const id of ["no-such-file", "0190a0a0-0000-7000-8000-000000000000"]) assert.deepEqual(field(await put(port, `/v2/files/${id}`, hello, bearer(server))), [404, "not_found", undefined]);
  assert.equal((await put(port, at, hello)).status, 401, "a PUT needs the credential");
  assert.equal((await api("GET", `/files/${made.file_id}`)).status, 405);
});

test("a run's file_ids are copied into its work/inputs/ before it starts, folders kept, never linked, and read through its files", async (t) => {
  const dir = await scratch(t);
  // A model that reads the first file through the run's read tool and answers what it read.
  const reader = join(dir, "faux-reader.mjs");
  await writeFile(reader, `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return faux.message(\`Read: \${textOf(last)}\`);
  return faux.message(faux.toolCall("read", { path: "inputs/notes.txt" }), { stopReason: "toolUse" });
}
`);
  const server = await serve(t, { faux: reader });
  const { api } = server;
  const notes = Buffer.from("The answer is in the notes: 42.\n");
  const blob = randomBytes(40_000);
  const a = await upload(server, "notes.txt", notes, { content_type: "text/plain" });
  const b = await upload(server, "docs/2026/blob.bin", blob);
  assert.equal((await api("POST", "/agents", agent("reader", { tools: ["read"] }))).status, 201);
  const run = await api("POST", "/agents/reader/runs", { input: { content: "Read the notes." }, file_ids: [a.file_id, b.file_id] });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal(run.body.file_ids, undefined, "the contract's Run has no file_ids");
  const work = join(server.data, "runs", run.body.run_id, "work");
  // There at the 202: copied before the run's process started.
  const listed = await fileList(api, run.body.run_id);
  assert.deepEqual(listed.filter((f) => f.path.startsWith("inputs/")).map((f) => [f.path, f.size_bytes]), [["inputs/docs/2026/blob.bin", blob.length], ["inputs/notes.txt", notes.length]]);
  const raw = await fetch(`${server.baseUrl}/runs/${run.body.run_id}/files/inputs/docs/2026/blob.bin`, { headers: bearer(server) });
  assert.equal(raw.status, 200);
  assert.ok(Buffer.from(await raw.arrayBuffer()).equals(blob), "binary-safe, read through the run's files");
  await follow(api, run.body.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${run.body.run_id}`)).body.result.final_answer, /The answer is in the notes: 42\./, "the run read its file at inputs/<path>");
  // A copy, not a link: its own inode, one link, and a write to it leaves the upload as it was.
  const copy = await stat(join(work, "inputs", "notes.txt"));
  const kept = await stat(join(server.data, "files", a.file_id, "bytes"));
  assert.deepEqual([copy.nlink, copy.ino === kept.ino], [1, false]);
  await writeFile(join(work, "inputs", "notes.txt"), "changed by the run");
  assert.ok((await readFile(join(server.data, "files", a.file_id, "bytes"))).equals(notes));
  // The same file reaches another run as it was uploaded.
  const second = await api("POST", "/agents/reader/runs", { input: { content: "Read the notes." }, file_ids: [a.file_id] });
  assert.equal(second.status, 202);
  assert.ok((await readFile(join(server.data, "runs", second.body.run_id, "work", "inputs", "notes.txt"))).equals(notes));
});

test("a name taken already gets the next suffix, the same for the same files in the same order", async (t) => {
  const server = await serve(t);
  const { api } = server;
  const files = [];
  for (const [path, text] of [["report.pdf", "first"], ["report.pdf", "second"], ["docs", "a file named docs"], ["docs/x.txt", "x in docs"], ["docs/y.txt", "y in docs"], ["archive.tar.gz", "tarball"], ["archive.tar.gz", "another tarball"]]) files.push({ ...(await upload(server, path, Buffer.from(text))), text });
  assert.equal((await api("POST", "/agents", agent("dupes"))).status, 201);
  const expected = [["inputs/report.pdf", "first"], ["inputs/report-2.pdf", "second"], ["inputs/docs", "a file named docs"], ["inputs/docs-2/x.txt", "x in docs"], ["inputs/docs-2/y.txt", "y in docs"], ["inputs/archive.tar.gz", "tarball"], ["inputs/archive.tar-2.gz", "another tarball"]];
  for (let i = 0; i < 2; i++) {
    const run = await api("POST", "/agents/dupes/runs", { input: { content: "Hello." }, file_ids: files.map((f) => f.file_id) });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const work = join(server.data, "runs", run.body.run_id, "work");
    const found = [];
    for (const [path, text] of expected) found.push([path, await readFile(join(work, path), "utf8")]);
    assert.deepEqual(found, expected);
    assert.deepEqual((await fileList(api, run.body.run_id)).map((f) => f.path).filter((p) => p.startsWith("inputs/")).sort(), expected.map(([p]) => p).sort());
  }
  // The rules, alone: the suffix goes before the last extension and keeps a name within 255 bytes.
  assert.deepEqual([suffixed("a.txt", 1), suffixed("a.txt", 2), suffixed("README", 3), suffixed("a.b.c", 2)], ["a.txt", "a-2.txt", "README-3", "a.b-2.c"]);
  const long = suffixed(`${"é".repeat(125)}.txt`, 12);
  assert.ok(Buffer.byteLength(long) <= 255 && long.endsWith("-12.txt"), long);
  assert.deepEqual([pathProblem("a/b.txt"), pathProblem("ünïcode/名前.txt")], [undefined, undefined]);
});

test("file_ids naming an unknown, pending or repeated file, or more than max_files_per_run, are refused 422 at file_ids before anything starts", async (t) => {
  const server = await serve(t);
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("refused"))).status, 201);
  const ready = await upload(server, "ok.txt", Buffer.from("ok"));
  const pending = (await api("POST", "/files", { path: "later.txt", size_bytes: 5 })).body.file;
  const refused = async (file_ids) => {
    const answer = await api("POST", "/agents/refused/runs", { input: { content: "Hello." }, file_ids });
    assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], JSON.stringify(answer.body));
    return answer.body.error.fields.map((f) => [f.field, f.reason]);
  };
  assert.deepEqual(await refused([ready.file_id, "no-such-file", pending.file_id]), [["file_ids[1]", "not_an_option"], ["file_ids[2]", "invalid"]]);
  assert.deepEqual(await refused([ready.file_id, ready.file_id]), [["file_ids", "duplicate"]]);
  assert.deepEqual(await refused([7, "../x"]), [["file_ids[0]", "wrong_type"], ["file_ids[1]", "wrong_type"]]);
  assert.deepEqual(await refused("not a list"), [["file_ids", "wrong_type"]]);
  const many = [];
  for (let i = 0; i <= MAX_FILES_PER_RUN; i++) many.push((await upload(server, `f${i}.txt`, Buffer.from(String(i)))).file_id);
  assert.deepEqual(await refused(many), [["file_ids", "too_many"]]);
  assert.deepEqual((await api("GET", "/agents/refused/runs")).body.runs, [], "no run");
  assert.deepEqual(await readdir(join(server.data, "runs")).catch(() => []), [], "and no run directory");
  // At the limit, it starts.
  const full = await api("POST", "/agents/refused/runs", { input: { content: "Hello." }, file_ids: many.slice(0, MAX_FILES_PER_RUN) });
  assert.equal(full.status, 202, JSON.stringify(full.body));
  assert.equal((await fileList(api, full.body.run_id)).filter((f) => f.path.startsWith("inputs/")).length, MAX_FILES_PER_RUN);
});

test("a run body without file_ids, or with none, starts as before: no inputs folder", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  for (const body of [{ input: { content: "Hello." } }, { input: { content: "Hello." }, file_ids: [] }]) {
    const run = await api("POST", "/agents/plain/runs", body);
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"]);
    assert.deepEqual((await fileList(api, run.body.run_id)).filter((f) => f.path.startsWith("inputs/")), []);
    assert.equal(await stat(join(data, "runs", run.body.run_id, "work", "inputs")).catch(() => null), null);
  }
});

test("the console's session sends a file's bytes: a PUT to a route marked raw takes any content type from the page's own origin; without it, or from another, it is no credential; nothing else changes", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  const page = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin: page }, body: { password: "not-a-secret-owner" } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  const reserve = async (path, size) => {
    const answer = await call(server.port, { method: "POST", path: "/v2/files", headers: { cookie, origin: page, "content-type": "application/json" }, body: { path, size_bytes: size } });
    assert.equal(answer.status, 201, answer.text);
    return answer.json.file;
  };
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const file = await reserve("from-console.bin", bytes.length);
  const at = `/v2/files/${file.file_id}`;
  assert.equal((await put(server.port, at, bytes, { cookie, "content-type": "application/octet-stream" })).status, 401, "no Origin: the cookie is no credential");
  assert.equal((await put(server.port, at, bytes, { cookie, "content-type": "application/octet-stream", origin: "https://evil.example" })).status, 401, "another origin's cookie is no credential");
  assert.equal(JSON.parse(await readFile(join(server.data, "files", file.file_id, "file.json"), "utf8")).status, "pending");
  const sent = await put(server.port, at, bytes, { cookie, "content-type": "application/octet-stream", origin: page });
  assert.deepEqual([sent.status, sent.json?.status], [200, "ready"], sent.text);
  // Any content type: a browser sends a file's own.
  const pdf = await reserve("doc.pdf", 4);
  assert.equal((await put(server.port, `/v2/files/${pdf.file_id}`, Buffer.from("%PDF"), { cookie, "content-type": "application/pdf", origin: page })).status, 200);
  // A JSON route keeps the JSON rule, a POST and every other PUT included.
  assert.equal((await call(server.port, { method: "POST", path: "/v2/files", headers: { cookie, origin: page, "content-type": "text/plain" }, body: JSON.stringify({ path: "x.txt", size_bytes: 1 }) })).status, 401, "a non-JSON POST from the page is still no credential");
  assert.equal((await call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie, origin: page, "content-type": "application/json" }, body: agent("a1") })).status, 201);
  assert.equal((await call(server.port, { method: "PUT", path: "/v2/agents/a1/definition", headers: { cookie, origin: page, "content-type": "text/plain" }, body: JSON.stringify(agent("a1")) })).status, 401, "another PUT takes JSON only");
  // The token is unchanged: any content type, or none, and no Origin.
  const other = (await server.api("POST", "/files", { path: "by-token.bin", size_bytes: 3 })).body.file;
  assert.equal((await put(server.port, `/v2/files/${other.file_id}`, Buffer.from("abc"), bearer(server))).status, 200);
  // The mark: on uploadFile alone, and only a PUT may carry it.
  assert.deepEqual(ROUTES.filter((r) => r.raw).map((r) => `${r.method} ${r.name}`), ["PUT uploadFile"]);
  assert.deepEqual([takesBytes("PUT", "/files/x"), takesBytes("POST", "/files/x"), takesBytes("POST", "/files"), takesBytes("PUT", "/agents/x/home"), takesBytes("PUT", "/agents/x/definition")], [true, false, false, false, false]);
});
