// `agentrun share RUN --dry-run`: the run's share bundle (GET /v2/runs/RUN/export) from the server this CLI resolves,
// a summary of it printed (cuts by kind, how many may be restored, its sha256 and size, what it left out), and the
// preview page, <origin>/share/RUN, opened in the browser. `--out FILE` writes the bundle's bytes as served, `--restore`
// asks the server to keep restorable cuts, `--expect SHA` refuses a bundle whose sha256 is another. Without --dry-run (or
// --out) it publishes nothing and exits 2. A fake server on loopback answers the export; the opener is injected, so
// nothing opens. Synthetic data only.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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

/** An io for the CLI in this process: what it prints, kept; `input`, when given, its stdin (never a terminal). */
const ioOf = (input) => {
  const out = [];
  const err = [];
  const stdin = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(input)]), { isTTY: false });
  return { io: { stdin, stdout: { write: (text) => out.push(String(text)), on() {}, isTTY: false }, stderr: { write: (text) => err.push(String(text)) } }, out, err };
};

/** `agentrun share ...` as the CLI runs it (its flags, its target, its client), with the opener injected: `opened` is
 *  every [command, ...args] it was asked to launch. A display is set unless `env` says otherwise. */
async function share(argv, { data, env = { DISPLAY: ":0" }, platform = "linux" } = {}) {
  const opened = [];
  const launch = async (command, args) => (opened.push([command, ...args]), true);
  const { io, out, err } = ioOf();
  const code = await runLocal(shareOf({ launch, platform }), ["share", ...argv, "--data", data], { XDG_CONFIG_HOME: fresh(), ...env }, io);
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

test("share with none of --to, --dry-run or --out sends nothing: exit 2, words naming --to, nothing asked of the server", async (t) => {
  const run = `run_share_${nonce()}`;
  const fake = await fakeServer(t, run, sendBundle(bundleOf(run, "synthetic").body));
  const result = await share([run], { data: fake.data });
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /^agentrun share RUN takes --to URL \(publish it to a share host\), --dry-run \(preview its page\) or --out FILE \(write its bundle\)\. Nothing was sent\./m);
  assert.deepEqual(result.opened, []);
  // Through the CLI's own table too: share is one of its commands.
  const { io, err } = ioOf();
  assert.equal(await main(["share", run, "--data", fake.data], { XDG_CONFIG_HOME: fresh() }, io), 2);
  assert.match(err.join(""), /takes --to URL/);
  // --to publishes; --dry-run and --out show or write: one at a time.
  for (const other of [["--dry-run"], ["--out", join(fresh(), "bundle.json")]]) {
    const both = await share([run, "--to", "http://127.0.0.1:9", ...other], { data: fake.data });
    assert.equal(both.code, 2, both.err);
    assert.match(both.err, /--to publishes the bundle; --dry-run and --out show or write it: one at a time/);
  }
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
  for (const flag of ["--to URL", "--dry-run", "--out FILE", "--restore IDS", "--expect SHA", "--no-open"]) assert.ok(out.join("").includes(flag), flag);
  const deleting = ioOf();
  assert.equal(await main(["share", "delete", "--help"], {}, deleting.io), 0);
  assert.match(deleting.out.join(""), /Usage: agentrun share delete URL/);
});

// ---------- publishing: `agentrun login --share URL`, `agentrun share RUN --to URL`, `agentrun share delete URL`
//
// The share host's token is kept in a `share` entry of the same config file (0600), beside the server's base_url and
// api_key, which it never changes: every other command still goes where it went. A fake share host on loopback answers
// its own API under /r/v2 alone (anything else, a port probe among it, is a 404 it neither reads nor keeps).

/** A token of the test's own for the share host: made at random, never a real one. */
const shareToken = () => `share-host-test-${randomBytes(20).toString("hex")}`;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A share id as a share host makes them: 26 base32 letters. */
const shareId = () => Array.from(randomBytes(26), (byte) => BASE32[byte & 31]).join("");
const hostJson = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const hostError = (status, code, message, details) => (res) => hostJson(res, status, { error: { code, message, retryable: false, request_id: "req_test", ...(details ? { details } : {}) } });

