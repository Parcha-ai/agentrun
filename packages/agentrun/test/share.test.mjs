// `agentrun share RUN --dry-run`: the run's share bundle (GET /v2/runs/RUN/export) from the server this CLI resolves,
// a summary of it printed (cuts by kind, how many may be restored, its sha256 and size, what it left out), and the
// preview page, <origin>/share/RUN, opened in the browser. `--out FILE` writes the bundle's bytes as served, `--restore`
// asks the server to keep restorable cuts, `--expect SHA` refuses a bundle whose sha256 is another. Without --dry-run (or
// --out) it publishes nothing and exits 2. A fake server on loopback answers the export; the opener is injected, so
// nothing opens. Synthetic data only.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, runLocal } from "../lib/cli.mjs";
import { shareOf } from "../lib/share.mjs";
import { START_LOG } from "../lib/start.mjs";
import { removeAtEnd } from "./support.mjs";

const CANARY = "share-canary-token-5b1e9d3f7a2c4e6081a3c5e7f9b1d3f5";
const HOST = "127.0.0.1";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-share-"));
  removeAtEnd(dir);
  return dir;
};

/** The canonical JSON the bundle is written in (serve's validate.ts `stable`): keys sorted, no spaces. */
const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value));
const sha256Of = (text) => createHash("sha256").update(text).digest("hex");
/** A synthetic cut id, as the server names them: c_ and 16 hex digits. */
const cutId = (n) => `c_${sha256Of(`cut-${n}`).slice(0, 16)}`;

/** A synthetic agentrun.share/1 bundle of run `run`. `planted` stands in for a run's words: the CLI prints none of the
 *  bundle's text, so it must show up in no output. Its body as served and its sha256. */
function bundleOf(run, planted, { tamper = false, restored = [], omitted = [{ what: "file", path: "out/shot.png", why: "binary" }, { what: "recordings", why: "never" }] } = {}) {
  const content = `# Report\n\n${planted}\n`;
  const cut = (n, kind, rule, restorable) => ({ id: cutId(n), at: "/rows/0/text", start: 4 * n, end: 4 * n + 3, rule, kind, restorable, shape: `${planted}[3]` });
  const doc = {
    format: "agentrun.share/1",
    source: { agentrun: "0.0.0-test", scrubber: { version: 1, rules: "0".repeat(64) } },
    agent: { name: `Agent ${planted}`, kind: "agentic" },
    run: { status: "completed", kind: "agentic", output: `Done: ${planted}` },
    rows: [{ kind: "message", text: `The report says ${planted}.` }],
    graph: null,
    files: [{ path: "out/report.md", bytes: Buffer.byteLength(content), sha256: sha256Of(content), encoding: "utf8", content }],
    omitted,
    cuts: [cut(1, "label", "pg-password", true), cut(2, "label", "pg-password", true), cut(3, "personal", "home-path", true), cut(4, "format", "anthropic-key", false), cut(5, "held", "held-value", false)],
    restored,
  };
  const sha256 = sha256Of(stable(doc));
  const body = stable({ ...doc, ...(tamper ? { rows: [] } : {}), sha256 });
  return { body, sha256 };
}

/** The server the CLI resolves, on loopback: only GET /v2/runs/RUN/export is its own, kept in `got` (its query and
 *  token) and answered by `answer(res, query)`. Anything else (the GET / a tool on this box sends to each new loopback
 *  listener among it) is answered 404 and neither read nor kept. A data directory whose record and token name it. */
async function fakeServer(t, run, answer) {
  const got = [];
  const path = `/v2/runs/${encodeURIComponent(run)}/export`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://h");
    if (req.method !== "GET" || url.pathname !== path) {
      req.resume();
      return void res.writeHead(404).end();
    }
    got.push({ query: url.search, authorization: req.headers.authorization });
    answer(res, url.searchParams);
  });
  await new Promise((done) => server.listen(0, HOST, done));
  t.after(() => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))));
  const port = server.address().port;
  const data = fresh();
  writeFileSync(join(data, ".server.json"), `${JSON.stringify({ base_url: `http://${HOST}:${port}/v2`, pid: process.pid, token_file: join(data, ".token") })}\n`, { mode: 0o600 });
  writeFileSync(join(data, ".token"), `${CANARY}\n`, { mode: 0o600 });
  return { got, data, port, page: `http://${HOST}:${port}/share/${encodeURIComponent(run)}` };
}

/** A port probe: the GET / another process on the machine may send to any new loopback listener. Its status. */
async function portProbe(port) {
  const res = await fetch(`http://${HOST}:${port}/`);
  await res.arrayBuffer();
  return res.status;
}

