// The share host (`agentrun-serve --share-host`, AGENTRUN_SHARE_HOST=1; share-host.ts): a serve install that answers under
// /r/ alone. A share's page is /r/<id>, its stored bytes /r/<id>/bundle.json, the page's assets /r/_assets/*, the API
// /r/v2/shares (a POST that stores a bundle, a GET of the caller's own, a DELETE of one) and /r/v2/health; every other
// address is a 404, the console, the run, agent, key, computer and trigger routes among them. An upload is a canonical
// `agentrun.share/1` document whose sha256 and file digests hold, re-scrubbed by the scrubber in cut mode with this
// host's held values, over the whole body and each string: a value it finds that the bundle does not declare restored
// (exactly where, and of a kind that restores), a restored record naming no such value, or a scrub that fails refuses it
// (422) and nothing is stored. A token keeps at most 100 shares; its owner deletes one, and its page is then 410. A
// share's URL is on AGENTRUN_PUBLIC_URL, never a Host header.
//
// Every bundle is synthetic, made by run-export.ts's own builder from made-up run data, and every planted value is made
// fresh for its case. No test counts requests: a hook on this machine GETs / on every new loopback listener, and each
// test asserts on the shares directory and on the answers to its own requests alone (portProbe once proves a probe is
// a 404 that stores nothing).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { builtConsole, call, serve } from "./support.mjs";
import { unixHome } from "./scrub-positives.mjs";
import { receiver } from "./webhook-support.mjs";

/** One GET of / at the host, as the box's probe of a new loopback listener makes: its status. */
async function portProbe(url) {
  const res = await fetch(new URL("/", url));
  await res.arrayBuffer();
  return res.status;
}

const { exportBundle } = await import("../dist/run-export.js");
const { packageSha256 } = await import("../dist/agent-package.js");
const { stable } = await import("../dist/validate.js");
const { checkShareBundle, screenShare, ShareStore, SHARE_QUOTA, SHARE_STRINGS, SHARE_HOST_CSP, SHARE_HOST_ROUTES } = await import("../dist/share-host.js");
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

test("the host scrubs the whole stored body and each of its strings in cut mode with its held values, and never repairs it", async (t) => {
  const seen = [];
  const s = await shareHost(t, { shareScrub: async (text, opts) => (seen.push({ text, opts }), { ok: true, text: text.replace("42", "[redacted:x]"), cuts: [{ rule: "x", kind: "label", restorable: true, start: 0, end: 2, outStart: 0, outEnd: 12, shape: "…[2]" }], counts: { x: 1 } }) });
  const body = await bundleOf();
  const res = await upload(s, body);
  assert.equal(res.status, 422, "an undeclared restorable cut refuses it too: the host never stores a cut text in place of the sent one");
  assert.equal(res.json.error.details.reason, "scrub_found");
  assert.equal(seen[0].text, body, "the whole body first, as sent");
  const doc = JSON.parse(body);
  assert.ok(seen.some((call) => call.text === doc.run.title) && seen.some((call) => call.text === doc.files[0].content), "then each string alone");
  for (const call of seen) {
    assert.equal(call.opts.mode, "cut");
    assert.ok(call.opts.held.includes(s.alice.token) && call.opts.held.includes(s.bob.token), "its own tokens are held values");
    assert.equal(call.opts.keep, undefined, "the host keeps nothing");
  }
  assert.deepEqual(sharesIn(s.shares), []);
});

const { scrub } = await import("../dist/secret-cut.js");
/** A synthetic home folder and a synthetic password assignment: a personal and a label value the real scrubber finds. */
const plantedRestorable = () => {
  const user = `qa${randomBytes(3).toString("hex").replace(/[0-9]/g, "x")}`;
  const password = `Synthetic-${randomBytes(6).toString("hex")}`;
  return { user, password, content: `# Notes\n\nSee ${unixHome(user)}/proj/a.txt\nPASSWORD=${password}\n` };
};
/** A bundle whose file holds `content`, exported twice by run-export.ts: once to read its cuts, then restoring every
 *  restorable one of them (the owner's preview restore). */