/** A share host on loopback. Its own routes alone are kept, in `got` by method: GET /r/v2/shares (the login's check,
 *  answered for `token` alone), POST /r/v2/shares (answered by `post`, else 201 with a new id) and DELETE
 *  /r/v2/shares/<id> (answered by `del`, else 204). */
async function fakeHost(t, { token, post, del } = {}) {
  const got = { GET: [], POST: [], DELETE: [] };
  let base;
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://h");
    const own = (["GET", "POST"].includes(req.method) && pathname === "/r/v2/shares") || (req.method === "DELETE" && /^\/r\/v2\/shares\/[^/]+$/.test(pathname));
    if (!own) {
      req.resume();
      return void res.writeHead(404).end();
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const seen = { path: pathname, authorization: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) };
      got[req.method].push(seen);
      if (req.method === "GET") return req.headers.authorization === `Bearer ${token}` ? hostJson(res, 200, { shares: [], quota: { limit: 100, used: 0 } }) : hostError(401, "unauthenticated", "the share host's API takes one of its tokens as a Bearer header")(res);
      if (req.method === "POST") {
        if (post) return post(res, seen);
        const id = shareId();
        return hostJson(res, 201, { id, url: `${base}/r/${id}`, sha256: JSON.parse(seen.body.toString("utf8")).sha256 });
      }
      return del ? del(res, seen) : void res.writeHead(204).end();
    });
  });
  await new Promise((done) => server.listen(0, HOST, done));
  t.after(() => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))));
  const port = server.address().port;
  base = `http://${HOST}:${port}`;
  return { got, base, port };
}

/** A config folder whose config.json (0600, in a 0700 folder) holds `config`; the XDG_CONFIG_HOME that names it. */
function configHome(config) {
  const home = fresh();
  const dir = join(home, "agentrun");
  mkdirSync(dir, { mode: 0o700 });
  if (config !== undefined) writeFileSync(join(dir, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { home, file: join(dir, "config.json") };
}

/** `agentrun ARGV` in this process, with `env` and `input` on its stdin. */
async function agentrun(argv, env, input) {
  const { io, out, err } = ioOf(input);
  const code = await main(argv, env, io);
  return { code, out: out.join(""), err: err.join("") };
}

/** A fake AgentRun server's agents list on loopback, for a plain `agentrun login --base-url`: GET /v2/agents for `token`. */
async function fakeAgents(t, token) {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || new URL(req.url, "http://h").pathname !== "/v2/agents") return void (req.resume(), res.writeHead(404).end());
    return req.headers.authorization === `Bearer ${token}` ? hostJson(res, 200, { agents: [], next_cursor: null }) : hostError(401, "unauthenticated", "no")(res);
  });
  await new Promise((done) => server.listen(0, HOST, done));
  t.after(() => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))));
  return `http://${HOST}:${server.address().port}`;
}

