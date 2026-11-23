// `agentrun-serve scrub RUN` (scrub-command.ts): what a share of one run would cut, counted from the local store, by rule
// and by kind, with how many cuts the person could restore. Counts only: a planted secret's characters never reach stdout
// or stderr, as a table or as JSON. An unknown run exits 2; a withheld run (its cut unreadable here) exits 1 and counts
// nothing. Every run here is synthetic, its secrets made fresh for each case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";

const { openSqliteStore } = await import("../dist/store/index.js");
const { countCuts, countTable, couldNotCount, stringsOf } = await import("../dist/scrub-command.js");
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

/** Fresh synthetic secrets: an sk- key (a known format), a PGPASSWORD= value (a label), an email (personal) and a value
 *  the server holds (an environment variable named as a secret, so hostSecrets lists it). */
function planted() {
  return {
    sk: `sk-${randomBytes(24).toString("hex")}`,
    pg: `Pw${randomBytes(9).toString("hex")}`,
    email: `qa.${randomBytes(4).toString("hex")}@mailbox-synthetic.zz`,
    held: `held${randomBytes(16).toString("hex")}`,
  };
}

/** A temp data directory with a store and agent a1, closed; removed at the case's end. */
async function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-scrub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  await store.agents.create({ id: "a1", name: "Synthetic agent" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  return { dir, store };
}

/** An imported session, ended, its words holding every planted secret. */
async function importedRun(store, s, id = "imp-1") {
  const at = Date.now();
  await store.importRun({
    id,
    agentId: "a1",
    revisionId: "r1",
    importedFrom: { source: "claude-code", session: "synthetic-session" },
    launch: { body: { input: { content: `Connect with PGPASSWORD=${s.pg} psql -h db` }, title: `Notes for ${s.email}`, place: { mode: "runner" } } },
    state: "ended",
    summary: "Connected.",
    startedAt: at,
    endedAt: at,
    transcript: [[
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      { type: "entry", value: { id: Number(ROOT_CONVERSATION_ID) + 1, conversationId: ROOT_CONVERSATION_ID, kind: UserEntry.kind, model: [{ role: "user", content: [{ type: "text", text: `Connect with PGPASSWORD=${s.pg} psql -h db, then mail ${s.email}` }], timestamp: at }] } },
      { type: "entry", value: { id: Number(ROOT_CONVERSATION_ID) + 2, conversationId: ROOT_CONVERSATION_ID, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Set OPENAI_API_KEY=${s.sk} and the token ${s.held}. Connected.` }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, timestamp: at }] } },
    ]],
  });
  return id;
}

/** A run this server ran (claimed, its journal written, ended), its input holding the sk- key; `handed`: its row marked
 *  handed a browser sign-in pointer, which no seal key here opens, so it is withheld. */
async function servedRun(store, s, { id = "run-1", handed = false } = {}) {
  await store.runs.create({ id, agentId: "a1", revisionId: "r1" }, { body: { input: { content: `Use ${s.sk} for the call.` }, title: "Call the API", place: { mode: "runner" }, ...(handed ? { plane: { browser: "browserbase" } } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (handed) await store.runs.update(claim, { signInHanded: [createHash("sha256").update(`bb-ctx-${randomBytes(10).toString("hex")}`).digest("hex")] });
  const journal = store.journal(claim);
  const answer = { id: await journal.mintId(), conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Called it with ${s.sk}.` }], usage: { cost: { total: 0 } }, timestamp: 0 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: answer }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Called it.", costUsd: 0, endedAt: Date.now() });
  return id;
}

/** The scrub command on `dir`, the held value in the environment as a secret-named variable, no store URL or seal key
 *  inherited. */
function scrubCli(dir, s, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["AGENTRUN_STORE_URL", "AGENTRUN_SEAL_KEY"].includes(name)));
  return spawnSync(process.execPath, [CLI, "scrub", "--data", dir, ...args], { env: { ...env, SCRUBTEST_SECRET: s.held, AGENTRUN_TELEMETRY: "0" }, encoding: "utf8", timeout: 120_000 });
}

/** No 8-character piece of any planted secret, and no shape (its ellipsis), in `text`. */
function assertNoValue(text, s, where) {
  for (const [name, value] of Object.entries(s)) {
    for (let i = 0; i + 8 <= value.length; i++) assert.ok(!text.includes(value.slice(i, i + 8)), `${where}: no piece of the ${name} value (at ${i})`);
  }
  assert.ok(!text.includes("…"), `${where}: no shape`);
}

/** The table's lines `rule kind restorable count`, as rows. */
const tableRows = (stdout) =>
  stdout.split("\n").map((line) => line.trim().split(/\s{2,}/)).filter((cells) => cells.length === 4 && /^\d+$/.test(cells[3]) && (cells[2] === "yes" || cells[2] === "no"));

test("an imported session: the table counts its cuts by rule and kind, says what a share would cut and restore, and prints no piece of any secret", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  const id = await importedRun(store, s);
  await store.close();
  const ran = scrubCli(dir, s, id);
  assert.equal(ran.status, 0, ran.stderr);
  assertNoValue(ran.stdout + ran.stderr, s, "table");
  const rows = tableRows(ran.stdout);
  const byKind = (kind) => rows.filter((row) => row[1] === kind).reduce((n, row) => n + Number(row[3]), 0);
  assert.ok(byKind("label") >= 1, `the PGPASSWORD= value is a label cut:\n${ran.stdout}`);
  assert.ok(byKind("personal") >= 1, `the email is a personal cut:\n${ran.stdout}`);
  for (const row of rows) assert.equal(row[2], ["label", "personal", "jev"].includes(row[1]) ? "yes" : "no", `restorable by kind: ${row.join(" ")}`);
  const total = rows.reduce((n, row) => n + Number(row[3]), 0);
  const restorable = rows.filter((row) => row[2] === "yes").reduce((n, row) => n + Number(row[3]), 0);
  assert.match(ran.stdout, new RegExp(`^A share would make ${total} cuts?; you could restore ${restorable} of them\\.$`, "m"));
  assert.match(ran.stdout, /^label +\d+$/m, "the totals by kind");
  assert.match(ran.stdout, /^personal +\d+$/m, "the totals by kind");
  // The sk- key (a known shape) and the held value are cut where the server serves the run ([redacted]), before the
  // scrubber reads it: said, as a count, at least once each.
  const already = Number(/^Already cut before this count: (\d+) /m.exec(ran.stdout)?.[1]);
  assert.ok(already >= 2, ran.stdout);
});

test("--json says the same as JSON: counts by rule and kind, the cuts a share would make and how many could be restored, and no piece of any secret", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  const id = await importedRun(store, s);
  await store.close();
  const ran = scrubCli(dir, s, id, "--json");
  assert.equal(ran.status, 0, ran.stderr);
  assertNoValue(ran.stdout + ran.stderr, s, "json");
  const count = JSON.parse(ran.stdout);
  assert.equal(count.run_id, id);
  assert.ok(count.strings > 0);
  for (const rule of count.rules) assert.deepEqual(Object.keys(rule).sort(), ["count", "kind", "restorable", "rule"], "a rule's line holds its id, kind, restorability and count, nothing of a value");
  assert.ok(count.by_kind.label >= 1 && count.by_kind.personal >= 1, JSON.stringify(count));
  assert.equal(count.cuts, count.rules.reduce((n, rule) => n + rule.count, 0));
  assert.equal(count.restorable, count.by_kind.label + count.by_kind.personal + count.by_kind.jev);
  assert.ok(count.already_redacted >= 2, "the sk- key and the held value, cut where the server serves the run");
});

