// The share host (`agentrun-serve --share-host`, AGENTRUN_SHARE_HOST=1; share-host.ts): a serve install that answers under
// /r/ alone. A share's page is /r/<id>, its stored bytes /r/<id>/bundle.json, the page's assets /r/_assets/*, the API
// /r/v2/shares (a POST that stores a bundle, a GET of the caller's own, a DELETE of one) and /r/v2/health; every other
// address is a 404, the console, the run, agent, key, computer and trigger routes among them. An upload is a canonical
// `agentrun.share/1` document whose sha256 and file digests hold, re-scrubbed by the scrubber in cut mode with this
// host's held values: any cut, or a scrub that fails, refuses it (422) and nothing is stored. A token keeps at most 100
// shares; its owner deletes one, and its page is then 410. A share's URL is on AGENTRUN_PUBLIC_URL, never a Host header.
//
// Every bundle is synthetic, made by run-export.ts's own builder from made-up run data, and every planted value is made
// fresh for its case. No test counts requests: a hook on this machine GETs / on every new loopback listener, and each
// test asserts on the shares directory and on the answers to its own requests alone (portProbe once proves a probe is
// a 404 that stores nothing).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { portProbe } from "./trigger-support.mjs";
import { builtConsole, call, serve } from "./support.mjs";

const { exportBundle } = await import("../dist/run-export.js");
const { packageSha256 } = await import("../dist/agent-package.js");
const { stable } = await import("../dist/validate.js");
const { checkShareBundle, SHARE_QUOTA, SHARE_HOST_CSP, SHARE_HOST_ROUTES } = await import("../dist/share-host.js");
const { SHARE_HOST_ENV, switchFrom } = await import("../dist/env-switch.js");
const { banner } = await import("../dist/print.js");
const { startServe } = await import("../dist/server.js");

const PUBLIC = "https://agentrun.example";
/** A token of the test's own: never a real one, made at random so no scan reads a literal. */
const tokenOf = (id) => ({ id, token: `share-test-${id}-${randomBytes(20).toString("hex")}` });
const nonce = () => randomBytes(8).toString("hex");
const sha = (text) => createHash("sha256").update(text).digest("hex");