test("login --share checks a token from stdin at the share host and keeps it in a share entry; the server's entry is untouched, and a later login keeps it", async (t) => {
  const token = shareToken();
  const host = await fakeHost(t, { token });
  assert.equal(await portProbe(host.port), 404, "a port probe is answered 404");
  const server = { base_url: "http://127.0.0.1:1/v2", api_key: CANARY };
  const { home, file } = configHome(server);
  const env = { XDG_CONFIG_HOME: home };

  const wrong = await agentrun(["login", "--share", host.base], env, "another-token\n");
  assert.equal(wrong.code, 4, wrong.err);
  assert.match(wrong.err, /refused the token; nothing was written/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), server, "a refused token changes nothing");

  // The share host's own address, or a link under its /r/: the entry keeps the address.
  const taken = await agentrun(["login", "--share", `${host.base}/r/`], env, `${token}\n`);
  assert.equal(taken.code, 0, taken.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...server, share: { base_url: host.base, api_key: token } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(taken.out), { share: { base_url: host.base }, config_file: file });
  assert.deepEqual(host.got.GET.map((seen) => [seen.path, seen.authorization]), [["/r/v2/shares", "Bearer another-token"], ["/r/v2/shares", `Bearer ${token}`]], "the check is the share host's own list, the probe not counted");
  for (const said of [wrong, taken]) assert.ok(![said.out, said.err].some((text) => text.includes(token) || text.includes(CANARY)), "no token printed");

  // --share names the share host; --to and --base-url name a server: one at a time.
  const both = await agentrun(["login", "--share", host.base, "--base-url", host.base], env, `${token}\n`);
  assert.equal(both.code, 2, both.err);

  // A server login afterwards keeps the share entry, as the share login kept the server's.
  const agentsToken = `agents-test-${randomBytes(12).toString("hex")}`;
  const agents = await fakeAgents(t, agentsToken);
  const server2 = await agentrun(["login", "--base-url", agents], env, `${agentsToken}\n`);
  assert.equal(server2.code, 0, server2.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { base_url: `${agents}/v2`, api_key: agentsToken, share: { base_url: host.base, api_key: token } });

  // logout --share drops the share entry alone; logout, the file.
  const out = await agentrun(["logout", "--share"], env);
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { base_url: `${agents}/v2`, api_key: agentsToken });
  assert.equal((await agentrun(["logout"], env)).code, 0);
  assert.equal(existsSync(file), false);
});

test("share --to needs the share host's login: refused before the export, with the command that signs in", async (t) => {
  const run = `run_share_${nonce()}`;
  const fake = await fakeServer(t, run, sendBundle(bundleOf(run, "synthetic").body));
  const host = await fakeHost(t, { token: shareToken() });
  const other = await fakeHost(t, { token: shareToken() });
  for (const config of [undefined, { base_url: "http://127.0.0.1:1/v2", api_key: CANARY }, { share: { base_url: other.base, api_key: shareToken() } }]) {
    const { home } = configHome(config);
    const result = await share([run, "--to", host.base], { data: fake.data, env: { XDG_CONFIG_HOME: home } });
    assert.equal(result.code, 4, result.err);
    assert.ok(result.err.includes(`agentrun login --share ${host.base} < TOKEN_FILE`), result.err);
    assert.match(result.err, /Nothing was sent/);
    assert.equal(result.out, "");
  }
  // A --to that is no http(s) address, or carries a user, query or fragment: bad usage, nothing asked.
  // The address with a user and password is built here: no file of the repository holds one.
  for (const bad of ["ftp://127.0.0.1/", ["http://user", "pw@127.0.0.1/"].join(":"), "http://127.0.0.1/?q=1", "not a url"]) {
    const result = await share([run, "--to", bad], { data: fake.data });
    assert.equal(result.code, 2, `${bad}: ${result.err}`);
    assert.ok(!result.err.includes("pw@"), "never echoed");
  }
  assert.equal(fake.got.length, 0, "no export");
  assert.equal(host.got.POST.length + other.got.POST.length, 0, "no upload");
});

