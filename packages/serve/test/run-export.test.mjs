// The share bundle's pure builder (run-export.ts exportBundle): a run's served view, rows, graph and files in, one
// `agentrun.share/1` document out, every string in it cut by the scrubber with the run's held values. Every value here is
// synthetic: the planted secrets are derived from fixed seeds at test time (none is a literal in this file), so the golden
// document is the same on every run and no real-looking key sits in the repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXPORT_CAPS, ExportFailed, exportBundle, restoreIdsOf, runExport, SHARE_FORMAT, SHARE_RUN_FIELDS } from "../dist/run-export.js";
import { ApiError } from "../dist/errors.js";
import { SCRUB_RULES, scrub } from "../dist/secret-cut.js";
import { stable } from "../dist/validate.js";
import { unixHome } from "./scrub-positives.mjs";

const GOLDEN = fileURLToPath(new URL("./fixtures/run-export/golden.json", import.meta.url));
const hex = (seed, n) => createHash("sha256").update(`run-export test ${seed}`).digest("hex").repeat(4).slice(0, n);

/** One synthetic value of each kind the scrubber cuts, from fixed seeds (`salt`: another set of the same lengths). */
const planted = (salt = "") => ({
  sk: `sk-proj-${hex(`sk${salt}`, 48)}`, // format
  ghp: `ghp_${hex(`ghp${salt}`, 36)}`, // format
  aws: `AKIA${hex(`aws${salt}`, 16).toUpperCase()}`, // format
  held: `heldvalue${hex(`held${salt}`, 24)}`, // held (the run's cut set)
  pg: `Pw${hex(`pg${salt}`, 18)}`, // label (PGPASSWORD=)
  user: `qa${hex(`user${salt}`, 6)}`, // personal (a home path's user)
  email: `qa.${hex(`email${salt}`, 8)}@mailbox-synthetic.zz`, // personal
  ip: salt ? "10.20.30.42" : "10.20.30.41", // key-gate: denylist a private literal the scrubber cuts (personal)
  envValue: `envdump${hex(`env${salt}`, 12)}`, // in a dump
});
const PLANTED = planted();

/** A served view of an ended agentic run, with every field the allowlist drops present. */
function viewOf(p = PLANTED) {
  return {
    run_id: "run_golden", agent_id: "agent_golden", agent_version: 3, console_url: "http://127.0.0.1:7777/runs/run_golden",
    revision: "rev_golden", kind: "agentic", sha: null, status: "completed", state: "completed",
    title: `Connect with PGPASSWORD=${p.pg} psql -h db`, input: { content: "the first message" }, file_ids: ["file_1"],
    place: { mode: "runner" }, claim: null, effort: "medium", created_at: "2026-11-23T10:00:00.000Z", updated_at: "2026-11-23T10:05:00.000Z",
    ended_at: "2026-11-23T10:05:00.000Z",
    result: { output: null, final_answer: `Done. Mail ${p.email} about ${unixHome(p.user)}/work; key ${p.sk}.` },
    error: null, review: null, pending: null, cost: { usd: 0.0123, basis: "booked" }, stopped_for: null, budget_refused_calls: 0,
    audit_of: null, approvals: "ask", archived_at: null, imported_from: { source: "claude-code", session: "session-golden" },
    trigger: { id: "trg_1", firing_key: "firing-golden" }, labels: { team: "golden" }, learning: null, recordings: [],
    cli_learning: { root: "/x" }, sdk: { app: "x" }, native: { project: "/x" }, poll_after_ms: 0, last_progress_at: "2026-11-23T10:05:00.000Z",
  };
}

/** Served Timeline rows holding every planted value once at least. */
function rowsOf(p = PLANTED) {
  const row = (n, kind, text) => ({ id: `row_${n}`, timestamp: "2026-11-23T10:00:0" + n + ".000Z", created_at: "2026-11-23T10:00:0" + n + ".000Z", kind, summary: text, text });
  return [
    row(1, "message", `Connect with PGPASSWORD=${p.pg} psql -h db, then mail ${p.email}`),
    row(2, "text_block", `Set OPENAI_API_KEY=${p.sk} and GITHUB_TOKEN=${p.ghp}; the AWS id ${p.aws}.`),
    row(3, "tool_result", ["$ env", `HOME=${unixHome(p.user)}`, "PATH=/usr/bin", `SECRET_THING=${p.envValue}`, "SHELL=/bin/sh", "$ echo done"].join("\n")),
    row(4, "text_block", `The host ${p.ip} answered from ${unixHome(p.user)}/work.`),
    row(5, "final_answer", `Done. Mail ${p.email} about ${unixHome(p.user)}/work; key ${p.sk}.`),
  ];
}

const textFile = (path, text) => ({ path, size: Buffer.byteLength(text), read: async (limit) => Buffer.from(text).subarray(0, limit) });
const byteFile = (path, bytes) => ({ path, size: bytes.length, read: async (limit) => bytes.subarray(0, limit) });