const SHARE_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Shared run</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" />
<script type="module" crossorigin src="./assets/share-Mn34Op56.js"></script>
<link rel="modulepreload" crossorigin href="./assets/chunk-Qr78St90.js">
<link rel="stylesheet" crossorigin href="./assets/index-Ef56Gh78.css"></head>
<body><div id="root"></div></body></html>
`;

/** A built console with its share page, as Vite's two entries build it (relative asset URLs, base "./"). */
async function consoleWithShare(t) {
  const root = await builtConsole(t);
  await writeFile(join(root, "share.html"), SHARE_INDEX);
  await writeFile(join(root, "assets", "share-Mn34Op56.js"), "document.getElementById('root').textContent = 'share';\n");
  await writeFile(join(root, "assets", "chunk-Qr78St90.js"), "export const x = 1;\n");
  return root;
}

/** A share host for test `t`: alice's and bob's tokens, the public address, a built console. `extra` overrides. */
async function shareHost(t, extra = {}) {
  const alice = tokenOf("alice");
  const bob = tokenOf("bob");
  const server = await serve(t, { runner: false, shareHost: true, tokens: [alice, bob], publicUrl: PUBLIC, console: await consoleWithShare(t), ...extra });
  return { ...server, alice, bob, shares: join(server.data, "shares") };
}

/** A request to the host: status, headers, body bytes and text, and the JSON body when it is one. */
function send(port, { method = "GET", path, token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: sent }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => {
        const bytes = Buffer.concat(parts);
        let json;
        try {
          json = JSON.parse(bytes.toString("utf8"));
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString("utf8"), json });
      });
    });
    req.once("error", reject).end(body);
  });
}
const upload = (s, body, token = s.alice.token, headers = {}) => send(s.port, { method: "POST", path: "/r/v2/shares", token, body, headers });

/** A run's bundle as run-export.ts builds it: an ended agentic run of synthetic text, one text file. `over` changes the
 *  run's view; `content` is the file's text. */
async function bundleOf({ title = `Multiply two numbers ${nonce()}`, answer = "The answer is 42.", content = "# Report\n\nSix times seven is 42.\n", rows } = {}) {
  const bytes = Buffer.from(content);
  const { body } = await exportBundle({
    runId: `run_${nonce()}`,
    agent: { name: "share-test-agent" },
    view: { kind: "agentic", status: "succeeded", state: "succeeded", title, created_at: "2026-11-23T00:00:00.000Z", ended_at: "2026-11-23T00:01:00.000Z", result: { final_answer: answer, output: null, output_error: null }, run_id: "dropped", console_url: "http://127.0.0.1:1/dropped" },
    rows: rows ?? [{ type: "message", role: "user", text: "What is six times seven?" }, { type: "message", role: "assistant", text: answer }],
    graph: null,
    files: [{ path: "out/report.md", size: bytes.length, read: async () => bytes }],
    filesTruncated: false,
    held: [],
    restore: [],
    version: "0.0.0-share-test",
  });
  return body;
}

/** `doc` (a parsed bundle, changed by a test) written back as a sender would: canonical, its sha256 made again. */
function resigned(doc) {
  const { sha256: _old, ...rest } = doc;
  return stable({ ...rest, sha256: sha(stable(rest)) });
}
/** A file's digest as the bundle names it (agent-package.ts packageSha256 of the one file). */
const fileSha = (path, content) => packageSha256([{ path, encoding: "utf8", content }]);
/** The ids under the shares directory (none when it was never made). */
const sharesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : []);

test("AGENTRUN_SHARE_HOST is on for 1 or true, off when unset, empty, 0 or false, and refused in words otherwise", () => {
  assert.equal(SHARE_HOST_ENV, "AGENTRUN_SHARE_HOST");
  const read = (value) => switchFrom(SHARE_HOST_ENV, value === undefined ? {} : { [SHARE_HOST_ENV]: value });
  for (const value of ["1", "true", " TRUE "]) assert.equal(read(value), true, value);
  for (const value of [undefined, "", "0", "false"]) assert.equal(read(value), false, String(value));
  assert.throws(() => read("yes"), /AGENTRUN_SHARE_HOST is 1 \(serve shares under \/r\/ alone\) or 0/);
});

test("the banner of a share host names its API base under /r/v2 and says it runs no runner, key or computer", () => {
  const lines = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: "x", source: "list", tokenIds: ["alice"], publicUrl: PUBLIC, shareHost: true });
  assert.ok(lines.includes(`AGENTRUN_BASE_URL=${PUBLIC}/r/v2`), lines.join("\n"));
  assert.ok(lines.some((line) => /^Share host \(--share-host\): shares at https:\/\/agentrun\.example\/r\/<id>; /.test(line) && /no runner/.test(line)), lines.join("\n"));
  assert.ok(!lines.some((line) => line.startsWith("Open ")), "no console to open");
});

test("the share host's API is its own four routes, every one under /r/v2/", () => {
  assert.deepEqual(SHARE_HOST_ROUTES.map((route) => `${route.method} ${route.name}`).sort(), ["DELETE deleteShare", "GET getShareHealth", "GET listShares", "POST createShare"]);
  for (const route of SHARE_HOST_ROUTES) assert.ok(route.path.startsWith("/r/v2/"), route.path);
});

test("every address outside /r/ is a 404, with the token or without: the console, /v2, MCP, and every runner, key, computer, agent and trigger route", async (t) => {
  const s = await shareHost(t);
  const outside = [
    ["GET", "/"], ["GET", "/index.html"], ["GET", "/assets/index-Ab12Cd34.js"], ["GET", "/share/run_1"], ["GET", "/llms.txt"], ["GET", "/skills/agentrun-serve/SKILL.md"],
    ["POST", "/mcp"], ["GET", "/v2/health"], ["GET", "/v2/capabilities"], ["POST", "/v2/runs"], ["GET", "/v2/runs"], ["POST", "/v2/agents"], ["GET", "/v2/agents"],
    ["GET", "/v2/computers"], ["POST", "/v2/computers/pair"], ["GET", "/v2/settings/keys"], ["PUT", "/v2/settings/keys/openai"], ["GET", "/v2/triggers"], ["POST", "/v2/triggers"],
    ["GET", "/v2/auth/session"], ["POST", "/v2/setup"], ["GET", "/v2/shares"], ["POST", "/v2/shares"], ["GET", "/r"], ["GET", "/rx/abc"], ["GET", "/R/abc"],
    // Under /r/v2, nothing but the share host's own routes.
    ["GET", "/r/v2/runs"], ["POST", "/r/v2/runs"], ["GET", "/r/v2/agents"], ["GET", "/r/v2/computers"], ["GET", "/r/v2/settings/keys"], ["GET", "/r/v2/capabilities"], ["GET", "/r/v2/triggers"], ["GET", "/r/v2"],
  ];
  for (const [method, path] of outside) {
    for (const token of [undefined, s.alice.token]) {
      const res = await send(s.port, { method, path, token, ...(method === "GET" ? {} : { body: "{}" }) });
      assert.equal(res.status, 404, `${method} ${path} ${token ? "with" : "without"} the token: ${res.text}`);
      assert.equal(res.json?.error?.code, "not_found", `${method} ${path}`);
    }
  }
  assert.equal(await portProbe(`http://127.0.0.1:${s.port}/`), 404, "a probe of / is a 404 too");
  assert.deepEqual(sharesIn(s.shares), [], "nothing stored");
  // The health route is public, and says what this server is.
  const health = await send(s.port, { path: "/r/v2/health" });
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json.share_host, true);
  assert.equal(health.json.status, "ok");
  assert.equal((await send(s.port, { method: "HEAD", path: "/r/v2/health" })).status, 200);
});