test("a run this server ran is counted the same way, from its launch and journal: its sk- key is cut where it is served, so a share makes no cut of it", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  const id = await servedRun(store, s);
  await store.close();
  const ran = scrubCli(dir, s, id, "--json");
  assert.equal(ran.status, 0, ran.stderr);
  assertNoValue(ran.stdout + ran.stderr, s, "served json");
  const count = JSON.parse(ran.stdout);
  assert.ok(count.strings > 0);
  assert.equal(count.cuts, 0, JSON.stringify(count));
  assert.ok(count.already_redacted >= 2, "the key in its input and in its answer, each [redacted] as served");
});

test("an unknown run exits 2 in plain words, on a store and on a data directory with none", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  await store.close();
  const ran = scrubCli(dir, s, "no-such-run");
  assert.equal(ran.status, 2, ran.stderr);
  assert.match(ran.stderr, /there is no run no-such-run in /);
  assert.equal(ran.stdout, "");
  const empty = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-scrub-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const none = scrubCli(empty, s, "no-such-run", "--json");
  assert.equal(none.status, 2, none.stderr);
  assert.match(none.stderr, /there is no run no-such-run in /);
  assert.equal(none.stdout, "");
});

test("a withheld run (a sign-in it was handed that nothing here opens) exits 1, says so, and counts nothing", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  const id = await servedRun(store, s, { handed: true });
  await store.close();
  for (const args of [[id], [id, "--json"]]) {
    const ran = scrubCli(dir, s, ...args);
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /is withheld/);
    assert.match(ran.stderr, /nothing was counted/);
    assert.equal(ran.stdout, "", "no count, not even one made without the held values");
    assertNoValue(ran.stderr, s, "withheld");
  }
});