function inputOf(extra = {}, p = PLANTED) {
  return {
    runId: "run_golden",
    agent: { name: "Golden agent" },
    view: viewOf(p),
    rows: rowsOf(p),
    graph: null,
    files: [
      textFile("out/report.md", `# Report\nThe token ${p.held} opened it, as ${p.email} asked.\n`),
      byteFile("out/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])),
      textFile("out/notes.txt", `held again: ${p.held}\n`),
    ],
    filesTruncated: false,
    held: [p.held],
    restore: [],
    version: "0.0.0-golden",
    ...extra,
  };
}

const build = async (extra = {}, p = PLANTED) => {
  const { body, sha256 } = await exportBundle(inputOf(extra, p));
  return { body, sha256, doc: JSON.parse(body) };
};

/** Every form a planted value could take in a JSON document: as it is, JSON-escaped, URL-encoded and base64. */
const formsOf = (value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")];

/** No form of any value of `planted` (but those in `except`), and no 8-character piece of one, in `body`. */
function assertNoPlanted(body, planted = PLANTED, except = []) {
  for (const [name, value] of Object.entries(planted)) {
    if (except.includes(name)) continue;
    for (const form of formsOf(value)) assert.ok(!body.includes(form), `the ${name} value, as ${form.slice(0, 6)}…, is in the bundle`);
    // A shape names a known format's public prefix (sk-proj-, ghp_, AKIA): a piece wholly inside it is no piece of the value.
    const prefix = /^(?:sk-proj-|ghp_|AKIA)/.exec(value)?.[0].length ?? 0;
    for (let i = 0; i + 8 <= value.length; i++) if (i + 8 > prefix) assert.ok(!body.includes(value.slice(i, i + 8)), `a piece of the ${name} value (at ${i}) is in the bundle`);
  }
}

const valueAt = (doc, pointer) => pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((at, key) => at[key], doc);

test("golden: the bundle of a synthetic run with a planted secret of every kind is the document on file", async () => {
  const { body } = await build();
  // On file with the home root folded to `{home}/`: no file of the repository holds a home folder's path, a cut one's too.
  const actual = `${JSON.stringify(JSON.parse(body), null, 2)}\n`.replaceAll(unixHome(""), "{home}/");
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, actual);
  assert.equal(actual, readFileSync(GOLDEN, "utf8"));
});

test("the bundle is agentrun.share/1: the allowlisted run fields, the agent's name and kind, rows, graph, files, omitted, cuts, restored and its sha256", async () => {
  const { doc } = await build();
  assert.equal(doc.format, SHARE_FORMAT);
  assert.deepEqual(Object.keys(doc).sort(), ["agent", "cuts", "files", "format", "graph", "omitted", "restored", "rows", "run", "sha256", "source"]);
  assert.deepEqual(doc.agent, { name: "Golden agent", kind: "agentic" });
  assert.equal(doc.source.agentrun, "0.0.0-golden");
  assert.equal(doc.source.scrubber.version, 1);
  assert.match(doc.source.scrubber.rules, /^[0-9a-f]{64}$/);
  // The run: the allowlist and nothing else; imported_from carries its source alone.
  assert.deepEqual(Object.keys(doc.run).sort(), [...SHARE_RUN_FIELDS, "imported_from"].sort());
  for (const dropped of ["run_id", "agent_id", "agent_version", "revision", "console_url", "claim", "place", "file_ids", "input", "trigger", "labels", "cli_learning", "sdk", "native", "learning", "recordings", "pending", "poll_after_ms", "updated_at", "last_progress_at", "archived_at", "audit_of", "sha"]) {
    assert.ok(!(dropped in doc.run), `${dropped} is dropped`);
  }
  assert.deepEqual(doc.run.imported_from, { source: "claude-code" });
  for (const local of ["127.0.0.1:7777", "session-golden", "firing-golden", "agent_golden", "rev_golden", "run_golden"]) assert.ok(!JSON.stringify(doc).includes(local), `${local} is not in the bundle`);
  assert.equal(doc.graph, null, "an agentic run has no graph");
  assert.deepEqual(doc.rows.map((row) => row.id), rowsOf().map((row) => row.id), "every served row, in order");
  assert.deepEqual(doc.restored, []);
  // The document's digest: canonical JSON of the document without its sha256.
  const { sha256, ...rest } = doc;
  assert.equal(sha256, createHash("sha256").update(stable(rest)).digest("hex"));
});

test("every planted kind is cut with the right kind and restorability, and each cut record carries a stable id, its pointer, its span in the cut text and a shape", async () => {
  const { doc } = await build();
  const kinds = new Set(doc.cuts.map((cut) => cut.kind));
  for (const kind of ["format", "held", "dump", "label", "personal"]) assert.ok(kinds.has(kind), `a ${kind} cut: ${JSON.stringify([...kinds])}`);
  for (const cut of doc.cuts) {
    assert.deepEqual(Object.keys(cut).sort(), ["at", "end", "id", "kind", "restorable", "rule", "shape", "start"]);
    assert.match(cut.id, /^c_[0-9a-f]{16}$/);
    assert.equal(cut.restorable, ["label", "personal", "jev"].includes(cut.kind), `${cut.rule}'s restorability is its kind's`);
    const text = valueAt(doc, cut.at);
    assert.equal(typeof text, "string", `${cut.at} points at a string`);
    // The span holds what the cut wrote: its rule's replacement when the rule has one (a home's user: `<user>`), else
    // the `[redacted:<rule>]` marker.
    const replacement = SCRUB_RULES.find((rule) => rule.id === cut.rule)?.replacement;
    if (replacement !== undefined) assert.equal(text.slice(cut.start, cut.end), replacement, `${cut.at} ${cut.start}-${cut.end} spans ${cut.rule}'s replacement`);
    else assert.match(text.slice(cut.start, cut.end), /^\[redacted:[a-z0-9-]+( \d+ lines)?\]$/, `${cut.at} ${cut.start}-${cut.end} spans the cut's marker`);
  }
  assert.equal(new Set(doc.cuts.map((cut) => cut.id)).size, doc.cuts.length, "ids are unique");
  // The id is derived from where the cut is, never from its value: two runs that differ only in their secrets' values
  // cut the same places under the same ids.
  const other = planted("other");
  const { doc: again } = await build({ held: [other.held] }, other);
  assert.deepEqual(again.cuts.map((cut) => [cut.id, cut.at, cut.rule]), doc.cuts.map((cut) => [cut.id, cut.at, cut.rule]));
});

test("no planted value is anywhere in the bundle: raw, JSON-escaped, URL-encoded, base64, or any 8-character piece", async () => {
  const { body } = await build();
  assertNoPlanted(body);
});

test("two exports of the same run are byte-identical, with the same sha256", async () => {
  const one = await build();
  const two = await build();
  assert.equal(one.body, two.body);
  assert.equal(one.sha256, two.sha256);
  assert.equal(one.doc.sha256, one.sha256);
});

test("files: UTF-8 text within the caps is carried with its bytes and sha256 as carried; binary, oversize, over the total or the count, and a truncated list land in omitted", async () => {
  const { doc } = await build();
  assert.deepEqual(doc.files.map((file) => file.path), ["out/notes.txt", "out/report.md"]);
  for (const file of doc.files) {
    assert.equal(file.encoding, "utf8");
    assert.equal(file.bytes, Buffer.byteLength(file.content));
    const digest = createHash("sha256").update(file.path).update(Buffer.from([0])).update(file.content).update(Buffer.from([0])).digest("hex");
    assert.equal(file.sha256, digest, "packageSha256 of the file as carried");
  }
  assert.match(doc.files[0].content, /held again: \[redacted:held-value\]/);
  assert.deepEqual(doc.omitted, [{ what: "file", path: "out/shot.png", why: "binary" }, { what: "recordings", why: "never" }]);

  const caps = { fileBytes: 64, filesBytes: 100, files: 3 };
  const files = [textFile("a.txt", "a".repeat(60)), textFile("b.txt", "b".repeat(65)), textFile("c.txt", "c".repeat(50)), byteFile("d.bin", Buffer.from([0xff, 0xfe, 0x41])), textFile("e.txt", "e".repeat(10)), textFile("f.txt", "f"), textFile("g.txt", "g")];
  const { doc: capped } = await build({ caps, files, filesTruncated: true });
  assert.deepEqual(capped.files.map((file) => file.path), ["a.txt", "e.txt", "f.txt"]);
  assert.deepEqual(capped.omitted, [
    { what: "file", path: "b.txt", why: "too_large" },
    { what: "file", path: "c.txt", why: "over_total" },
    { what: "file", path: "d.bin", why: "binary" },
    { what: "file", path: "g.txt", why: "over_count" },
    { what: "files", why: "list_truncated" },
    { what: "recordings", why: "never" },
  ]);
  // A file is read no further than its cap allows: an over-cap file is never read at all.
  let read = 0;
  await build({ caps, files: [{ path: "big.txt", size: 1_000_000, read: async () => ((read += 1), Buffer.alloc(0)) }] });
  assert.equal(read, 0);
});

test("files: a held value wrapped over line breaks in a run's file is not carried in part: a file is cut as the served cut read cuts it before the scrubber reads it", async () => {
  // Wrapped over two line breaks, as a terminal or a PEM-style writer wraps it: the scrubber's held rule finds a form
  // split by one run of blanks, and its final check reads only its own cut text; the served read withholds the text.
  const held = `Wq${hex("wrapped-held", 34)}`;
  const pieces = [held.slice(0, 12), held.slice(12, 24), held.slice(24)];
  for (const content of [`deploy key: ${pieces.join("\n")}\n`, `token=${pieces[0]}\n${pieces[1]}\n\n${pieces[2]}\n`, `${pieces.join("\r\n")}`]) {
    const { body, doc } = await build({ held: [held], files: [textFile("out/wrapped.txt", content)] });
    for (const piece of pieces) assert.ok(!body.includes(piece), `${JSON.stringify(content.slice(0, 20))}: a piece of the held value is carried`);
    assert.deepEqual(doc.files.map((file) => file.path), ["out/wrapped.txt"], "the file is still carried, cut");
  }
});

test("files: a census-cut run (its end erased a value it was handed, so the cut set no longer holds it) carries no file through runExport, whatever a file holds", async () => {
  const erased = `Er${hex("erased-handed", 30)}`;
  const reads = { ...readsOf({ rows: [] }), files: async () => ({ files: [textFile("out/key.txt", `the key: ${erased}\n`)], truncated: false }), cut: async () => ({ values: [], censusDigest: "d".repeat(64) }) };
  const { body, doc } = await exported(reads);
  assert.deepEqual(doc.files, []);
  assert.deepEqual(doc.omitted, [{ what: "files", why: "uncounted" }, { what: "recordings", why: "never" }]);
  assert.ok(!body.includes(erased) && !body.includes("out/key.txt"), "no file's content or name");
});

test("files: a run whose cut is its census's carries no file and names none, reading none; a file whose read fails is left out as unreadable", async () => {
  let reads = 0;
  const counted = (file) => ({ ...file, read: async (limit) => ((reads += 1), file.read(limit)) });
  const { doc } = await build({ filesUncounted: true, files: inputOf().files.map(counted) });
  assert.deepEqual(doc.files, []);
  assert.deepEqual(doc.omitted, [{ what: "files", why: "uncounted" }, { what: "recordings", why: "never" }]);
  assert.equal(reads, 0, "no file read");
  const gone = { path: "out/gone.txt", size: 4, read: async () => { throw Object.assign(new Error("refused"), { code: "REFUSED" }); } };
  const { doc: left } = await build({ files: [gone, textFile("out/kept.txt", "kept\n")] });
  assert.deepEqual(left.files.map((file) => file.path), ["out/kept.txt"]);
  assert.deepEqual(left.omitted.filter((one) => one.what === "file"), [{ what: "file", path: "out/gone.txt", why: "unreadable" }]);
});

test("files: the caps hold for the bytes carried, a file's cut text, which a cut can make longer than the file was", async () => {
  // Short values whose markers are longer: the cut text outgrows the file.
  const ips = "at 10.1.2.3\n".repeat(5); // key-gate: denylist a synthetic private address the export cuts as personal
  const plain = "x".repeat(40);
  const files = () => [textFile("a/ips.txt", ips), textFile("b/plain.txt", plain)];
  const { doc: open } = await build({ files: files() });
  const cutIps = open.files.find((file) => file.path === "a/ips.txt");
  assert.ok(Buffer.byteLength(ips) <= 64 && cutIps.bytes > 64, `the cut text outgrows the file: ${Buffer.byteLength(ips)} -> ${cutIps.bytes}`);
  // Under a 64-byte file cap the file fits as read, but not as carried: it is left out as too large.
  const { doc } = await build({ caps: { fileBytes: 64 }, files: files() });
  assert.deepEqual(doc.files.map((file) => file.path), ["b/plain.txt"]);
  assert.deepEqual(doc.omitted.filter((one) => one.what === "file"), [{ what: "file", path: "a/ips.txt", why: "too_large" }]);
  for (const file of doc.files) assert.ok(file.bytes <= 64);
  // And the total: the files fit as read, but the cut ones do not, so the later one is left out.
  const { doc: total } = await build({ caps: { filesBytes: cutIps.bytes + 10 }, files: files() });
  assert.deepEqual(total.files.map((file) => file.path), ["a/ips.txt"]);
  assert.deepEqual(total.omitted.filter((one) => one.what === "file"), [{ what: "file", path: "b/plain.txt", why: "over_total" }]);
});

test("files: which files are carried, and at which index, is decided with no restore, so a cut id names the same file whatever is restored", async () => {
  // a/ips.txt fits as read, not as cut, and would fit again with one address restored; b/one.txt's address is the one
  // the owner picks, at /files/0 in the bundle they saw.
  const ips = "a 10.1.2.3 b 10.1.2.4\n"; // key-gate: denylist synthetic private addresses the export cuts as personal
  const one = "host 10.9.8.7\n"; // key-gate: denylist a synthetic private address the export cuts as personal
  const files = () => [textFile("a/ips.txt", ips), textFile("b/one.txt", one)];
  const caps = { fileBytes: 40 };
  const { doc: seen } = await build({ caps, files: files() });
  assert.deepEqual(seen.files.map((file) => file.path), ["b/one.txt"]);
  const pick = cutsAt(seen, "/files/0/content").find((cut) => cut.rule === "private-ip");
  assert.ok(pick, JSON.stringify(seen.cuts));
  const { doc, body } = await build({ caps, files: files(), restore: [pick.id] });
  assert.deepEqual(doc.files.map((file) => file.path), ["b/one.txt"], "the restore moves no file in");
  assert.equal(doc.files[0].content, one, "the address restored is the one picked");
  assert.deepEqual(doc.omitted.filter((x) => x.what === "file"), [{ what: "file", path: "a/ips.txt", why: "too_large" }]);
  const hidden = ips.split(" ")[1];
  assert.ok(!body.includes(hidden), "the omitted file's address is nowhere");
});

test("files: a restore that puts a carried file over a cap is refused 400, never a file moved in or out", async () => {
  // A long address (its marker shorter) and a private one (its marker longer): cut, the file is no longer than it was read;
  // with the address restored, the private one's marker makes it longer.
  const inner = "10.4.5.6"; // key-gate: denylist a synthetic private address the export cuts as personal
  const mail = `reach someone.with.a.rather.long.name.${hex("mail", 8)}@sample-mail.zz at ${inner}\n`;
  const files = () => [textFile("c/mail.txt", mail)];
  const caps = { fileBytes: Buffer.byteLength(mail) };
  const { doc: seen } = await build({ caps, files: files() });
  assert.deepEqual(seen.files.map((file) => file.path), ["c/mail.txt"], "it fits, cut");
  const pick = cutsAt(seen, "/files/0/content").find((c) => c.rule === "email");
  assert.ok(pick, JSON.stringify(seen.cuts));
  await assert.rejects(build({ caps, files: files(), restore: [pick.id] }), (error) => error instanceof ApiError && error.status === 400 && /over the share caps/.test(error.message) && !error.message.includes("c/mail.txt"));
  // Under the default caps the same restore is taken.
  const { doc } = await build({ files: files(), restore: [pick.id] });
  assert.ok(doc.files[0].content.includes("@sample-mail.zz"));
});

test("a document over its cap is refused 413 export_too_large, never truncated", async () => {
  await assert.rejects(build({ caps: { documentBytes: 2048 } }), (error) => error instanceof ApiError && error.status === 413 && error.code === "export_too_large");
  assert.ok(EXPORT_CAPS.documentBytes === 8 * 1024 * 1024 && EXPORT_CAPS.fileBytes === 256 * 1024 && EXPORT_CAPS.filesBytes === 4 * 1024 * 1024 && EXPORT_CAPS.files === 200);
});

test("restore: a label cut's id puts its value back and moves its record to restored; every other value stays cut", async () => {
  const { doc } = await build();
  const label = doc.cuts.find((cut) => cut.kind === "label" && cut.at === "/run/title");
  assert.ok(label, JSON.stringify(doc.cuts));
  const { doc: restored, body } = await build({ restore: [label.id] });
  assert.equal(restored.run.title, `Connect with PGPASSWORD=${PLANTED.pg} psql -h db`);
  assert.ok(!restored.cuts.some((cut) => cut.id === label.id));
  assert.deepEqual(restored.restored, [{ id: label.id, at: "/run/title", start: 24, end: 24 + PLANTED.pg.length, rule: label.rule, kind: "label" }]);
  assert.equal(restored.cuts.length, doc.cuts.length - 1);
  assert.notEqual(restored.sha256, doc.sha256);
  // Only that one place: the same value elsewhere (the first row) is still cut, and nothing else is back.
  assert.ok(restored.rows[0].text.includes("[redacted:"), restored.rows[0].text);
  assertNoPlanted(body.replace(`PGPASSWORD=${PLANTED.pg} psql`, ""), PLANTED);
});

test("restore reads back only what it named: a value the cut pass never cuts (an object key) fails the export closed, a restore of another cut or not", async () => {
  const { doc } = await build();
  const label = doc.cuts.find((cut) => cut.kind === "label" && cut.at === "/run/title");
  // A workflow output keyed by a person's email: keys are carried as they are, so the read-back is what refuses it.
  const keyed = [...rowsOf(PLANTED), { seq: 9, kind: "text_block", text: "Sent.", by: { [PLANTED.email]: "sent" } }];
  await assert.rejects(build({ rows: keyed }), ExportFailed, "no restore");
  await assert.rejects(build({ rows: keyed, restore: [label.id] }), ExportFailed, "a restore of the title's label cut does not let the key through");
});

test("restore of a format, held or dump cut's id, or of an id the bundle has no cut of, is a 400 and restores nothing", async () => {
  const { doc } = await build();
  for (const kind of ["format", "held", "dump"]) {
    const cut = doc.cuts.find((each) => each.kind === kind);
    assert.ok(cut, kind);
    await assert.rejects(build({ restore: [cut.id] }), (error) => error instanceof ApiError && error.status === 400 && /not restorable/.test(error.message) && !error.message.includes(PLANTED.sk), `${kind}: 400`);
  }
  await assert.rejects(build({ restore: ["c_0123456789abcdef"] }), (error) => error instanceof ApiError && error.status === 400 && /no cut/.test(error.message));
  // One bad id refuses the whole request, a good one beside it included.
  const label = doc.cuts.find((cut) => cut.kind === "label");
  const format = doc.cuts.find((cut) => cut.kind === "format");
  await assert.rejects(build({ restore: [label.id, format.id] }), (error) => error instanceof ApiError && error.status === 400);
});

test("restoreIdsOf reads ?restore= as comma-separated ids, repeated or not, and refuses anything that is not an id", () => {
  const of = (query) => restoreIdsOf(new URL(`http://x/v2/runs/r/export${query}`));
  assert.deepEqual(of(""), []);
  assert.deepEqual(of("?restore="), []);
  assert.deepEqual(of("?restore=c_0123456789abcdef,c_fedcba9876543210&restore=c_0123456789abcdef"), ["c_0123456789abcdef", "c_fedcba9876543210"]);
  for (const bad of ["?restore=c_xyz", "?restore=0123456789abcdef", `?restore=${encodeURIComponent(PLANTED.pg)}`]) assert.throws(() => of(bad), (error) => error instanceof ApiError && error.status === 400);
});

test("fails closed: a scrub that answers ok:false, or throws, fails the whole export with ExportFailed and no bundle", async () => {
  let calls = 0;
  const failing = async (text, opts) => ((calls += 1), calls === 7 ? { ok: false, counts: {} } : scrub(text, opts));
  await assert.rejects(build({ scrub: failing }), ExportFailed);
  await assert.rejects(build({ scrub: async () => { throw new Error("rule blew up"); } }), ExportFailed);
});

test("fails closed on its read-back: a cut pass that leaves a known format or a held value in the document (a scrub that cut nothing) fails the export", async () => {
  const blind = async (text) => ({ ok: true, text, cuts: [], counts: {} });
  await assert.rejects(build({ scrub: blind }), ExportFailed);
});

test("a workflow run's graph is carried, every string in it cut", async () => {
  const graph = {
    read_at: "2026-11-23T11:00:00.000Z",
    run: { id: "run_golden", agent: "agent_golden", revision: "rev_golden", status: "completed", paused: false, startedAt: "2026-11-23T10:00:00.000Z", endedAt: "2026-11-23T10:05:00.000Z" },
    nodes: [{ id: "n1", label: `Ask ${PLANTED.email}`, items: [{ label: `key ${PLANTED.sk}` }] }],
  };
  const { doc, body } = await build({ graph, view: { ...viewOf(), kind: "workflow" } });
  assert.equal(doc.agent.kind, "workflow");
  // The read's own time is dropped (it changes each read, and two exports are byte-identical), and the run's ids, as the
  // run allowlist drops them: what the page reads of graph.run is its status, pause and times.
  assert.ok(!("read_at" in doc.graph));
  assert.deepEqual(doc.graph.run, { status: "completed", paused: false, startedAt: "2026-11-23T10:00:00.000Z", endedAt: "2026-11-23T10:05:00.000Z" });
  assert.equal(doc.graph.nodes[0].id, "n1");
  assert.match(doc.graph.nodes[0].label, /^Ask \[redacted:email\]$/);
  assert.ok(doc.cuts.some((cut) => cut.at === "/graph/nodes/0/items/0/label" && cut.kind === "format"));
  assertNoPlanted(body);
});

// --- A call's output with its call's context (ruling LVI). The export reads the run's rows twice: as served (the bundle's
// rows) and with their calls' arguments (`calls`, read for each call's context alone). A result's preview, an approval
// outcome's text and a workflow call's output are cut knowing the file the call read or the command it ran, so a
// credential file's or a dump command's output is one dump cut. Every value is synthetic, derived from a fixed seed. ---

const CTX_PW = `Cu${hex("ctx-pw", 18)}`;
const CTX_PGPASS = `db:5432:app:svc:${CTX_PW}`;
const CTX_ENV = `APP_REGION=north\nAPP_SEED=${CTX_PW}`;
const AT = "2026-11-23T10:00:01.000Z";

/** One call `name` with `input` that printed `output`, as a run's served rows show it (its call's row, its result's row,
 *  the output alone in the result's preview) and as the calls read shows it (the call's row with its whole input, the
 *  result's longer head). `approved`: the call waited for a person, who allowed it, so its outcome row (id `outcome`)
 *  shows the output again. */
function callRows(name, input, output, { id = "toolu_01", approved = false, outcome = `approval:${id}:after:outcome` } = {}) {
  const base = { timestamp: AT, created_at: AT, tool_name: name, tool_use_id: id, tool_status: null, tool_input_preview: null, tool_result_preview: null };
  const call = { ...base, id: `${id}:call`, kind: "tool_use", summary: `${name} ${JSON.stringify(input)}`, text: "", tool_input_preview: JSON.stringify(input) };
  const result = { ...base, id: `${id}:result`, kind: "tool_result", summary: name, text: "", tool_status: "completed", tool_result_preview: output };
  const asked = { ...base, id: `approval:${id}`, kind: "approval", summary: `Asked your approval: ${name}`, text: JSON.stringify(input), tool_input_preview: JSON.stringify(input) };
  const told = { ...base, id: outcome, kind: "phase", summary: `AgentRun: ${name} ran once you allowed it; its result went to the agent`, text: `${name} ran once you allowed it. Its result:\n${output}`, tool_name: null, tool_use_id: null };
  const rows = approved ? [call, asked, result, told] : [call, result];
  const calls = rows.map((row) => (row.kind === "tool_use" ? { ...row, tool_input: input } : row.kind === "tool_result" ? { ...row, tool_result_text: output } : row));
  return { rows, calls };
}

/** The reads of an ended run (run-export.ts ExportReads), its rows and calls as given; a workflow's `graph`. */
function readsOf({ rows = [], calls = rows, graph = null }) {
  return {
    view: async () => ({ kind: graph ? "workflow" : "agentic", status: "completed", state: "completed", title: "Look", agent_id: "agent_ctx", poll_after_ms: 0 }),
    withheld: async () => false,
    rows: async () => rows,
    calls: async () => calls,
    graph: async () => graph,
    files: async () => ({ files: [], truncated: false }),
    agentName: async () => "Context agent",
    cut: async () => ({ values: [] }),
  };
}

const exported = async (reads, restore = []) => {
  const { body } = await runExport("run_ctx", reads, { restore, version: "0.0.0-ctx" });
  return { body, doc: JSON.parse(body) };
};

/** The cuts at `pointer`. */
const cutsAt = (doc, pointer) => doc.cuts.filter((cut) => cut.at === pointer);

/** `text` is one dump marker of `rule`, whole. */
const oneDump = (doc, pointer, rule) => {
  const cuts = cutsAt(doc, pointer);
  assert.deepEqual(cuts.map((cut) => [cut.kind, cut.rule, cut.restorable]), [["dump", rule, false]], `${pointer}: ${JSON.stringify(doc.cuts)}`);
  assert.match(valueAt(doc, pointer), new RegExp(`^\\[redacted:${rule}( \\d+ lines)?\\]$`), pointer);
};

/** Every call ruling LVI reads as a dump, its tool, input, output and the dump's rule. */
const DUMP_CALLS = [
  ["Read ~/.pgpass", "Read", { file_path: "~/.pgpass" }, CTX_PGPASS, "credential-file"],
  ["Read ~/.netrc", "Read", { file_path: "~/.netrc" }, `machine api.sample-host.zz login svc password ${CTX_PW}`, "credential-file"],
  ["Read .env", "Read", { file_path: ".env" }, CTX_ENV, "env-file"],
  ["Read ~/.ssh/id_ed25519", "Read", { file_path: "~/.ssh/id_ed25519" }, `Host build\n  HostName 10.0.0.1\n  User svc\n  # seed ${CTX_PW}`, "ssh-file"], // key-gate: denylist a private literal in the ssh config the scrubber cuts as one dump
  ["Bash cat ~/.pgpass", "Bash", { command: "cat ~/.pgpass", description: "Show the pgpass file" }, CTX_PGPASS, "credential-file"],
  ["Bash env | sort", "Bash", { command: "env | sort", description: "List the environment" }, CTX_ENV, "env-dump"],
  ["bash -lc printenv", "shell", { command: ["bash", "-lc", "printenv"] }, CTX_ENV, "env-dump"],
];

test("LVI: a call's output is cut with its call's context, so a credential file's read or a dump command's output is one dump cut, not line-by-line cuts", async () => {
  for (const [name, tool, input, output, rule] of DUMP_CALLS) {
    const { doc, body } = await exported(readsOf(callRows(tool, input, output)));
    assert.equal(doc.rows[1].kind, "tool_result", name);
    oneDump(doc, "/rows/1/tool_result_preview", rule);
    assertNoPlanted(body, { pw: CTX_PW });
    // The call's own row (its arguments) is cut as it was, with no context: its command is no output.
    assert.equal(doc.rows[0].tool_input_preview, JSON.stringify(input), name);
  }
});

test("LVI: a failed call's summary, the first line of its output, is cut with the call's context as its preview is", async () => {
  // A shell call that printed the file, then failed (a timeout): its result row's summary is its output's first line.
  const output = `${CTX_PGPASS}\nCommand timed out after 5s`;
  const { rows, calls } = callRows("Bash", { command: "cat ~/.pgpass; sleep 5" }, output);
  const failed = (row) => (row.kind === "tool_result" ? { ...row, tool_status: "failed", summary: `Bash failed: ${CTX_PGPASS}` } : row);
  const { doc, body } = await exported(readsOf({ rows: rows.map(failed), calls: calls.map(failed) }));
  oneDump(doc, "/rows/1/tool_result_preview", "credential-file");
  oneDump(doc, "/rows/1/summary", "credential-file");
  assertNoPlanted(body, { pw: CTX_PW });
});

test("LVI: a failed env call's summary (`env; sleep 5`, timed out) is cut with its call's context: a plain variable's value is not carried", async () => {
  // Its first line is a variable with no key-shaped name and no format: only the env command's context cuts it.
  const region = `basin${hex("ctx-region", 10)}`;
  const output = `APP_REGION=${region}\nAPP_SEED=${CTX_PW}\nCommand timed out after 5s`;
  const { rows, calls } = callRows("Bash", { command: "env; sleep 5" }, output);
  const failed = (row) => (row.kind === "tool_result" ? { ...row, tool_status: "failed", summary: `Bash failed: APP_REGION=${region}` } : row);
  const { doc, body } = await exported(readsOf({ rows: rows.map(failed), calls: calls.map(failed) }));
  assert.deepEqual(cutsAt(doc, "/rows/1/tool_result_preview").map((cut) => [cut.kind, cut.rule]), [["dump", "env-dump"]], JSON.stringify(doc.cuts));
  assert.deepEqual(cutsAt(doc, "/rows/1/summary").map((cut) => [cut.kind, cut.rule]), [["dump", "env-dump"]], JSON.stringify(doc.cuts));
  assert.equal(valueAt(doc, "/rows/1/summary"), "Bash failed: [redacted:env-dump 1 lines]");
  assert.ok(!body.includes(region), "the variable's value is not carried");
  assertNoPlanted(body, { pw: CTX_PW });
});

test("LVI: a read of an unrelated file, or a command that is no read or dump, is cut as it was: its prose kept as is", async () => {
  for (const [name, tool, input, output] of [
    ["Read notes.txt, prose", "Read", { file_path: "notes.txt" }, "The notes say: meet at noon by the north door."],
    ["Read notes.txt, a pgpass-shaped line", "Read", { file_path: "notes.txt" }, CTX_PGPASS],
    ["Bash cat notes.txt", "Bash", { command: "cat notes.txt" }, CTX_PGPASS],
    ["Bash echo ok", "Bash", { command: "echo ok" }, "ok"],
  ]) {
    const { doc } = await exported(readsOf(callRows(tool, input, output)));
    assert.deepEqual(cutsAt(doc, "/rows/1/tool_result_preview"), [], `${name}: ${JSON.stringify(doc.cuts)}`);
    assert.equal(doc.rows[1].tool_result_preview, output, name);
  }
});

test("LVI: the rows read with their calls' arguments name each call's context and nothing else: none of their strings is carried", async () => {
  const marker = `callsonly${hex("calls-only", 16)}`;
  const { rows, calls } = callRows("Read", { file_path: "~/.pgpass" }, CTX_PGPASS);
  // The calls read holds more than the served rows: the call's whole input, its result's longer head.
  const more = calls.map((row) => (row.kind === "tool_use" ? { ...row, tool_input: { ...row.tool_input, note: marker } } : { ...row, tool_result_text: `${CTX_PGPASS}\n${marker}` }));
  const { doc, body } = await exported(readsOf({ rows, calls: more }));
  oneDump(doc, "/rows/1/tool_result_preview", "credential-file");
  assert.ok(!body.includes(marker), "a calls row's string is not in the bundle");
  assert.ok(!body.includes("tool_input\""), "no row carries tool_input");
  assert.deepEqual(doc.rows.map((row) => row.id), rows.map((row) => row.id), "the served rows, in order");
});

test("LVI: a .pgpass read a person approved: its outcome row's whole text is cut by the same rule, under either outcome id", async () => {
  for (const outcome of ["approval:toolu_01:after:outcome", "approval:toolu_01:outcome"]) {
    for (const [tool, input] of [["Read", { file_path: "~/.pgpass" }], ["Bash", { command: "cat ~/.pgpass" }]]) {
      const { doc, body } = await exported(readsOf(callRows(tool, input, CTX_PGPASS, { approved: true, outcome })));
      const at = doc.rows.findIndex((row) => row.id === outcome);
      assert.equal(doc.rows[at].tool_use_id, null, "the outcome row names no call of its own");
      oneDump(doc, `/rows/${at}/text`, "credential-file");
      oneDump(doc, `/rows/${doc.rows.findIndex((row) => row.kind === "tool_result")}/tool_result_preview`, "credential-file");
      assertNoPlanted(body, { pw: CTX_PW });
    }
  }
});

test("LVI: a workflow call's output is cut with its own tool's and input's context, every string in it", async () => {
  const effect = (tool, input, output) => ({ node: "n1", executionPath: "0", item: null, tool, status: "done", input, output, error: null, startedAt: AT, endedAt: AT });
  const graph = {
    read_at: AT,
    run: { id: "run_ctx", status: "completed", paused: false, startedAt: AT, endedAt: AT },
    nodes: [{ id: "n1", label: "Look" }],
    effects: [
      effect("read", { file_path: "~/.pgpass" }, CTX_PGPASS),
      effect("shell", { command: "env" }, CTX_ENV),
      effect("shell", { command: ["bash", "-lc", "printenv"] }, { stdout: CTX_ENV, code: 0 }),
      effect("read", { file_path: "notes.txt" }, "The notes say: meet at noon by the north door."),
    ],
  };
  const { doc, body } = await exported(readsOf({ graph }));
  assert.equal(doc.agent.kind, "workflow");
  oneDump(doc, "/graph/effects/0/output", "credential-file");
  oneDump(doc, "/graph/effects/1/output", "env-dump");
  oneDump(doc, "/graph/effects/2/output/stdout", "env-dump");
  assert.deepEqual(cutsAt(doc, "/graph/effects/3/output"), []);
  assert.equal(doc.graph.effects[3].output, graph.effects[3].output);
  // Its input is the call's arguments, cut as it was: the command is no output.
  assert.equal(doc.graph.effects[1].input.command, "env");
  assertNoPlanted(body, { pw: CTX_PW });
});

test("LVI: a restore of a cut id a context-free read named on a call's output answers 400 no cut: the export cuts it as one dump now", async () => {
  const { rows, calls } = callRows("Read", { file_path: "~/.netrc" }, `machine api.sample-host.zz login svc password ${CTX_PW}`);
  // The same rows read with no call's context (no calls read): what a context-free count would list.
  const { doc: bare } = await exported(readsOf({ rows, calls: [] }));
  const label = cutsAt(bare, "/rows/1/tool_result_preview").find((cut) => cut.restorable);
  assert.ok(label, `a restorable cut there without context: ${JSON.stringify(bare.cuts)}`);
  await assert.rejects(exported(readsOf({ rows, calls }), [label.id]), (error) => error instanceof ApiError && error.status === 400 && /no cut/.test(error.message) && !error.message.includes(CTX_PW));
});

test("LVI: an env command a person approved: its outcome row's text holds one env-dump cut below the outcome's head line, and no planted value", async () => {
  for (const [tool, input] of [["Bash", { command: "env | sort" }], ["shell", { command: ["bash", "-lc", "printenv"] }], ["Bash", { command: "printenv" }]]) {
    const { doc, body } = await exported(readsOf(callRows(tool, input, CTX_ENV, { approved: true })));
    const at = doc.rows.findIndex((row) => row.id === "approval:toolu_01:after:outcome");
    assert.deepEqual(cutsAt(doc, `/rows/${at}/text`).map((cut) => [cut.kind, cut.rule, cut.restorable]), [["dump", "env-dump", false]], `${JSON.stringify(input)}: ${JSON.stringify(doc.cuts)}`);
    assert.equal(doc.rows[at].text, `${tool} ran once you allowed it. Its result:\n[redacted:env-dump 2 lines]`);
    oneDump(doc, `/rows/${doc.rows.findIndex((row) => row.kind === "tool_result")}/tool_result_preview`, "env-dump");
    assertNoPlanted(body, { pw: CTX_PW });
  }
});
