// Uploads that work on the first try: `upload.url` is a path from the server's root; a file is sent in one call
// (POST /v2/files?path=..., its bytes the body); the server's uploads are listed, read and deleted; a file sent so
// reaches a run on every harness; and the page's session sends a file's bytes in one call only with its own Origin.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_UPLOAD_BYTES, Uploads, uploadTestHooks } from "../dist/uploads.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, cookieOf, follow, runDir, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pw = (name) => `not-a-secret-${name}`;

/** One request to the server at `port` with `chunks` (a Buffer, or Buffers one after another) as its body. */
function send(port, method, path, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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
      for (const chunk of chunks === undefined ? [] : Buffer.isBuffer(chunks) ? [chunks] : chunks) if (!req.write(chunk)) await new Promise((done) => req.once("drain", done));
      req.end();
    })().catch(reject);
  });
}
const bearer = (server) => ({ authorization: `Bearer ${server.token}` });
/** A file sent in one call: its bytes the body, `query` the URL's query. */
const sendFile = (server, query, bytes, headers = {}) => send(server.port, "POST", `/v2/files?${new URLSearchParams(query)}`, bytes, { ...bearer(server), ...headers });

async function served(t, options) {
  const server = await serve(t, options);
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  const check = (schema, value) => assert.deepEqual(schemaProblems(doc, typeof schema === "string" ? { $ref: `#/components/schemas/${schema}` } : schema, value), [], JSON.stringify(value));
  return { ...server, doc, check };
}