const sendBundle = (body) => (res) => res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
const sendError = (status, code, message) => (res) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code, message, retryable: false, request_id: "req_test" } }));

const ioOf = () => {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (text) => out.push(String(text)), on() {}, isTTY: false }, stderr: { write: (text) => err.push(String(text)) } }, out, err };
};

/** `agentrun share ...` as the CLI runs it (its flags, its target, its client), with the opener injected: `opened` is
 *  every [command, ...args] it was asked to launch. A display is set unless `env` says otherwise. */
async function share(argv, { data, env = { DISPLAY: ":0" }, platform = "linux", files } = {}) {
  const opened = [];
  const launch = async (command, args) => (opened.push([command, ...args]), true);
  const { io, out, err } = ioOf();
  const code = await runLocal(shareOf({ launch, platform, ...(files ? { files } : {}) }), ["share", ...argv, "--data", data], { XDG_CONFIG_HOME: fresh(), ...env }, io);
  return { code, out: out.join(""), err: err.join(""), opened };
}

const nonce = () => randomBytes(4).toString("hex");
const silent = (result, ...values) => {
  for (const value of [CANARY, ...values]) assert.ok(!result.out.includes(value) && !result.err.includes(value), `${value} is printed nowhere`);
};

test("share --dry-run fetches the run's export, prints its summary (and no word of the run), and opens /share/RUN", async (t) => {
  const run = `run_share_${nonce()}`;
  const planted = `planted-share-value-${nonce()}`;
  const { body, sha256 } = bundleOf(run, planted);
  const fake = await fakeServer(t, run, sendBundle(body));
  assert.equal(await portProbe(fake.port), 404, "a port probe is answered 404");

  const result = await share([run, "--dry-run"], { data: fake.data });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(fake.got, [{ query: "", authorization: `Bearer ${CANARY}` }], "one export, with the local token, and the probe not counted");
  assert.deepEqual(result.opened, [["xdg-open", fake.page]]);
  const summary = JSON.parse(result.out);
  assert.equal(summary.run, run);
  assert.equal(summary.sha256, sha256);
  assert.equal(summary.bytes, Buffer.byteLength(body));
  assert.deepEqual(summary.cuts, { total: 5, restorable: 3, by_kind: { format: 1, held: 1, label: 2, personal: 1 } });
  assert.equal(summary.restored, 0);
  assert.deepEqual(summary.omitted, [{ what: "file", path: "out/shot.png", why: "binary" }, { what: "recordings", why: "never" }]);
  assert.equal(summary.page, fake.page);
  assert.equal(summary.opened, true);
  assert.equal(summary.out, null);
  // The person reads it on stderr: counts by kind, the restorable count, the sha and the size, what was left out.
  assert.match(result.err, /5 cuts: 2 label, 1 personal, 1 format, 1 held; 3 restorable/);
  assert.match(result.err, new RegExp(`sha256 ${sha256}, ${Buffer.byteLength(body)} bytes`));
  assert.match(result.err, /Omitted: out\/shot\.png \(binary\), recordings \(never\)/);
  assert.match(result.err, /Nothing was sent anywhere/);
  assert.ok(result.err.includes(fake.page), "the link is printed for when no browser opens");
  silent(result, planted);
});

test("share --dry-run with no display, or with --no-open, opens nothing and prints the link", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const headless = await share([run, "--dry-run"], { data: fake.data, env: {} });
  assert.equal(headless.code, 0, headless.err);
  assert.deepEqual(headless.opened, []);
  assert.equal(JSON.parse(headless.out).opened, false);
  assert.match(headless.err, new RegExp(`The share preview: ${fake.page.replace(/[.?]/g, "\\$&")}`));

  const quiet = await share([run, "--dry-run", "--no-open"], { data: fake.data });
  assert.equal(quiet.code, 0, quiet.err);
  assert.deepEqual(quiet.opened, [], "--no-open launches no opener, display or not");
  assert.equal(JSON.parse(quiet.out).opened, false);
  assert.ok(quiet.err.includes(fake.page));
  assert.equal(fake.got.length, 2);
});

/** The start log `agentrun start` keeps in the data folder (start.mjs START_LOG): the server's banner up to its "Open "
 *  line, `open` here. Its API key line stands in for the token the banner names. */
const startLog = (data, open, mode = 0o600) => {
  const file = join(data, START_LOG);
  writeFileSync(file, `agentrun-serve on http://${HOST}:1/v2 (agent store in a folder)\nAGENTRUN_BASE_URL=http://${HOST}:1/v2\nAGENTRUN_API_KEY=${CANARY}\n${open}\nBoxes: none\n`, { mode });
  chmodSync(file, mode);
};
const SIGN_IN_HINT = "Open the console's link from `agentrun start` first if the page asks you to sign in.";