async function restoredBundleOf(content, held = []) {
  const bytes = Buffer.from(content);
  const input = (restore) => ({
    runId: "run_share_restore",
    agent: { name: "share-test-agent" },
    view: { kind: "agentic", status: "succeeded", state: "succeeded", title: `Restore ${nonce()}`, created_at: "2026-11-23T00:00:00.000Z", ended_at: "2026-11-23T00:01:00.000Z", result: { final_answer: "done", output: null, output_error: null } },
    rows: [{ type: "message", role: "assistant", text: "done" }],
    graph: null,
    files: [{ path: "out/notes.md", size: bytes.length, read: async () => bytes }],
    filesTruncated: false,
    held,
    restore,
    version: "0.0.0-share-test",
  });
  const first = JSON.parse((await exportBundle(input([]))).body);
  return (await exportBundle(input(first.cuts.filter((cut) => cut.restorable).map((cut) => cut.id)))).body;
}
/** `doc` with one more restored record, naming the span the real scrubber finds in the string at `at` for `rule`. */
async function declare(doc, at, rule, kind, held = []) {
  const value = at.split("/").slice(1).reduce((node, key) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
  const cut = (await scrub(value, { mode: "cut", held })).cuts.find((each) => each.rule === rule);
  assert.ok(cut, `the scrubber finds ${rule} at ${at}`);
  doc.restored.push({ id: `c_${nonce()}`, at, start: cut.start, end: cut.end, rule, kind });
  return doc;
}

test("a declared restore of a label or personal cut is taken: the host's own scrub finds each value exactly where the bundle says", async (t) => {
  const s = await shareHost(t);
  const planted = plantedRestorable();
  const body = await restoredBundleOf(planted.content);
  const doc = JSON.parse(body);
  assert.deepEqual(doc.restored.map((record) => record.rule).sort(), ["home-path", "secret-assign"], "the export restored both");
  assert.ok(doc.files[0].content.includes(planted.password) && doc.files[0].content.includes(planted.user));
  const res = await upload(s, body);
  assert.equal(res.status, 201, res.text);
  assert.equal((await send(s.port, { path: `/r/${res.json.id}/bundle.json` })).text, body, "stored as sent");
});

test("an undeclared value, a record off by one, or a declared restore of a key format, a held value or a dump refuses the upload: 422, rule ids and counts, never a value", async (t) => {
  const s = await shareHost(t);
  const planted = plantedRestorable();
  const doc = JSON.parse(await restoredBundleOf(planted.content));
  const without = (rule) => ({ ...doc, restored: doc.restored.filter((record) => record.rule !== rule) });
  const shifted = { ...doc, restored: doc.restored.map((record) => (record.rule === "secret-assign" ? { ...record, start: record.start + 1 } : record)) };

  const key = `sk-proj-${randomBytes(24).toString("hex")}`;
  const formatKey = structuredClone(doc);
  formatKey.files[0].content += `OPENAI_KEY_NOTE ${key}\n`;
  formatKey.files[0].bytes = Buffer.byteLength(formatKey.files[0].content);
  formatKey.files[0].sha256 = fileSha(formatKey.files[0].path, formatKey.files[0].content);
  const formatRule = (await scrub(formatKey.files[0].content, { mode: "cut" })).cuts.find((cut) => !cut.restorable && cut.kind === "format")?.rule;
  assert.ok(formatRule, "the scrubber reads the planted key as a format");
  await declare(formatKey, "/files/0/content", formatRule, "label"); // the record lies about its kind

  const heldValue = structuredClone(doc);
  heldValue.rows[0].text = `token ${s.alice.token} here`;
  await declare(heldValue, "/rows/0/text", "held-value", "personal", [s.alice.token]);

  const dump = structuredClone(doc);
  dump.rows[0].text = `$ env\nHOME=/srv\nAPI_KEY=${nonce()}\nDB_PASSWORD=${nonce()}\nPATH=/usr/bin\n`;
  const dumpRule = (await scrub(dump.rows[0].text, { mode: "cut" })).cuts.find((cut) => cut.kind === "dump")?.rule;
  if (dumpRule) await declare(dump, "/rows/0/text", dumpRule, "label");

  for (const [name, changed, rule] of [["no record for the label", without("secret-assign"), "secret-assign"], ["no record for the personal value", without("home-path"), "home-path"], ["a record off by one", shifted, "secret-assign"], ["a declared key format", formatKey, formatRule], ["a declared held value", heldValue, "held-value"], ...(dumpRule ? [["a declared dump", dump, dumpRule]] : [])]) {
    const res = await upload(s, resigned(changed));
    assert.equal(res.status, 422, `${name}: ${res.text}`);
    assert.equal(res.json.error.details.reason, "scrub_found", name);
    assert.ok(res.json.error.details.counts[rule] >= 1, `${name}: ${JSON.stringify(res.json.error.details)}`);
    for (const value of [planted.password, planted.user, key, s.alice.token]) assert.ok(!res.text.includes(value), `${name}: no value in the answer`);
  }
  assert.ok(dumpRule, "the scrubber reads an env listing as a dump");
  assert.deepEqual(sharesIn(s.shares), []);
});

test("a restored record that names no value the host finds is a stale or edited bundle: 422 restored_unmatched", async (t) => {
  const s = await shareHost(t);
  const clean = JSON.parse(await bundleOf());
  const forged = { ...clean, restored: [{ id: "c_0000000000000000", at: "/run/title", start: 0, end: 3, rule: "home-path", kind: "personal" }] };
  const planted = plantedRestorable();
  const doc = JSON.parse(await restoredBundleOf(planted.content));
  const twice = { ...doc, restored: [...doc.restored, doc.restored[0]] };
  // A restorable value where no restore may stand (the bundle's own words): found, and its record excuses nothing.
  const ownWords = structuredClone(clean);
  ownWords.source.agentrun = `${unixHome(planted.user)}/agentrun`;
  await declare(ownWords, "/source/agentrun", "home-path", "personal");
  for (const [name, changed, reason, rule] of [["a forged record", forged, "restored_unmatched", "home-path"], ["one record twice", twice, "restored_unmatched", doc.restored[0].rule], ["a record in the bundle's own words", ownWords, "scrub_found", "home-path"]]) {
    const res = await upload(s, resigned(changed));
    assert.equal(res.status, 422, `${name}: ${res.text}`);
    assert.equal(res.json.error.details.reason, reason, name);
    assert.equal(res.json.error.details.counts[rule], 1, `${name}: ${JSON.stringify(res.json.error.details)}`);
  }
  assert.deepEqual(sharesIn(s.shares), []);
});

test("a file's content is read knowing its path: a credential file's plain contents refuse, also when another file holds the same text", async () => {
  const pgpass = `db.example:5432:app:alice:orchard${nonce()}plain`;
  const doc = JSON.parse(await bundleOf());
  const fileOf = (path) => ({ ...doc.files[0], path, content: `${pgpass}\n`, bytes: Buffer.byteLength(`${pgpass}\n`), sha256: fileSha(path, `${pgpass}\n`) });
  // Alone, and after a file of the same text under a name that is no credential file's (read first, by the order).
  for (const files of [[fileOf(".pgpass")], [fileOf("notes/a.txt"), fileOf(".pgpass")]]) {
    const body = resigned({ ...doc, files });
    await assert.rejects(screenShare(body, []), (error) => error.code === "input_invalid" && (error.extra.details.counts["credential-file"] ?? 0) >= 1, files.map((file) => file.path).join());
  }
  // A string read with no path (the agent's name, read before the files) that spells the file's read can't stand in for it.
  const forged = resigned({ ...doc, agent: { ...doc.agent, name: JSON.stringify([".pgpass", `${pgpass}\n`]) }, files: [fileOf(".pgpass")] });
  await assert.rejects(screenShare(forged, []), (error) => error.code === "input_invalid" && (error.extra.details.counts["credential-file"] ?? 0) >= 1, "a forged name");
});

test("a workflow call's output is read knowing its call: a credential file's plain contents in a graph effect refuse", async () => {
  const pgpass = `db.example:5432:app:alice:orchard${nonce()}plain`;
  const doc = JSON.parse(await bundleOf());
  const effect = (tool, input, output) => ({ node: "step", executionPath: "step", item: null, tool, status: "done", input, output, error: null, startedAt: "2026-01-02T03:04:05.000Z", endedAt: "2026-01-02T03:04:06.000Z" });
  const plain = effect("notes", { topic: "a" }, `${pgpass}\n`);
  for (const [name, read] of [
    ["a read of .pgpass", effect("read", { path: ".pgpass" }, `${pgpass}\n`)],
    ["a shell's cat of it, its output nested", effect("bash", { command: "cat ~/.pgpass" }, { stdout: `${pgpass}\n`, exit: 0 })],
  ]) {
    // Alone, and after a call whose output is the same text but says no file (read first, by the order).
    for (const effects of [[read], [plain, read]]) {
      const body = resigned({ ...doc, graph: { ...GRAPH, effects, totals: { ...GRAPH.totals, effects: effects.length } } });
      await assert.rejects(screenShare(body, []), (error) => error.code === "input_invalid" && (error.extra.details.counts["credential-file"] ?? 0) + (error.extra.details.counts["env-dump"] ?? 0) >= 1, `${name}, ${effects.length} effect(s)`);
    }
  }
  // A call whose output says no file is read as before: its text is no credential file's.
  const body = resigned({ ...doc, graph: { ...GRAPH, effects: [plain], totals: { ...GRAPH.totals, effects: 1 } } });
  await screenShare(body, []);
});

test("a call's long command is read once per call, never once per string of its output: ≥1 MiB of command over 5,000 strings screens in bounded time", { timeout: 900_000 }, async () => {
  // Each string of a call's output is read with the call's context (its command): a read key, or any per-string work,
  // that copies or re-reads the command costs strings × command, minutes and gigabytes here, while every other upload
  // on the host waits. One effect, a long command that prints no environment, and many short distinct strings.
  const strings = Number(process.env.SHARE_LONG_COMMAND_STRINGS ?? 5_000);
  const doc = JSON.parse(await bundleOf());
  const script = Array.from({ length: Math.ceil((1 << 20) / 26) }, (_, i) => `printf '%s' row${String(i).padStart(8, "0")}x; `).join("");
  const output = Array.from({ length: strings }, (_, i) => `row ${i} of the report`);
  const effect = { node: "step", executionPath: "step", item: null, tool: "bash", status: "done", input: { command: script }, output, error: null, startedAt: "2026-01-02T03:04:05.000Z", endedAt: "2026-01-02T03:04:06.000Z" };
  const body = resigned({ ...doc, graph: { ...GRAPH, effects: [effect], totals: { ...GRAPH.totals, effects: 1 } } });
  assert.ok(script.length >= 1 << 20);
  const started = performance.now();
  await screenShare(body, []).catch((error) => assert.ok(error.status === 413 || error.code === "input_invalid", String(error)));
  const ms = performance.now() - started;
  // Under a second at the fix on an idle box (a pass per string, the command read once; about 6 s at a load of 160, as
  // with a two-character command): 60 s is far over that, and far under strings × command (about 5 minutes before).
  assert.ok(ms < 60_000, `${Math.round(ms)} ms`);
});

test("the string cap counts a text once per call context it is read under, and bounds the reads: past it is 413 before any scrub", async () => {
  // Each string is read once per context it stands under (a file's path, a call's command), so the cap counts those
  // reads: the same output under three commands is three reads each, under one command one.
  const doc = JSON.parse(await bundleOf());
  const effect = (command) => ({ node: "step", executionPath: "step", item: null, tool: "bash", status: "done", input: { command }, output: ["alpha", "beta", "gamma"], error: null, startedAt: "2026-01-02T03:04:05.000Z", endedAt: "2026-01-02T03:04:06.000Z" });
  const bodyOf = (commands) => resigned({ ...doc, graph: { ...GRAPH, effects: commands.map(effect), totals: { ...GRAPH.totals, effects: commands.length } } });
  let passes = 0;
  const counting = async (text, opts) => {
    passes++;
    return scrub(text, opts);
  };
  const countOf = async (body) => {
    const refused = await screenShare(body, [], counting, 1).then(() => assert.fail("a cap of 1 took the bundle"), (error) => error);
    assert.ok(refused.status === 413 && refused.extra.details.reason === "share_strings", String(refused));
    return refused.extra.details.strings;
  };
  const three = bodyOf(["ls a", "ls b", "ls c"]);
  const counted = await countOf(three);
  // Two more commands (two strings) and the three outputs read twice more (six reads).
  assert.equal(counted - (await countOf(bodyOf(["ls a", "ls a", "ls a"]))), 8);
  assert.equal(passes, 0, "a refusal past the cap reads nothing");
  // At the cap, taken: the whole body once and each counted read once, no more.
  await screenShare(three, [], counting, counted);
  assert.equal(passes, 1 + counted);
});

test("each string is read alone too: a label the whole-body read misses still refuses", async (t) => {
  const planted = plantedRestorable();
  const doc = JSON.parse(await restoredBundleOf(planted.content));
  const body = resigned({ ...doc, restored: doc.restored.filter((record) => record.rule !== "secret-assign") });
  // The scrubber reads a body's JSON-decoded views too, so it finds this label in the whole body today. Blind that one
  // read: the per-string reads alone must still find the label and refuse.
  const blind = (text, opts) => scrub(text === body ? "" : text, opts);
  assert.equal(((await blind(body, { mode: "count" })).counts ?? {})["secret-assign"] ?? 0, 0, "the blinded whole-body read finds nothing");
  await assert.rejects(screenShare(body, [], blind), (error) => error.code === "input_invalid" && error.extra.details.counts["secret-assign"] === 1);
  // And the host as it runs refuses it too.
  const s = await shareHost(t);
  const res = await upload(s, body);
  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.error.details.counts["secret-assign"], 1);
});

