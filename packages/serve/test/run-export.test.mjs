// The share bundle's pure builder (run-export.ts exportBundle): a run's served view, rows, graph and files in, one
// `agentrun.share/1` document out, every string in it cut by the scrubber with the run's held values. Every value here is
// synthetic: the planted secrets are derived from fixed seeds at test time (none is a literal in this file), so the golden
// document is the same on every run and no real-looking key sits in the repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXPORT_CAPS, ExportFailed, exportBundle, restoreIdsOf, SHARE_FORMAT, SHARE_RUN_FIELDS } from "../dist/run-export.js";
import { ApiError } from "../dist/errors.js";
import { SCRUB_RULES, scrub } from "../dist/secret-cut.js";
import { stable } from "../dist/validate.js";

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
  ip: salt ? "10.20.30.42" : "10.20.30.41", // personal (a private address)
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
    result: { output: null, final_answer: `Done. Mail ${p.email} about /home/${p.user}/work; key ${p.sk}.` },
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
    row(3, "tool_result", ["$ env", `HOME=/home/${p.user}`, "PATH=/usr/bin", `SECRET_THING=${p.envValue}`, "SHELL=/bin/sh", "$ echo done"].join("\n")),
    row(4, "text_block", `The host ${p.ip} answered from /home/${p.user}/work.`),
    row(5, "final_answer", `Done. Mail ${p.email} about /home/${p.user}/work; key ${p.sk}.`),
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
  const actual = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
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