test("a live view's WebSocket upgrade is refused on a share host, as every address outside /r/ is", async (t) => {
  const s = await shareHost(t);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, path: "/v2/runs/run_1/browser/live", headers: { host: `127.0.0.1:${s.port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") } });
    req.once("upgrade", (res, socket) => (socket.destroy(), resolve(res.statusCode)));
    req.once("response", (res) => (res.resume(), resolve(res.statusCode)));
    req.once("error", reject).end();
  });
  assert.equal(status, 404);
});

test("a clean bundle is stored: 201 with its id, its URL on the public address and its sha256; /r/<id>/bundle.json is the posted bytes", async (t) => {
  const s = await shareHost(t);
  const body = await bundleOf();
  const made = await upload(s, body);
  assert.equal(made.status, 201, made.text);
  const { id, url, sha256 } = made.json;
  assert.match(id, /^[a-z2-7]{26}$/, "128 bits of randomness, base32");
  assert.equal(url, `${PUBLIC}/r/${id}`);
  assert.equal(sha256, JSON.parse(body).sha256);
  const read = await send(s.port, { path: `/r/${id}/bundle.json` });
  assert.equal(read.status, 200);
  assert.ok(read.bytes.equals(Buffer.from(body)), "the stored bytes, never a re-render");
  assert.match(read.headers["content-type"], /^application\/json/);
  assert.equal(read.headers["x-content-type-options"], "nosniff");
  assert.equal(read.headers["x-robots-tag"], "noindex");
  assert.equal((await send(s.port, { method: "HEAD", path: `/r/${id}/bundle.json` })).status, 200);
  // On disk: <data>/shares/<id>/bundle.json and meta.json, 0600, in a 0700 folder.
  assert.deepEqual(sharesIn(s.shares), [id]);
  assert.equal(await readFile(join(s.shares, id, "bundle.json"), "utf8"), body);
  const meta = JSON.parse(await readFile(join(s.shares, id, "meta.json"), "utf8"));
  assert.deepEqual({ sha256: meta.sha256, token_id: meta.token_id, bytes: meta.bytes }, { sha256, token_id: "alice", bytes: Buffer.byteLength(body) });
  for (const name of ["bundle.json", "meta.json"]) assert.equal(statSync(join(s.shares, id, name)).mode & 0o777, 0o600, name);
  assert.equal(statSync(join(s.shares, id)).mode & 0o777, 0o700);
  // Bob's list is his own; alice's has it.
  const mine = await send(s.port, { path: "/r/v2/shares", token: s.alice.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.shares.map((share) => [share.id, share.url, share.sha256]), [[id, url, sha256]]);
  assert.deepEqual(mine.json.quota, { limit: SHARE_QUOTA, used: 1 });
  assert.deepEqual((await send(s.port, { path: "/r/v2/shares", token: s.bob.token })).json.shares, []);
});

test("an upload is the token's alone: none, a wrong one, or this host's console cookie is 401, read no further and stores nothing", async (t) => {
  const s = await shareHost(t);
  const body = await bundleOf();
  for (const headers of [{}, { authorization: `Bearer ${tokenOf("mallory").token}` }, { cookie: `agentrun-${s.port}=not-a-session; agentrun-${s.port}-session=not-a-session` }]) {
    const res = await send(s.port, { method: "POST", path: "/r/v2/shares", headers, body });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.json.error.code, "unauthenticated");
    assert.equal((await send(s.port, { path: "/r/v2/shares", headers })).status, 401);
  }
  assert.deepEqual(sharesIn(s.shares), []);
});

test("a known key format anywhere in the bundle, a value this host holds, or a key in an object's name refuses the upload: 422, no value in the answer, nothing stored", async (t) => {
  const s = await shareHost(t);
  const key = `sk-proj-${randomBytes(24).toString("hex")}`;
  const clean = JSON.parse(await bundleOf());
  const cases = {
    title: (doc) => (doc.run.title = `deploy with ${key}`),
    file: (doc) => {
      doc.files[0].content = `token: ${key}\n`;
      doc.files[0].bytes = Buffer.byteLength(doc.files[0].content);
      doc.files[0].sha256 = fileSha(doc.files[0].path, doc.files[0].content);
    },
    row: (doc) => (doc.rows[1].text = `here it is ${key}`),
    rowKey: (doc) => (doc.rows[0][key] = "x"),
    held: (doc) => (doc.run.result.final_answer = `the host's own token ${s.bob.token}`),
  };
  for (const [name, change] of Object.entries(cases)) {
    const doc = structuredClone(clean);
    change(doc);
    const res = await upload(s, resigned(doc));
    assert.equal(res.status, 422, `${name}: ${res.text}`);
    assert.equal(res.json.error.code, "input_invalid", name);
    assert.equal(res.json.error.details.reason, "scrub_found", name);
    assert.ok(Object.values(res.json.error.details.counts).every((n) => Number.isInteger(n) && n > 0), name);
    assert.ok(!res.text.includes(key) && !res.text.includes(s.bob.token), `${name}: the answer holds no value`);
  }
  assert.deepEqual(sharesIn(s.shares), [], "nothing stored, not even a folder");
});