test("a restored record of Jev's rule that names no value the host finds is taken unchecked and counted; one over a value the rules catch still refuses", async (t) => {
  const s = await shareHost(t);
  // Jev runs on the owner's server alone: the host finds nothing where the record says, and takes the record unchecked.
  const clean = JSON.parse(await bundleOf());
  const jev = { ...clean, restored: [{ id: "c_1111111111111111", at: "/rows/0/text", start: 0, end: 4, rule: "jev", kind: "jev" }] };
  const body = resigned(jev);
  const taken = await upload(s, body);
  assert.equal(taken.status, 201, taken.text);
  assert.deepEqual(taken.json.restored_unchecked, { jev: 1 });
  assert.equal((await send(s.port, { path: `/r/${taken.json.id}/bundle.json` })).text, body);
  // The value under a Jev record is scrubbed as any other: a password there needs its own record of its own rule.
  const planted = plantedRestorable();
  const doc = JSON.parse(await restoredBundleOf(planted.content));
  const relabelled = { ...doc, restored: doc.restored.map((record) => (record.rule === "secret-assign" ? { ...record, rule: "jev", kind: "jev" } : record)) };
  const refused = await upload(s, resigned(relabelled));
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.error.details.reason, "scrub_found");
  assert.equal(refused.json.error.details.counts["secret-assign"], 1);
  assert.deepEqual(refused.json.error.details.unchecked, { jev: 1 });
  assert.ok(!refused.text.includes(planted.password));
  // Any other rule's record that names nothing is still refused.
  const other = await upload(s, resigned({ ...clean, restored: [{ ...jev.restored[0], rule: "email", kind: "personal" }] }));
  assert.equal(other.status, 422, other.text);
  assert.equal(other.json.error.details.reason, "restored_unmatched");
  assert.deepEqual((await send(s.port, { path: "/r/v2/shares", token: s.alice.token })).json.shares.length, 1);
});