test("upload.url is a path from the server's root: the PUT goes where the answer says, from the root or from /v2 alike", async (t) => {
  const server = await served(t);
  const made = await server.api("POST", "/files", { path: "notes.txt", size_bytes: 5 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { url } = made.body.upload;
  // The newcomer's call: the PUT to the url as the answer gives it, from the server's root.
  const sent = await send(server.port, "PUT", url, Buffer.from("hello"), bearer(server));
  assert.deepEqual([sent.status, sent.json?.status], [200, "ready"], `the PUT to ${url} as given: ${sent.text}`);
  assert.equal(url, `/v2/files/${made.body.file.file_id}`);
  // Resolved against the server's address as a client is given it, or against the contract's /v2 server URL: one place.
  assert.equal(new URL(url, server.url).href, new URL(url, server.baseUrl).href);
  // Appended to the /v2 base instead, the 404 says what to do.
  const twice = await send(server.port, "PUT", `/v2${url}`, Buffer.from("hello"), bearer(server));
  assert.equal(twice.status, 404);
  assert.match(twice.json.error.message, /\/v2 is in it twice.*server's root/);
});

test("a file sent in one call: POST /v2/files?path= with the bytes as the body is 201, ready, its length and hash its own, kept 0600", async (t) => {
  const server = await served(t);
  const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(50_000)]);
  // As curl's --data-binary sends it: its form type says only "bytes".
  const made = await sendFile(server, { path: "data/blob.bin" }, bytes, { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(made.status, 201, made.text);
  server.check("FileUpload", made.json);
  const { file, upload } = made.json;
  assert.deepEqual({ ...file, file_id: undefined, created_at: undefined }, { file_id: undefined, path: "data/blob.bin", size_bytes: bytes.length, content_type: "application/octet-stream", sha256: sha(bytes), status: "ready", created_at: undefined, expires_at: null });
  assert.deepEqual([upload.method, upload.url], ["PUT", `/v2/files/${file.file_id}`]);
  const dir = join(server.data, "files", file.file_id);
  assert.ok((await readFile(join(dir, "bytes"))).equals(bytes), "binary-safe");
  for (const name of ["bytes", "file.json"]) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
  assert.deepEqual((await readdir(join(server.data, "files"))).filter((name) => name.startsWith(".")), [], "no incoming file left");
  // The PUT the answer names, with the same bytes, changes nothing.
  assert.deepEqual([(await send(server.port, "PUT", upload.url, bytes, bearer(server))).status], [200]);
  // The type: the query's, else the request's own when it names one, else the extension's, else octet-stream.
  const typeOf = async (query, headers) => (await sendFile(server, query, Buffer.from("x"), headers)).json.file.content_type;
  assert.equal(await typeOf({ path: "plan.md" }, { "content-type": "application/x-www-form-urlencoded" }), "text/markdown; charset=utf-8");
  assert.equal(await typeOf({ path: "scan.bin" }, { "content-type": "application/pdf" }), "application/pdf", "a browser's File type");
  assert.equal(await typeOf({ path: "notes.txt", content_type: "text/x-notes" }, { "content-type": "application/pdf" }), "text/x-notes", "the query wins");
  assert.equal(await typeOf({ path: "plain" }, {}), "application/octet-stream", "no type anywhere");
  assert.equal(await typeOf({ path: "plan.md", content_type: "" }, {}), "text/markdown; charset=utf-8", "an empty content_type is none");
  // A .json file is a file too: with path in the query, its JSON body is the file's bytes.
  const json = await sendFile(server, { path: "data.json" }, Buffer.from('{"a":1}'), { "content-type": "application/json" });
  assert.deepEqual([json.status, json.json.file.content_type, json.json.file.size_bytes], [201, "application/json", 7]);
  // A hash given is checked.
  assert.equal((await sendFile(server, { path: "ok.txt", sha256: sha(Buffer.from("ok")) }, Buffer.from("ok"))).status, 201);
  const wrong = await sendFile(server, { path: "no.txt", sha256: sha(Buffer.from("yes")) }, Buffer.from("no"));
  assert.deepEqual([wrong.status, wrong.json.error.fields.map((f) => f.field)], [422, ["sha256"]]);
  assert.deepEqual((await readdir(join(server.data, "files"))).filter((name) => name.startsWith(".")), [], "a refused one leaves no bytes");
});

test("a file sent in one call is refused with the call that works: no path, a multipart form, an unknown key, a bad path, over the limit", async (t) => {
  const server = await served(t);
  const before = (await server.api("GET", "/files")).body.files.length;
  const missing = await sendFile(server, {}, Buffer.from("hello"), { "content-type": "text/plain" });
  assert.deepEqual([missing.status, missing.json.error.code, missing.json.error.fields[0].field, missing.json.error.fields[0].reason], [422, "input_invalid", "path", "missing"]);
  assert.match(missing.json.error.fields[0].fix, /\?path=/);
  const form = await sendFile(server, { path: "plan.md" }, Buffer.from("--x\r\n"), { "content-type": "multipart/form-data; boundary=x" });
  assert.deepEqual([form.status, form.json.error.code], [415, "unsupported_media_type"]);
  assert.match(form.json.error.message, /--data-binary @plan\.md/);
  const typo = await sendFile(server, { path: "plan.md", filename: "plan.md" }, Buffer.from("x"));
  assert.deepEqual([typo.status, typo.json.error.fields.map((f) => [f.field, f.reason])], [422, [["filename", "not_allowed"]]]);
  for (const path of ["../up.txt", ".hidden", "a//b"]) assert.equal((await sendFile(server, { path }, Buffer.from("x"))).json.error.code, "invalid_file_path", path);
  const mib = Buffer.alloc(2 ** 20);
  const huge = await sendFile(server, { path: "huge.bin" }, [...Array.from({ length: MAX_UPLOAD_BYTES / mib.length }, () => mib), Buffer.from("x")]);
  assert.deepEqual([huge.status, huge.json.error.code, huge.json.error.details], [413, "payload_too_large", { limit: "max_upload_bytes" }]);
  assert.equal((await server.api("GET", "/files")).body.files.length, before, "nothing made");
  assert.deepEqual((await readdir(join(server.data, "files")).catch(() => [])).filter((name) => name.startsWith(".")), []);
});

test("a file sent in one call takes an Idempotency-Key: the same bytes replay the first file, other bytes are a mismatch", async (t) => {
  const server = await served(t);
  const first = await sendFile(server, { path: "once.txt" }, Buffer.from("once"), { "idempotency-key": "k-once" });
  const again = await sendFile(server, { path: "once.txt" }, Buffer.from("once"), { "idempotency-key": "k-once" });
  assert.deepEqual([first.status, again.status, again.headers["idempotent-replayed"], again.json.file.file_id], [201, 201, "true", first.json.file.file_id]);
  const other = await sendFile(server, { path: "once.txt" }, Buffer.from("twice"), { "idempotency-key": "k-once" });
  assert.deepEqual([other.status, other.json.error.code], [409, "idempotency_mismatch"]);
  assert.equal((await server.api("GET", "/files")).body.files.length, 1, "one file made");
  assert.deepEqual((await readdir(join(server.data, "files"))).filter((name) => name.startsWith(".")), [], "the replays' bytes dropped");
});

test("GET /v2/files lists the server's uploads newest first a page at a time, GET one reads its record, and DELETE removes it; a run that copied it keeps its copy", async (t) => {
  const server = await served(t);
  const { api } = server;
  const sent = (await sendFile(server, { path: "kept.txt" }, Buffer.from("kept bytes"))).json.file;
  // Ids sort by their millisecond: the next file a few milliseconds on.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pending = (await api("POST", "/files", { path: "later.txt", size_bytes: 3 })).body.file;
  const list = await api("GET", "/files");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  server.check(server.doc.paths["/files"].get.responses["200"].content["application/json"].schema, list.body);
  assert.deepEqual(list.body.files.map((f) => [f.file_id, f.status]), [[pending.file_id, "pending"], [sent.file_id, "ready"]], "newest first");
  const one = await api("GET", "/files?limit=1");
  assert.deepEqual(one.body.files.map((f) => f.file_id), [pending.file_id]);
  const two = await api("GET", `/files?limit=1&cursor=${one.body.next_cursor}`);
  assert.deepEqual([two.body.files.map((f) => f.file_id), two.body.next_cursor], [[sent.file_id], null]);
  const read = await api("GET", `/files/${sent.file_id}`);
  assert.equal(read.status, 200);
  server.check("File", read.body);
  assert.deepEqual(read.body, sent);
  assert.equal((await api("GET", "/files/no-such-file")).status, 404);
  // A run that copied the file keeps its copy when the upload goes.
  assert.equal((await api("POST", "/agents", agent("keeper"))).status, 201);
  const run = await api("POST", "/agents/keeper/runs", { input: { content: "Hello." }, file_ids: [sent.file_id] });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const gone = await send(server.port, "DELETE", `/v2/files/${sent.file_id}`, undefined, bearer(server));
  assert.deepEqual([gone.status, gone.text], [204, ""]);
  assert.equal((await api("GET", `/files/${sent.file_id}`)).status, 404);
  assert.equal((await send(server.port, "DELETE", `/v2/files/${sent.file_id}`, undefined, bearer(server))).status, 404, "deleted once");
  assert.equal(await stat(join(server.data, "files", sent.file_id)).catch(() => null), null, "its bytes are gone");
  assert.equal(await readFile(join(runDir(server.data, run.body.run_id), "work", "inputs", "kept.txt"), "utf8"), "kept bytes", "the run's copy stays");
  await follow(api, run.body.run_id, ["completed"]);
  // A run started after names it in vain; a pending one deleted takes no bytes.
  const late = await api("POST", "/agents/keeper/runs", { input: { content: "Hello." }, file_ids: [sent.file_id] });
  assert.deepEqual([late.status, late.body.error.fields[0].field], [422, "file_ids[0]"]);
  assert.equal((await send(server.port, "DELETE", `/v2/files/${pending.file_id}`, undefined, bearer(server))).status, 204);
  assert.equal((await send(server.port, "PUT", `/v2/files/${pending.file_id}`, Buffer.from("abc"), bearer(server))).status, 404);
  assert.deepEqual((await api("GET", "/files")).body, { files: [], next_cursor: null });
});

test("a file sent in one call reaches a run on pi, claude-agent and codex: each reads it at inputs/<path> through its own read tool", { timeout: 180_000 }, async (t) => {
  // pi's faux model reads the path its first message names, then answers what it read.
  const reader = join(await scratch(t), "faux-reader.mjs");
  await writeFile(reader, `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return faux.message(\`Read: \${textOf(last)}\`);
  const path = /Read the upload (\\S+)\\./.exec(textOf(context.messages.find((m) => m.role === "user")))?.[1] ?? "missing";
  return faux.message(faux.toolCall("read", { path }), { stopReason: "toolUse" });
}
`);
  const server = await served(t, { faux: reader, harnessTable: fauxTable(FAUX_HARNESS) });
  const { api } = server;
  const words = "The upload reached the run.\n";
  const file = (await sendFile(server, { path: "brief/notes.txt" }, Buffer.from(words))).json.file;
  for (const harness of ["pi", "claude-agent", "codex"]) {
    const id = `reader-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { harness, tools: ["read"], instructions: "Read the upload inputs/brief/notes.txt." }))).status, 201, harness);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "Read the upload inputs/brief/notes.txt." }, file_ids: [file.file_id] });
    assert.equal(run.status, 202, `${harness}: ${JSON.stringify(run.body)}`);
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const listed = (await api("GET", `/runs/${run.body.run_id}/files`)).body.files.find((f) => f.path === "inputs/brief/notes.txt");
    assert.deepEqual([listed?.size_bytes, listed?.content_type], [words.length, "text/plain; charset=utf-8"], `${harness}: in the run's files`);
    const result = rows.find((r) => r.kind === "tool_result");
    assert.ok(result?.tool_status === "success" && String(result.tool_result_preview).includes("The upload reached the run."), `${harness}: its read tool read the file: ${JSON.stringify(result)}`);
  }
});

test("an image sent to a run on claude-agent or codex is read by pi's read tool as a host tool: an image read asks the calling agent for its model, which a host tool's api answers", { timeout: 180_000 }, async (t) => {
  // pi 1.5's read, on an image, reads the calling agent's model for its image limits (api.agent(), api.models).
  const server = await served(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  const { api } = server;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const file = (await sendFile(server, { path: "brief/pixel.png" }, png)).json.file;
  for (const harness of ["claude-agent", "codex"]) {
    const id = `image-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { harness, tools: ["read"], instructions: "Read the upload inputs/brief/pixel.png." }))).status, 201, harness);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "Read the upload inputs/brief/pixel.png." }, file_ids: [file.file_id] });
    assert.equal(run.status, 202, `${harness}: ${JSON.stringify(run.body)}`);
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    const result = rows.find((r) => r.kind === "tool_result");
    assert.equal(result?.tool_status, "success", `${harness}: its read tool read the image: ${JSON.stringify(result)}`);
  }
});

test("the page's session sends a file in one call only with its own Origin: the POST is marked raw, and nothing else changes", async (t) => {
  const server = await served(t, { accounts: true, openSetup: true });
  const page = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin: page }, body: { password: pw("owner") } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  const at = "/v2/files?path=console.pdf";
  const pdf = Buffer.from("%PDF-1.7 test");
  assert.equal((await send(server.port, "POST", at, pdf, { cookie, "content-type": "application/pdf" })).status, 401, "no Origin: the cookie is no credential");
  assert.equal((await send(server.port, "POST", at, pdf, { cookie, "content-type": "application/pdf", origin: "http://127.0.0.1:1" })).status, 401, "another origin, this host's other port included");
  const sent = await send(server.port, "POST", at, pdf, { cookie, "content-type": "application/pdf", origin: page });
  assert.deepEqual([sent.status, sent.json?.file?.status, sent.json?.file?.content_type], [201, "ready", "application/pdf"], sent.text);
  // The two-step JSON reservation keeps the JSON rule; list, read and delete take the cookie as every route does.
  const reserved = await call(server.port, { method: "POST", path: "/v2/files", headers: { cookie, origin: page, "content-type": "application/json" }, body: { path: "two-step.txt", size_bytes: 1 } });
  assert.equal(reserved.status, 201, reserved.text);
  assert.equal((await call(server.port, { path: "/v2/files", headers: { cookie } })).json.files.length, 2);
  assert.equal((await call(server.port, { method: "DELETE", path: `/v2/files/${sent.json.file.file_id}`, headers: { cookie, origin: page, "content-type": "application/json" } })).status, 204);
  assert.equal((await call(server.port, { method: "DELETE", path: `/v2/files/${reserved.json.file.file_id}`, headers: { cookie, origin: page } })).status, 401, "a DELETE is no raw route: it needs the JSON rule");
  // A POST to a route not marked raw still takes JSON only.
  assert.equal((await call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie, origin: page, "content-type": "text/plain" }, body: JSON.stringify(agent("a1")) })).status, 401);
});

test("a PUT of a ready file's bytes that a DELETE overtakes answers 404, never ready", async (t) => {
  const server = await served(t);
  const bytes = Buffer.from("ready bytes");
  const file = (await sendFile(server, { path: "gone.txt" }, bytes)).json.file;
  // The retry's first half goes, the file is deleted while it streams, then its second half.
  let finish;
  const answer = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method: "PUT", path: `/v2/files/${file.file_id}`, agent: false, headers: { host: `127.0.0.1:${server.port}`, ...bearer(server), "content-length": String(bytes.length) } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString("utf8") || "null") }));
    });
    req.once("error", reject);
    req.write(bytes.subarray(0, 5));
    finish = () => req.end(bytes.subarray(5));
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await send(server.port, "DELETE", `/v2/files/${file.file_id}`, undefined, bearer(server))).status, 204);
  finish();
  const done = await answer;
  assert.deepEqual([done.status, done.json?.error?.code], [404, "not_found"], JSON.stringify(done.json));
});

test("a file sent in one call whose record cannot be written leaves nothing behind, and the next one is made", async (t) => {
  const server = await served(t);
  uploadTestHooks.beforeRecord = () => {
    throw new Error("no space left on the test's disk");
  };
  t.after(() => void (uploadTestHooks.beforeRecord = undefined));
  const failed = await sendFile(server, { path: "orphan.txt" }, Buffer.from("orphan bytes"));
  assert.equal(failed.status, 500, failed.text);
  uploadTestHooks.beforeRecord = undefined;
  assert.deepEqual(await readdir(join(server.data, "files")), [], "no folder, no bytes, no incoming file");
  assert.deepEqual((await server.api("GET", "/files")).body.files, []);
  assert.equal((await sendFile(server, { path: "next.txt" }, Buffer.from("next"))).status, 201);
});

test("the served document covers every body a file sent in one call takes", async (t) => {
  const server = await served(t);
  const body = server.doc.paths["/files"].post.requestBody;
  const covered = (type) => Object.keys(body.content).some((range) => range === "*/*" || range === type || (range.endsWith("/*") && type.startsWith(range.slice(0, -1))));
  for (const type of ["application/pdf", "text/plain", "image/png", "application/octet-stream", "application/x-www-form-urlencoded"]) {
    assert.ok(covered(type), `${type}: a media range in the document takes it`);
    assert.equal((await sendFile(server, { path: `file.${type.split("/")[1]}` }, Buffer.from("x"), { "content-type": type })).status, 201, type);
  }
  // With path in the query, a JSON body is a file's bytes: the document says so beside the contract's reservation.
  assert.match(body.description, /application\/json.*path.*query|path.*query.*application\/json/s);
});

test("a pending file deleted between its PUT's read and its first write answers 404, not a server error", async (t) => {
  const root = join(await scratch(t), "files");
  const uploads = new Uploads(root);
  const { file } = await uploads.reserve({ path: "race.txt", size_bytes: 2 });
  // The upload's folder goes right after the PUT read the record, before it opens the file its bytes go to: what a
  // DELETE landing between the two does.
  const read = uploads.get.bind(uploads);
  uploads.get = async (id) => {
    const found = await read(id);
    uploads.get = read;
    await rm(join(root, id), { recursive: true, force: true });
    return found;
  };
  await assert.rejects(uploads.receive(file.file_id, [Buffer.from("ok")]), (error) => error.code === "not_found" && error.status === 404);
});

test("a run naming something that is not a file id is told what it sent, cut to 40 characters, and where a file id comes from", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("bad-ids"))).status, 201);
  const long = "x/".repeat(30);
  const sent = ["", 42, null, { a: 1 }, long, "\u{1f600}".repeat(50)];
  const answer = await api("POST", "/agents/bad-ids/runs", { input: { content: "Hello." }, file_ids: sent });
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  const tail = ", not a file id: use the file_id an upload answered (POST /v2/files answers it under file.file_id).";
  assert.deepEqual(answer.body.error.fields.map((f) => [f.field, f.reason, f.message]), [
    ["file_ids[0]", "wrong_type", `file_ids[0] is ""${tail}`],
    ["file_ids[1]", "wrong_type", `file_ids[1] is 42${tail}`],
    ["file_ids[2]", "wrong_type", `file_ids[2] is null${tail}`],
    ["file_ids[3]", "wrong_type", `file_ids[3] is {"a":1}${tail}`],
    // Its JSON is 62 characters: the first 39, then an ellipsis.
    ["file_ids[4]", "wrong_type", `file_ids[4] is "${"x/".repeat(19)}…${tail}`],
    // Cut by characters, never inside a surrogate pair.
    ["file_ids[5]", "wrong_type", `file_ids[5] is "${"\u{1f600}".repeat(38)}…${tail}`],
  ]);
});

test("a file_ids value too deep to show as JSON is still a 422 that says so, never a server error", async (t) => {
  const server = await serve(t);
  assert.equal((await server.api("POST", "/agents", agent("deep-ids"))).status, 201);
  // 10,000 arrays deep: JSON.parse takes it, JSON.stringify of it overflows the stack.
  const body = `{"input":{"content":"Hello."},"file_ids":[${"[".repeat(10_000)}${"]".repeat(10_000)}]}`;
  const res = await fetch(`${server.baseUrl}/agents/deep-ids/runs`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body });
  const answer = await res.json();
  assert.equal(res.status, 422, JSON.stringify(answer).slice(0, 300));
  assert.deepEqual(answer.error.fields.map((f) => [f.field, f.reason, f.message]), [["file_ids[0]", "wrong_type", "file_ids[0] is a value too deep to show, not a file id: use the file_id an upload answered (POST /v2/files answers it under file.file_id)."]]);
});