test("a scrub that fails closed, or throws, refuses the upload: 422 scrub_failed, nothing stored", async (t) => {
  for (const scrub of [async () => ({ ok: false, counts: {} }), async () => { throw new Error("rule budget"); }]) {
    const s = await shareHost(t, { shareScrub: scrub });
    const res = await upload(s, await bundleOf());
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.details.reason, "scrub_failed");
    assert.deepEqual(sharesIn(s.shares), []);
  }
});

test("the host scrubs the whole stored body in cut mode with its held values, and never repairs it", async (t) => {
  const seen = [];
  const s = await shareHost(t, { shareScrub: async (text, opts) => (seen.push({ text, opts }), { ok: true, text: text.replace("42", "[redacted:x]"), cuts: [{ rule: "x", kind: "label", restorable: true, start: 0, end: 2, outStart: 0, outEnd: 12, shape: "…[2]" }], counts: { x: 1 } }) });
  const body = await bundleOf();
  const res = await upload(s, body);
  assert.equal(res.status, 422, "a restorable cut refuses it too: the host never stores a cut text in place of the sent one");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, body, "the whole body, as sent");
  assert.equal(seen[0].opts.mode, "cut");
  assert.ok(seen[0].opts.held.includes(s.alice.token) && seen[0].opts.held.includes(s.bob.token), "its own tokens are held values");
  assert.deepEqual(sharesIn(s.shares), []);
});

test("the sha256 is checked: a tampered digest, a file whose digest or size is wrong, or a body that is not canonical is 400 and stores nothing", async (t) => {
  const s = await shareHost(t);
  const body = await bundleOf();
  const doc = JSON.parse(body);
  const tampered = stable({ ...doc, sha256: sha("other") });
  const edited = stable({ ...doc, run: { ...doc.run, title: "changed after export" } }); // the old sha kept
  const fileDigest = structuredClone(doc);
  fileDigest.files[0].sha256 = sha("other");
  const fileBytes = structuredClone(doc);
  fileBytes.files[0].bytes += 1;
  const pretty = JSON.stringify(doc, null, 2);
  for (const [name, text] of Object.entries({ tampered, edited, fileDigest: resigned(fileDigest), fileBytes: resigned(fileBytes), pretty })) {
    const res = await upload(s, text);
    assert.equal(res.status, 400, `${name}: ${res.text}`);
    assert.equal(res.json.error.code, "bad_request", name);
  }
  assert.deepEqual(sharesIn(s.shares), []);
});