test(`an upload of more than SHARE_STRINGS (${SHARE_STRINGS}) distinct strings is 413 before any scrub; at the cap it is read`, async (t) => {
  let scrubs = 0;
  const s = await shareHost(t, { shareScrub: async (text, opts) => (scrubs++, scrub(text, opts)) });
  const doc = JSON.parse(await bundleOf());
  for (let index = 0; index <= SHARE_STRINGS; index++) doc.rows.push({ type: "message", role: "user", text: `n${index}` });
  const res = await upload(s, resigned(doc));
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error.details.reason, "share_strings");
  assert.equal(res.json.error.details.limit, SHARE_STRINGS);
  assert.ok(res.json.error.details.strings > SHARE_STRINGS);
  assert.equal(scrubs, 0, "nothing was scrubbed");
  assert.deepEqual(sharesIn(s.shares), []);
  // The cap counts distinct non-empty strings: a bundle at it is read, one over it is not.
  const clean = await bundleOf();
  const strings = new Set();
  const walk = (value) => (typeof value === "string" ? value && strings.add(value) : value && typeof value === "object" && Object.values(value).forEach(walk));
  walk(JSON.parse(clean));
  assert.deepEqual(await screenShare(clean, [], undefined, strings.size), { unchecked: {} });
  await assert.rejects(screenShare(clean, [], undefined, strings.size - 1), (error) => error.code === "payload_too_large" && error.extra.details.strings === strings.size);
});