test("share --to exports again with the restores, posts the bundle's bytes with the share token alone, and prints the share's URL", async (t) => {
  const run = `run_share_${nonce()}`;
  const planted = `planted-share-value-${nonce()}`;
  const restored = [{ id: cutId(1), at: "/rows/0/text", start: 4, end: 7, rule: "pg-password", kind: "label" }];
  const { body, sha256 } = bundleOf(run, planted, { restored });
  const fake = await fakeServer(t, run, sendBundle(body));
  const token = shareToken();
  const host = await fakeHost(t, { token });
  assert.equal(await portProbe(host.port), 404);
  const { home } = configHome({ share: { base_url: host.base, api_key: token } });

  const result = await share([run, "--to", host.base, "--restore", cutId(1), "--expect", sha256], { data: fake.data, env: { XDG_CONFIG_HOME: home } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(fake.got, [{ query: `?restore=${cutId(1)}`, authorization: `Bearer ${CANARY}` }], "one export with the restores, the local token to the local server alone");
  assert.equal(host.got.POST.length, 1);
  const [posted] = host.got.POST;
  assert.ok(posted.body.equals(Buffer.from(body)), "the bundle's bytes as the server sent them");
  assert.equal(posted.authorization, `Bearer ${token}`, "the share entry's token to the share host alone");
  assert.match(posted.type, /^application\/json/);
  const printed = JSON.parse(result.out);
  assert.match(printed.id, /^[a-z2-7]{26}$/);
  assert.equal(printed.url, `${host.base}/r/${printed.id}`);
  assert.equal(printed.sha256, sha256);
  assert.equal(printed.restored, 1);
  assert.ok(result.err.includes(`Shared: ${printed.url}`), result.err);
  assert.ok(result.err.includes(`agentrun share delete ${printed.url}`), "says how to take it down");
  silent(result, planted, token);
});

test("share --to on a host whose public address is another: the link is the public one, the delete command the address that took the upload", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body, sha256 } = bundleOf(run, `planted-share-value-${nonce()}`);
  const fake = await fakeServer(t, run, sendBundle(body));
  const token = shareToken();
  const PUBLIC = "https://shares.example.test";
  const host = await fakeHost(t, { token, post: (res, seen) => {
    const id = shareId();
    hostJson(res, 201, { id, url: `${PUBLIC}/r/${id}`, sha256: JSON.parse(seen.body.toString("utf8")).sha256 });
  } });
  const { home } = configHome({ share: { base_url: host.base, api_key: token } });
  const env = { XDG_CONFIG_HOME: home };

  const result = await share([run, "--to", host.base, "--expect", sha256], { data: fake.data, env });
  assert.equal(result.code, 0, result.err);
  const { id, url } = JSON.parse(result.out);
  assert.equal(url, `${PUBLIC}/r/${id}`, "readers get the host's public link");
  assert.ok(result.err.includes(`Shared: ${url}`), result.err);
  const command = `agentrun share delete ${host.base}/r/${id}`;
  assert.ok(result.err.includes(command), `the delete command names the address the login is for: ${result.err}`);
  // And it works as printed, with the login that published.
  const deleted = await agentrun(command.split(" ").slice(1), env);
  assert.equal(deleted.code, 0, deleted.err);
  assert.deepEqual(host.got.DELETE.map((seen) => seen.path), [`/r/v2/shares/${id}`]);
});

test("logout --share refuses a config file it cannot read as one, and leaves it as it was", async () => {
  for (const [name, text, mode, exit] of [["unsafe", `${JSON.stringify({ share: { base_url: "http://127.0.0.1:1", api_key: shareToken() } })}\n`, 0o644, 4], ["malformed", "{not json", 0o600, 4], ["not an object", "[]\n", 0o600, 4]]) {
    const { home, file } = configHome();
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
    const out = await agentrun(["logout", "--share"], { XDG_CONFIG_HOME: home });
    assert.equal(out.code, exit, `${name}: ${out.err}`);
    assert.equal(out.out, "", `${name}: no "removed: false"`);
    assert.equal(readFileSync(file, "utf8"), text, `${name}: the file is untouched`);
  }
});