test("the bundle's shape is checked: its format, its closed keys at each level the host reads, and the export's caps", async () => {
  const doc = JSON.parse(await bundleOf());
  assert.equal(checkShareBundle(resigned(doc)).sha256, doc.sha256);
  const refused = {
    format: (d) => (d.format = "agentrun.share/2"),
    extraTop: (d) => (d.exported_by = "someone"),
    missingTop: (d) => delete d.omitted,
    runField: (d) => (d.run.run_id = "run_1"),
    importedSession: (d) => (d.run.imported_from = { source: "claude-code", session: "abc" }),
    agentField: (d) => (d.agent.id = "a1"),
    sourceField: (d) => (d.source.host = "x"),
    fileField: (d) => (d.files[0].mode = 0o644),
    fileEncoding: (d) => (d.files[0].encoding = "base64"),
    cutField: (d) => d.cuts.push({ id: "c_0000000000000000", at: "/run/title", start: 0, end: 1, rule: "x", kind: "label", restorable: true, shape: "…", value: "v" }),
    restoredField: (d) => d.restored.push({ id: "c_0000000000000000", at: "/run/title", start: 0, end: 1, rule: "x", kind: "label", original: "v" }),
    omittedField: (d) => d.omitted.push({ what: "file", path: "x", why: "binary", bytes: 3 }),
    rowsNotArray: (d) => (d.rows = {}),
    graphNotObject: (d) => (d.graph = "x"),
    tooManyFiles: (d) => (d.files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, bytes: 0, sha256: fileSha(`f${i}`, ""), encoding: "utf8", content: "" }))),
    fileTooLarge: (d) => {
      const content = "a".repeat(256 * 1024 + 1);
      d.files[0] = { path: "big.txt", bytes: content.length, sha256: fileSha("big.txt", content), encoding: "utf8", content };
    },
  };
  for (const [name, change] of Object.entries(refused)) {
    const changed = structuredClone(doc);
    change(changed);
    assert.throws(() => checkShareBundle(resigned(changed)), (error) => error.status === 400, name);
  }
  assert.throws(() => checkShareBundle("not json"), (error) => error.status === 400);
  assert.throws(() => checkShareBundle("[]"), (error) => error.status === 400);
});

test("a body over the cap is 413 before it is read, and stores nothing", async (t) => {
  const s = await shareHost(t);
  const res = await send(s.port, { method: "POST", path: "/r/v2/shares", token: s.alice.token, headers: { "content-type": "application/json", "content-length": String(16 * 1024 * 1024) }, body: "" });
  assert.equal(res.status, 413);
  assert.deepEqual(sharesIn(s.shares), []);
});

test("a token keeps at most 100 shares: the 101st is refused, another token's still go, and a delete makes room", async (t) => {
  const passing = async (text) => ({ ok: true, text, cuts: [], counts: {} });
  const s = await shareHost(t, { shareScrub: passing });
  assert.equal(SHARE_QUOTA, 100);
  const body = await bundleOf();
  const ids = [];
  for (let i = 0; i < SHARE_QUOTA; i++) {
    const res = await upload(s, body);
    assert.equal(res.status, 201, `share ${i + 1}: ${res.text}`);
    ids.push(res.json.id);
  }
  const over = await upload(s, body);
  assert.equal(over.status, 403, over.text);
  assert.equal(over.json.error.code, "forbidden");
  assert.deepEqual(over.json.error.details, { reason: "share_quota", limit: SHARE_QUOTA, used: SHARE_QUOTA });
  assert.equal(sharesIn(s.shares).length, SHARE_QUOTA);
  assert.equal((await upload(s, body, s.bob.token)).status, 201, "bob's quota is his own");
  assert.equal((await send(s.port, { method: "DELETE", path: `/r/v2/shares/${ids[0]}`, token: s.alice.token })).status, 204);
  assert.equal((await upload(s, body)).status, 201, "room again after a delete");
  assert.equal((await upload(s, body)).status, 403);
  // Parallel uploads at the edge never pass the quota.
  const edge = await shareHost(t, { shareScrub: passing });
  for (let i = 0; i < SHARE_QUOTA - 2; i++) assert.equal((await upload(edge, body)).status, 201);
  const raced = await Promise.all(Array.from({ length: 6 }, () => upload(edge, body)));
  assert.deepEqual(raced.map((res) => res.status).sort(), [201, 201, 403, 403, 403, 403]);
});