test("no run id, or two, exits 2 with the command's usage", async (t) => {
  const s = planted();
  const { dir, store } = await dataDir(t);
  await store.close();
  for (const args of [[], ["a", "b"]]) {
    const ran = scrubCli(dir, s, ...args);
    assert.equal(ran.status, 2, ran.stderr);
    assert.match(ran.stderr, /usage: agentrun-serve scrub RUN/);
  }
});

test("P2 14 (ruling F): a share's strings include object keys, so a key holding a secret is counted", async () => {
  const s = planted();
  const strings = stringsOf({ [`PGPASSWORD=${s.pg}`]: 1, list: ["x", { inner: "y" }], n: 3, none: null });
  for (const each of [`PGPASSWORD=${s.pg}`, "list", "x", "inner", "y", "n", "none"]) assert.ok(strings.includes(each), each);
  const count = await countCuts("r", "agentic", strings, []);
  assert.equal(count.rules.find((rule) => rule.rule === "secret-assign")?.count, 1, JSON.stringify(count));
});

test("ruling F: count mode reports blocked when a share would fail closed, and the table says the share would be refused", async () => {
  const s = planted();
  // One character mid-value percent-encoded: no held form (nor its hex run) stands in place, the final check's decoded
  // view sees it.
  const split = `token ${s.held.slice(0, 20)}%${s.held.charCodeAt(20).toString(16).toUpperCase()}${s.held.slice(21)}`;
  const count = await countCuts("r", "agentic", ["fine", split], [s.held]);
  assert.equal(count.blocked, true);
  assert.match(countTable(count), /a share of this run would be refused/);
  assertNoValue(countTable(count) + JSON.stringify(count), s, "blocked count");
  const fine = await countCuts("r", "agentic", ["fine"], [s.held]);
  assert.equal(fine.blocked, false);
  assert.doesNotMatch(countTable(fine), /refused/);
});

test("P2 13 (ruling H): the error path cuts the run's held values out of the error's words too", async () => {
  const s = planted();
  const line = await couldNotCount("r", new Error(`read failed near ${s.held} in row 3`), [s.held]);
  assert.match(line, /could not be counted/);
  assertNoValue(line, s, "error line");
});