test("share --dry-run hands the opener alone the start's launch code for the same server, and prints neither the code nor a link with it", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const code = `launchcode${nonce()}${nonce()}`;
  startLog(fake.data, `Open http://${HOST}:${fake.port}/?launch=${code}`);

  const opened = await share([run, "--dry-run"], { data: fake.data });
  assert.equal(opened.code, 0, opened.err);
  assert.deepEqual(opened.opened, [["xdg-open", `${fake.page}?launch=${code}`]], "the opener gets the code, so the browser gets a session");
  assert.equal(JSON.parse(opened.out).page, fake.page, "the printed page has no code");
  assert.ok(opened.err.includes(`If no browser opened, open ${fake.page}\n`), opened.err);
  assert.ok(opened.err.includes(SIGN_IN_HINT), opened.err);
  silent(opened, code);

  // Where no browser opens, or with --no-open: the link printed has no code, and the hint says where a session comes from.
  for (const [argv, env] of [[[run, "--dry-run", "--no-open"], { DISPLAY: ":0" }], [[run, "--dry-run"], {}]]) {
    const printed = await share(argv, { data: fake.data, env });
    assert.equal(printed.code, 0, printed.err);
    assert.deepEqual(printed.opened, []);
    assert.ok(printed.err.includes(`The share preview: ${fake.page}\n`), printed.err);
    assert.ok(printed.err.includes(SIGN_IN_HINT), printed.err);
    silent(printed, code);
  }

  // A refusal says nothing of it either.
  const refused = await share([run, "--dry-run", "--expect", sha256Of("another")], { data: fake.data });
  assert.equal(refused.code, 1, refused.err);
  silent(refused, code);
});

test("share --dry-run opens /share/RUN with no code when the start's link is another server's, carries none, or is not a private file", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const code = `launchcode${nonce()}${nonce()}`;
  const cases = [
    ["no start log", () => {}],
    ["another server's origin", () => startLog(fake.data, `Open http://${HOST}:${fake.port === 65535 ? 65534 : fake.port + 1}/?launch=${code}`)],
    ["another host on the same port", () => startLog(fake.data, `Open http://localhost:${fake.port}/?launch=${code}`)],
    ["a link with no launch code (a server with accounts)", () => startLog(fake.data, `Open http://${HOST}:${fake.port}/`)],
    ["a start log others may read", () => startLog(fake.data, `Open http://${HOST}:${fake.port}/?launch=${code}`, 0o644)],
  ];
  for (const [name, plant] of cases) {
    plant();
    const result = await share([run, "--dry-run"], { data: fake.data });
    assert.equal(result.code, 0, `${name}: ${result.err}`);
    assert.deepEqual(result.opened, [["xdg-open", fake.page]], name);
    assert.ok(!result.err.includes(SIGN_IN_HINT), `${name}: no start link, so no hint`);
    silent(result, code);
  }
});

test("share --out writes the bundle's bytes as served (0600), refuses a file that exists, and opens nothing without --dry-run", async (t) => {
  const run = `run_share_${nonce()}`;
  const planted = `planted-share-value-${nonce()}`;
  const { body, sha256 } = bundleOf(run, planted);
  const fake = await fakeServer(t, run, sendBundle(body));
  const dir = fresh();
  const file = join(dir, "bundle.json");

  const written = await share([run, "--out", file], { data: fake.data });
  assert.equal(written.code, 0, written.err);
  assert.deepEqual(readFileSync(file), Buffer.from(body), "byte for byte what the server served");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const { sha256: named, ...rest } = doc;
  assert.equal(named, sha256);
  assert.equal(sha256Of(stable(rest)), sha256, "the file hashes to the sha256 it names");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(written.opened, [], "--out alone opens nothing");
  assert.equal(JSON.parse(written.out).out, file);
  silent(written, planted);

  // A file in the way: refused before anything is asked of the server, and left as it was.
  const before = fake.got.length;
  const again = await share([run, "--dry-run", "--out", file], { data: fake.data });
  assert.equal(again.code, 2, again.err);
  assert.match(again.err, /already exists/);
  assert.equal(fake.got.length, before, "nothing was asked of the server");
  assert.deepEqual(again.opened, []);
  assert.deepEqual(readFileSync(file), Buffer.from(body));

  // A folder that is not there: said plainly (exit 1), nothing opened.
  const nowhere = await share([run, "--dry-run", "--out", join(dir, "missing", "bundle.json")], { data: fake.data });
  assert.equal(nowhere.code, 1, nowhere.err);
  assert.match(nowhere.err, /Cannot write .*\(ENOENT\)\. Nothing was written or opened\./);
  assert.deepEqual(nowhere.opened, []);

  // With --dry-run as well: written, and the page opened.
  const both = join(dir, "both.json");
  const previewed = await share([run, "--dry-run", "--out", both], { data: fake.data });
  assert.equal(previewed.code, 0, previewed.err);
  assert.deepEqual(readFileSync(both), Buffer.from(body));
  assert.deepEqual(previewed.opened, [["xdg-open", fake.page]]);
});