test("a body that is not UTF-8 is 400 and stores nothing, even when its sha256 matches the text a lenient read makes of it; a byte-order mark is refused, not dropped", async (t) => {
  const s = await shareHost(t);
  const doc = JSON.parse(await bundleOf());
  doc.run.title = `Multiply two numbers \uFFFD ${nonce()}`;
  const text = resigned(doc);
  const bytes = Buffer.from(text, "utf8");
  const at = bytes.indexOf(Buffer.from("\uFFFD", "utf8"));
  // One invalid byte where the replacement character was: a lenient read makes exactly the text whose digest is signed.
  const sent = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)]);
  assert.equal(sent.toString("utf8"), text);
  const res = await upload(s, sent);
  assert.equal(res.status, 400, res.text);
  assert.match(res.json.error.message, /not UTF-8/);
  const bom = await upload(s, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(await bundleOf())]));
  assert.equal(bom.status, 400, bom.text);
  assert.deepEqual(sharesIn(s.shares), [], "nothing stored");
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

/** A workflow run's graph as the export carries it: the route's fields, its run's ids dropped. */
const GRAPH = {
  run: { status: "completed", paused: false, startedAt: "2026-01-02T03:04:05.000Z", endedAt: "2026-01-02T03:04:06.000Z" },
  workflow: null,
  graph: { nodes: [{ path: "step", kind: "agent" }], edges: [] },
  nodes: { step: { status: "done" } },
  decisions: [],
  effects: [],
  totals: { cost_usd: null, decisions: 0, effects: 0, elapsed_ms: 1000 },
};