test("share --to --expect refuses a bundle whose sha256 changed since the page showed it, before any POST", async (t) => {
  const run = `run_share_${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const token = shareToken();
  const host = await fakeHost(t, { token });
  const { home } = configHome({ share: { base_url: host.base, api_key: token } });
  const result = await share([run, "--to", host.base, "--expect", sha256Of("the page's bundle")], { data: fake.data, env: { XDG_CONFIG_HOME: home } });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /changed since the page showed it/);
  assert.ok(result.err.includes(`agentrun share ${run} --dry-run`), "says to open the page again");
  assert.match(result.err, /Nothing was sent/);
  assert.equal(result.out, "");
  assert.equal(fake.got.length, 1);
  assert.equal(host.got.POST.length, 0, "refused before any POST");
  silent(result, token);
});

test("a share host's refusal prints counts by rule and never a value: 422, 400 and 413; 401 and a full quota say what to do", async (t) => {
  const run = `run_share_${nonce()}`;
  const planted = `planted-host-value-${nonce()}`;
  const { body } = bundleOf(run, "synthetic");
  const fake = await fakeServer(t, run, sendBundle(body));
  const token = shareToken();
  let now;
  // Each refusal quotes the planted value where a careless client would print it: its message, a rule's name, a detail.
  const answers = {
    422: hostError(422, "input_invalid", `The share host's scrub found ${planted}.`, { reason: "scrub_found", counts: { "pg-password": 2, "home-path": 1, [planted]: 1 }, unmatched: { "pg-password": 1 } }),
    400: hostError(400, "bad_request", `This is not a share bundle the host takes: run has a field "${planted}" the format does not name.`),
    413: hostError(413, "payload_too_large", `Too many strings: ${planted}`, { reason: "share_strings", limit: 50000, strings: 60001, note: planted }),
    401: hostError(401, "unauthenticated", planted),
    403: hostError(403, "forbidden", planted, { reason: "share_quota", limit: 100, used: 100 }),
    500: hostError(500, "internal", planted),
  };
  const host = await fakeHost(t, { token, post: (res) => answers[now](res) });
  const { home } = configHome({ share: { base_url: host.base, api_key: token } });
  const cases = [
    [422, 1, [/refused the bundle \(422 scrub_found\)/, /by rule: pg-password 2, home-path 1, unknown 1/, /no restore declares/, /restored records it could not match, by rule: pg-password 1/]],
    [400, 1, [/refused the bundle \(400\)/, /does not take/]],
    [413, 1, [/60001 distinct strings, over the 50000/]],
    [401, 4, [/refused the token \(401\)/, new RegExp(`agentrun login --share ${host.base.replace(/[.]/g, "\\.")} < TOKEN_FILE`)]],
    [403, 1, [/keeps 100 shares, its most \(100\)/, /agentrun share delete/]],
    [500, 1, [/refused it: 500 internal/]],
  ];
  for (const [status, exit, said] of cases) {
    now = status;
    const result = await share([run, "--to", host.base], { data: fake.data, env: { XDG_CONFIG_HOME: home } });
    assert.equal(result.code, exit, `${status}: ${result.err}`);
    for (const line of said) assert.match(result.err, line, `${status}`);
    assert.match(result.err, /Nothing was stored/, `${status}`);
    assert.equal(result.out, "", `${status}`);
    assert.doesNotMatch(result.err, /"error"/, `${status}: never the host's JSON`);
    silent(result, planted, token);
  }
  assert.equal(host.got.POST.length, cases.length);
});