test("share --dry-run prints an omitted path with a restored value in it masked: the restore is for the page, never the terminal", async (t) => {
  const run = `run_share_${nonce()}`;
  const person = `someone.${nonce()}@sample-mail.zz`;
  const path = `out/${person}.png`;
  const omitted = [{ what: "file", path, why: "binary" }, { what: "recordings", why: "never" }];
  const restored = [{ id: cutId(6), at: "/omitted/0/path", start: 4, end: 4 + person.length, rule: "email", kind: "personal" }];
  const { body } = bundleOf(run, "synthetic", { omitted, restored });
  const fake = await fakeServer(t, run, sendBundle(body));
  const result = await share([run, "--dry-run", "--restore", cutId(6)], { data: fake.data });
  assert.equal(result.code, 0, result.err);
  assert.ok(!result.out.includes(person) && !result.err.includes(person), "the restored value is in no output");
  assert.deepEqual(JSON.parse(result.out).omitted[0], { what: "file", path: "out/[redacted:email].png", why: "binary" });
  assert.match(result.err, /Omitted: out\/\[redacted:email\]\.png \(binary\)/);
});

test("share --out that fails partway (a full disk) leaves no file behind, so the same command can run again; a file already there is never removed", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const dir = fresh();
  const file = join(dir, "bundle.json");
  // A disk that takes 10 bytes and then is full.
  const full = { ...fs, writeSync: (fd, buffer, offset, length) => { fs.writeSync(fd, buffer, offset, Math.min(length, 10)); throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } };
  const failed = await share([run, "--out", file], { data: fake.data, files: full });
  assert.equal(failed.code, 1, failed.err);
  assert.match(failed.err, /Cannot write .* \(ENOSPC\)\. Nothing was written or opened/);
  assert.equal(existsSync(file), false, "the part written is gone");
  const again = await share([run, "--out", file], { data: fake.data });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(readFileSync(file), Buffer.from(body));
  // A file that was there before is left as it was.
  const kept = await share([run, "--out", file], { data: fake.data, files: full });
  assert.equal(kept.code, 2, kept.err);
  assert.deepEqual(readFileSync(file), Buffer.from(body));
});

test("share --restore passes the ids as ?restore=; a refusal (400) is printed plainly and nothing is written or opened", async (t) => {
  const run = `run_share_${nonce()}`;
  const keep = [cutId(1), cutId(3)];
  const { body } = bundleOf(run, "synthetic", { restored: [] });
  const refusal = `${cutId(4)} is a cut of a known key format, a value this server holds, or a dump: not restorable. Nothing was restored.`;
  const fake = await fakeServer(t, run, (res, query) => (query.get("restore")?.includes(cutId(4)) ? sendError(400, "bad_request", refusal)(res) : sendBundle(body)(res)));

  const restored = await share([run, "--dry-run", "--restore", keep.join(",")], { data: fake.data });
  assert.equal(restored.code, 0, restored.err);
  assert.equal(new URLSearchParams(fake.got[0].query).get("restore"), keep.join(","));
  // The page opens with the same restores, so its first read is the bundle this summary is of.
  const page = `${fake.page}?${new URLSearchParams({ restore: keep.join(",") })}`;
  assert.deepEqual(restored.opened, [["xdg-open", page]], "the opened page carries the restores");
  assert.equal(JSON.parse(restored.out).page, page, "and so does the printed one");

  const file = join(fresh(), "bundle.json");
  const refused = await share([run, "--dry-run", "--restore", cutId(4), "--out", file], { data: fake.data });
  assert.equal(refused.code, 2, refused.err);
  assert.equal(new URLSearchParams(fake.got[1].query).get("restore"), cutId(4));
  assert.ok(refused.err.includes(refusal), refused.err);
  assert.doesNotMatch(refused.err, /"error"|request_id/, "the server's message, not its JSON");
  assert.match(refused.err, /Nothing was written or opened/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(refused.opened, []);
  assert.equal(refused.out, "");

  // Anything but cut ids (a value pasted there) is refused here, never sent and never echoed.
  const pasted = `pasted-value-${nonce()}`;
  const bad = await share([run, "--dry-run", "--restore", `${cutId(1)},${pasted}`], { data: fake.data });
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.err, /--restore takes cut ids/);
  assert.equal(fake.got.length, 2, "nothing was sent");
  silent(bad, pasted);
});