test("the bundle's shape is checked: its format, its closed keys at each level the host reads, and the export's caps", async () => {
  const doc = JSON.parse(await bundleOf());
  assert.equal(checkShareBundle(resigned(doc)).sha256, doc.sha256);
  // A workflow's graph as its route serves it (graph-view.ts) is taken; one the page cannot draw is refused.
  const graphed = { ...structuredClone(doc), graph: GRAPH };
  assert.equal(checkShareBundle(resigned(graphed)).sha256, JSON.parse(resigned(graphed)).sha256);
  // Each run field the page reads may be null, or of its type; a run with every field set so is taken.
  const typed = structuredClone(doc);
  Object.assign(typed.run, { error: null, review: null, cost: { usd: 0.01, basis: "metered" }, stopped_for: null, budget_refused_calls: 0, effort: null, approvals: "auto" });
  assert.equal(checkShareBundle(resigned(typed)).sha256, JSON.parse(resigned(typed)).sha256);
  const refused = {
    format: (d) => (d.format = "agentrun.share/2"),
    extraTop: (d) => (d.exported_by = "someone"),
    missingTop: (d) => delete d.omitted,
    runField: (d) => (d.run.run_id = "run_1"),
    // A run field of another type: the page would throw on it (Redactions reads a title's text).
    runTitleObject: (d) => (d.run.title = {}),
    runStatusNumber: (d) => (d.run.status = 1),
    runCreatedArray: (d) => (d.run.created_at = []),
    runEndedNumber: (d) => (d.run.ended_at = 1),
    runResultString: (d) => (d.run.result = "done"),
    runErrorArray: (d) => (d.run.error = []),
    runReviewString: (d) => (d.run.review = "x"),
    runCostString: (d) => (d.run.cost = "$1"),
    runRefusedCallsString: (d) => (d.run.budget_refused_calls = "2"),
    runEffortObject: (d) => (d.run.effort = {}),
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
    graphEmpty: (d) => (d.graph = {}),
    graphNoNodes: (d) => (d.graph = { ...GRAPH, nodes: undefined }),
    graphFlowNoEdges: (d) => (d.graph = { ...GRAPH, graph: { nodes: [] } }),
    graphFlowNode: (d) => (d.graph = { ...GRAPH, graph: { nodes: [null], edges: [] } }),
    graphRunStatus: (d) => (d.graph = { ...GRAPH, run: { paused: false } }),
    graphDecisions: (d) => (d.graph = { ...GRAPH, decisions: {} }),
    graphTotals: (d) => (d.graph = { ...GRAPH, totals: { decisions: 0 } }),
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

test("a share host fires nothing a reused data folder holds: its triggers never start, so no clock is read and nothing armed", async (t) => {
  const asked = [];
  const triggerClock = { now: () => (asked.push("now"), Date.now()), arm: (_fire, ms) => (asked.push(`arm ${ms}`), { clear() {} }) };
  const s = await shareHost(t, { triggerClock });
  assert.equal((await send(s.port, { path: "/r/v2/health" })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(asked, [], "no schedule or feed runs on a share host");
});

test("a share host publishes no agent's local sources: the 30 s source sweep a plain server arms is never set", async (t) => {
  // A reused folder can hold an agent with local source sync on; the sweep would write that agent's new revisions,
  // which a share host neither runs nor shows. Its timer is read where it is set: a callback naming the sweep.
  const armed = async (options) => {
    const real = globalThis.setInterval;
    const sweeps = [];
    globalThis.setInterval = (fn, ms, ...rest) => {
      if (String(fn).includes("sweepLocalSources")) sweeps.push(ms);
      return real(fn, ms, ...rest);
    };
    try {
      await options();
    } finally {
      globalThis.setInterval = real;
    }
    return sweeps;
  };
  assert.deepEqual(await armed(() => serve(t, { runner: false })), [30_000], "a plain server arms the sweep (the probe sees it)");
  assert.deepEqual(await armed(() => shareHost(t)), [], "a share host arms no source sweep");
});

test("a share host sends nothing a reused data folder left queued, but still holds its saved secrets: no delivery resumes, no run's change is followed, and an upload carrying the webhook's key is refused", async (t) => {
  const hook = await receiver(t);
  // A server that sent webhooks, on the folder the host reuses: its webhook set, and a message it left queued.
  const before = await serve(t, { runner: false, webhookPrivateTargets: true });
  const set = await before.api("PUT", "/settings/webhook", { url: hook.url });
  assert.equal(set.status, 201);
  // The signing key alone, as it is pasted: no key format names it, only the host's held values do.
  assert.match(set.body.signing_secret, /^whsec_/);
  const bare = set.body.signing_secret.slice("whsec_".length);
  await before.store.channels.post({ id: "msg_left_queued", channel: "webhook-out", moment: "run.ended", body: '{"type":"run.ended"}', nextAt: 0 });
  await before.stop();
  const host = await shareHost(t, { data: before.data, webhookPrivateTargets: true });
  assert.equal((await send(host.port, { path: "/r/v2/health" })).status, 200);
  const doc = JSON.parse(await bundleOf());
  doc.run.result.final_answer = `the webhook signs with ${bare}`;
  const refused = await upload(host, resigned(doc));
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.error.details.reason, "scrub_found");
  assert.ok(!refused.text.includes(bare), "the answer holds no value");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await host.stop();
  assert.deepEqual(hook.got, [], "the share host sent no message");
  // The same folder under a server that is no share host sends it: the message was there to send.
  await serve(t, { runner: false, webhookPrivateTargets: true, data: before.data });
  await hook.when(1);
});

test("a deleted share's bytes go even when its delete was cut short: a second delete, and the next start, finish it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "share-store-"));
  const body = await bundleOf();
  const store = new ShareStore(dir);
  const meta = await store.create("tok_a", body, JSON.parse(body).sha256, SHARE_QUOTA);
  await store.delete(meta.id, "tok_a");
  assert.equal(existsSync(join(dir, meta.id, "bundle.json")), false);
  // As if the bytes' removal failed, or the process stopped, after the tombstone was written.
  await writeFile(join(dir, meta.id, "bundle.json"), body);
  await store.delete(meta.id, "tok_a");
  assert.equal(existsSync(join(dir, meta.id, "bundle.json")), false, "a second delete removes them");

  await writeFile(join(dir, meta.id, "bundle.json"), body);
  // A share whose create stopped between its bytes and its meta: bytes nothing names.
  const orphan = "a".repeat(26);
  await mkdir(join(dir, orphan), { mode: 0o700 });
  await writeFile(join(dir, orphan, "bundle.json"), body);
  const restarted = new ShareStore(dir);
  assert.equal((await restarted.get(meta.id))?.deleted_at !== undefined, true, "the tombstone still answers 410");
  assert.equal(existsSync(join(dir, meta.id, "bundle.json")), false, "the next start removes a tombstone's bytes");
  assert.equal(existsSync(join(dir, orphan)), false, "and a share folder with no meta");
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
  // The hosted page's CSP is the local preview's, never a looser copy of it.
  assert.equal(SHARE_HOST_CSP, (await import("../dist/page.js")).SHARE_PAGE_CSP);
  assert.equal((await send(s.port, { method: "HEAD", path: `/r/${id}` })).status, 200);
  for (const path of [`/r/${"b".repeat(26)}`, "/r/not-an-id", "/r/_assets/missing.js", "/r/_assets/../share.html", "/r/_assets/%2e%2e/share.html", "/r/_assets/.hidden.js", "/r/_assets/x.html", `/r/${id}/other.json`, `/r/${id}/bundle.json/x`]) {
    assert.equal((await send(s.port, { path })).status, 404, path);
  }
  assert.equal((await send(s.port, { method: "POST", path: `/r/${id}`, body: "{}" })).status, 405);
});