test("its owner deletes a share: 204, its bytes gone, its page and bundle 410; another token's delete is 403 and an unknown id 404", async (t) => {
  const s = await shareHost(t);
  const made = await upload(s, await bundleOf());
  assert.equal(made.status, 201, made.text);
  const { id } = made.json;
  const byBob = await send(s.port, { method: "DELETE", path: `/r/v2/shares/${id}`, token: s.bob.token });
  assert.equal(byBob.status, 403);
  assert.equal((await send(s.port, { path: `/r/${id}/bundle.json` })).status, 200, "still served");
  assert.equal((await send(s.port, { method: "DELETE", path: `/r/v2/shares/${id}` })).status, 401);
  assert.equal((await send(s.port, { method: "DELETE", path: `/r/v2/shares/${"a".repeat(26)}`, token: s.alice.token })).status, 404);
  assert.equal((await send(s.port, { method: "DELETE", path: `/r/v2/shares/../../x`, token: s.alice.token })).status, 404);
  const gone = await send(s.port, { method: "DELETE", path: `/r/v2/shares/${id}`, token: s.alice.token });
  assert.equal(gone.status, 204, gone.text);
  assert.equal(existsSync(join(s.shares, id, "bundle.json")), false, "the bytes are gone");
  for (const path of [`/r/${id}`, `/r/${id}/bundle.json`]) {
    const res = await send(s.port, { path });
    assert.equal(res.status, 410, path);
    assert.ok(!res.text.includes("Six times seven"), "nothing of the share");
  }
  assert.equal((await send(s.port, { method: "DELETE", path: `/r/v2/shares/${id}`, token: s.alice.token })).status, 204, "a second delete is 204 too");
  assert.deepEqual((await send(s.port, { path: "/r/v2/shares", token: s.alice.token })).json.shares, []);
});

test("a share's URL is on AGENTRUN_PUBLIC_URL whatever the request's Host or forwarded headers say", async (t) => {
  const s = await shareHost(t);
  const body = await bundleOf();
  const res = await upload(s, body, s.alice.token, { host: "agentrun.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.url, `${PUBLIC}/r/${res.json.id}`);
  const listed = await send(s.port, { path: "/r/v2/shares", token: s.alice.token, headers: { "x-forwarded-host": "evil.example" } });
  assert.equal(listed.json.shares[0].url, `${PUBLIC}/r/${res.json.id}`);
});

test("without AGENTRUN_PUBLIC_URL a share host on loopback names its own address, never the Host header; on any other address the start is refused", async (t) => {
  const s = await shareHost(t, { publicUrl: undefined });
  const res = await upload(s, await bundleOf(), s.alice.token, { host: `localhost:${s.port}` });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.url, `http://127.0.0.1:${s.port}/r/${res.json.id}`);
  await assert.rejects(startServe({ data: join(s.data, "elsewhere"), port: 0, host: "0.0.0.0", shareHost: true, tokens: [tokenOf("carol")] }), /AGENTRUN_PUBLIC_URL/);
});

test("the page and its assets load under /r/: share.html at /r/<id> with every asset URL under /r/_assets/, a CSP that lets nothing load from elsewhere, noindex", async (t) => {
  const s = await shareHost(t);
  const made = await upload(s, await bundleOf());
  const { id } = made.json;
  for (const path of [`/r/${id}`, `/r/${id}/`]) {
    const page = await send(s.port, { path });
    assert.equal(page.status, 200, path);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["content-security-policy"], SHARE_HOST_CSP);
    assert.equal(page.headers["x-robots-tag"], "noindex");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const urls = [...page.text.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(urls.length >= 4, page.text);
    for (const url of urls) assert.ok(url.startsWith("/r/_assets/") || url.startsWith("data:"), `${url} is under /r/`);
    for (const url of urls.filter((url) => url.startsWith("/r/"))) {
      const asset = await send(s.port, { path: url });
      assert.equal(asset.status, 200, url);
      assert.match(asset.headers["cache-control"], /immutable/);
    }
  }
  assert.doesNotMatch(SHARE_HOST_CSP, /https?:/, "no outside origin: a VerdictCard's http image is blocked on a public page");
  assert.match(SHARE_HOST_CSP, /img-src 'self' data:;/);
  assert.match(SHARE_HOST_CSP, /frame-ancestors 'none'/);
  assert.equal((await send(s.port, { method: "HEAD", path: `/r/${id}` })).status, 200);
  for (const path of [`/r/${"b".repeat(26)}`, "/r/not-an-id", "/r/_assets/missing.js", "/r/_assets/../share.html", "/r/_assets/%2e%2e/share.html", "/r/_assets/.hidden.js", "/r/_assets/x.html", `/r/${id}/other.json`, `/r/${id}/bundle.json/x`]) {
    assert.equal((await send(s.port, { path })).status, 404, path);
  }
  assert.equal((await send(s.port, { method: "POST", path: `/r/${id}`, body: "{}" })).status, 405);
});