test("share --expect SHA refuses a bundle whose sha256 is another, and passes one that matches", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body, sha256 } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const other = sha256Of("another export");
  const file = join(fresh(), "bundle.json");

  const drifted = await share([run, "--dry-run", "--expect", other, "--out", file], { data: fake.data });
  assert.equal(drifted.code, 1, drifted.err);
  assert.ok(drifted.err.includes(`sha256 is ${sha256}, not the expected ${other}`), drifted.err);
  assert.match(drifted.err, /changed since/);
  assert.match(drifted.err, /Nothing was written or opened/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(drifted.opened, []);
  assert.equal(drifted.out, "");

  const matched = await share([run, "--dry-run", "--expect", sha256.toUpperCase(), "--no-open"], { data: fake.data });
  assert.equal(matched.code, 0, matched.err);

  const malformed = await share([run, "--dry-run", "--expect", "abc"], { data: fake.data });
  assert.equal(malformed.code, 2, malformed.err);
  assert.match(malformed.err, /--expect takes a sha256/);
  assert.equal(fake.got.length, 2, "a malformed --expect sends nothing");
});

test("share refuses a bundle that does not hash to the sha256 it names: nothing written or opened", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic", { tamper: true });
  const fake = await fakeServer(t, run, sendBundle(body));
  const file = join(fresh(), "bundle.json");
  const result = await share([run, "--dry-run", "--out", file], { data: fake.data });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /does not hash to the sha256 it names/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(result.opened, []);
});

test("share without --dry-run publishes nothing: exit 2, the design's words, nothing asked of the server", async (t) => {
  const run = `run_share_${nonce()}`;
  const fake = await fakeServer(t, run, sendBundle(bundleOf(run, "synthetic").body));
  const result = await share([run], { data: fake.data });
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /^publishing comes with a share host; --dry-run shows the page/m);
  assert.deepEqual(result.opened, []);
  // Through the CLI's own table too: share is one of its commands.
  const { io, err } = ioOf();
  assert.equal(await main(["share", run, "--data", fake.data], { XDG_CONFIG_HOME: fresh() }, io), 2);
  assert.match(err.join(""), /publishing comes with a share host/);
  assert.equal(fake.got.length, 0);
});

test("share maps the server's 409, 403, 404 and 500 to plain messages and non-zero exits, writing and opening nothing", async (t) => {
  const run = `run_share_${nonce()}`;
  const answers = {
    409: sendError(409, "run_not_final", `The run ${run} has not ended: a run exports once it has.`),
    403: sendError(403, "forbidden", "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged), so nothing the run said is shown."),
    404: sendError(404, "not_found", `There is no run ${run}.`),
    500: (res) => res.writeHead(500, { "content-length": "0" }).end(),
  };
  let now;
  const fake = await fakeServer(t, run, (res) => answers[now](res));
  const cases = [
    [409, 2, /has not ended: a run exports once it has[\s\S]*Share it once it ends/],
    [403, 1, /withheld[\s\S]*can't read the run's browser sign-in/],
    [404, 2, /There is no run/],
    [500, 1, /failed closed[\s\S]*nothing of the run was shown/],
  ];
  for (const [status, exit, said] of cases) {
    now = status;
    const file = join(fresh(), "bundle.json");
    const result = await share([run, "--dry-run", "--out", file], { data: fake.data });
    assert.equal(result.code, exit, `${status}: ${result.err}`);
    assert.match(result.err, said, `${status}`);
    assert.match(result.err, /Nothing was written or opened/, `${status}`);
    assert.doesNotMatch(result.err, /"error"/, `${status}: the message, not the JSON`);
    assert.equal(existsSync(file), false, `${status}`);
    assert.deepEqual(result.opened, [], `${status}`);
    assert.equal(result.out, "", `${status}`);
    silent(result);
  }
  assert.equal(fake.got.length, cases.length);
});

test("share --help names its flags", async () => {
  const { io, out } = ioOf();
  assert.equal(await main(["share", "--help"], {}, io), 0);
  for (const flag of ["--dry-run", "--out FILE", "--restore IDS", "--expect SHA", "--no-open"]) assert.ok(out.join("").includes(flag), flag);
});