test("share delete URL deletes the share with the share token: 204 says so; 404, 403 and 410 in plain words; no login refuses", async (t) => {
  const token = shareToken();
  const answers = new Map();
  const host = await fakeHost(t, { token, del: (res, seen) => (answers.get(seen.path.split("/").pop()) ?? ((r) => void r.writeHead(204).end()))(res) });
  assert.equal(await portProbe(host.port), 404);
  const { home } = configHome({ base_url: "http://127.0.0.1:1/v2", api_key: CANARY, share: { base_url: host.base, api_key: token } });
  const env = { XDG_CONFIG_HOME: home };

  const live = shareId();
  const deleted = await agentrun(["share", "delete", `${host.base}/r/${live}`], env);
  assert.equal(deleted.code, 0, deleted.err);
  assert.deepEqual(JSON.parse(deleted.out), { url: `${host.base}/r/${live}`, id: live, deleted: true });
  assert.match(deleted.err, /Deleted .*: its page now answers 410 Gone/);
  assert.deepEqual(host.got.DELETE.map((seen) => [seen.path, seen.authorization]), [[`/r/v2/shares/${live}`, `Bearer ${token}`]]);

  const missing = shareId();
  answers.set(missing, hostError(404, "not_found", `There is no share ${missing} on this host.`));
  const theirs = shareId();
  answers.set(theirs, hostError(403, "forbidden", "made with another token"));
  const gone = shareId();
  answers.set(gone, hostError(410, "purged", "deleted"));
  for (const [id, exit, said] of [[missing, 1, /has no share/], [theirs, 4, /made with another token; only that token deletes it/], [gone, 0, /already deleted/]]) {
    const result = await agentrun(["share", "delete", `${host.base}/r/${id}`], env);
    assert.equal(result.code, exit, `${id}: ${result.err}`);
    assert.match(result.err, said);
    silent(result, token);
  }

  // No share login for that host: refused, nothing sent. A URL that is no share's: bad usage.
  const before = host.got.DELETE.length;
  const none = await agentrun(["share", "delete", `${host.base}/r/${shareId()}`], { XDG_CONFIG_HOME: configHome().home });
  assert.equal(none.code, 4, none.err);
  assert.ok(none.err.includes(`agentrun login --share ${host.base} < TOKEN_FILE`), none.err);
  for (const bad of [`${host.base}/share/run_1`, `${host.base}/r/NOT-AN-ID`, "nonsense"]) {
    const result = await agentrun(["share", "delete", bad], env);
    assert.equal(result.code, 2, `${bad}: ${result.err}`);
    assert.match(result.err, /a share's URL/);
  }
  assert.equal(host.got.DELETE.length, before, "nothing sent");
});

test("share --to and share delete against a real share host: 201, the stored bytes are the export's, then 410 once deleted", { timeout: 120_000 }, async (t) => {
  const { startServe } = await import("../../serve/dist/index.js");
  const { exportBundle } = await import("../../serve/dist/run-export.js");
  const run = `run_share_${nonce()}`;
  const content = "# Report\n\nSix times seven is 42.\n";
  const { body } = await exportBundle({
    runId: run,
    agent: { name: "share-e2e-agent" },
    view: { kind: "agentic", status: "succeeded", state: "succeeded", title: `Multiply two numbers ${nonce()}`, created_at: "2026-11-23T00:00:00.000Z", ended_at: "2026-11-23T00:01:00.000Z", result: { final_answer: "The answer is 42.", output: null, output_error: null } },
    rows: [{ type: "message", role: "user", text: "What is six times seven?" }, { type: "message", role: "assistant", text: "The answer is 42." }],
    graph: null,
    files: [{ path: "out/report.md", size: Buffer.byteLength(content), read: async () => Buffer.from(content) }],
    filesTruncated: false,
    held: [],
    restore: [],
    version: "0.0.0-share-e2e",
  });
  const fake = await fakeServer(t, run, sendBundle(body));
  const token = shareToken();
  const data = fresh();
  const hostServer = await startServe({ data, port: 0, shareHost: true, tokens: [{ id: "publisher", token }], drainTimeout: "5s" });
  t.after(() => hostServer.close());
  const host = new URL(hostServer.baseUrl).origin;
  const { home } = configHome();
  const env = { XDG_CONFIG_HOME: home };

  const login = await agentrun(["login", "--share", host], env, `${token}\n`);
  assert.equal(login.code, 0, login.err);
  const shared = await share([run, "--to", host, "--expect", JSON.parse(body).sha256], { data: fake.data, env });
  assert.equal(shared.code, 0, shared.err);
  const { url, id } = JSON.parse(shared.out);
  assert.equal(url, `${host}/r/${id}`);
  const stored = await fetch(`${url}/bundle.json`);
  assert.equal(stored.status, 200);
  assert.ok(Buffer.from(await stored.arrayBuffer()).equals(Buffer.from(body)), "the host serves the export's bytes");

  const deleted = await agentrun(["share", "delete", url], env);
  assert.equal(deleted.code, 0, deleted.err);
  for (const at of [url, `${url}/bundle.json`]) {
    const after = await fetch(at);
    await after.arrayBuffer();
    assert.equal(after.status, 410, at);
  }
  silent(shared, token);
  silent(deleted, token);
});
