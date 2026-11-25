// A purge leaves no copy of what the run was given or did, wherever the server copied it (DELETE /v2/runs/{run_id},
// agent-delete.ts purgeRun). One sentinel, a word no other test or fixture holds, is planted in everything a run is given
// or makes: its input (its prompt), a follow-up message, its answer and its thinking, a file it writes, a tool call's
// arguments and result, a grade's expected answer and its words, the runs made from it (its audit's shadow run and a
// replay of its input), a workflow check that disagreed with it (decided by decideCheck, the claim's own step, its grader's
// words naming the sentinel too), an audit hold that disagreed with it, and its kept learning's proposal. Each is read
// back before the purge (the scan sees each place it looks at). After the purge the sentinel is nowhere:
//   - in no column of any row of any table the store's schema made, listed from the database itself (SQLite's
//     sqlite_master, Postgres' information_schema), the settings' rows among them;
//   - in no file under the server's data directory, the agents' folders among them (the store's own file aside on SQLite:
//     its rows are read above);
//   - in no answer of any GET route the OpenAPI document lists whose parameters the test can fill (the purged run's own
//     answer 410), the agent's learning, promotions, audits, grades, stats, usage and run lists among them.
// The run's id may still be named where a purge keeps it (its tombstone, a promotion record's inputs); the sentinel never.
// On SQLite, and on Postgres with AGENTRUN_TEST_PG_URL (the server, the runner and the test's handle all on one schema).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { shadowRunId } from "../dist/learn/audit.js";
import { answersPair, recordPromotion } from "../dist/learn/promote.js";
import { openapiDocument } from "../dist/openapi.js";
import { decideCheck } from "../dist/runner/promotion.js";
import { dropSchema, freshSchema, onPostgres, PG_URL, raw } from "./store-target.mjs";
import { FAUX, follow, serve, startInProcessRunner, startRun, WINDOW, withEnv } from "./support.mjs";

const STORE = onPostgres ? "Postgres" : "SQLite";

/** A server whose runner `halt()` closes, on this run's store: on Postgres a schema of the test's own, which the server,
 *  the runner and the test's handle all open (AGENTRUN_STORE_URL, as a deployment names it), dropped after the server
 *  stops. Its store's place, as raw() takes it. */
async function sweepServer(t) {
  const schema = onPostgres ? await freshSchema() : undefined;
  if (schema) withEnv(t, { AGENTRUN_STORE_URL: PG_URL, AGENTRUN_STORE_SCHEMA: schema });
  const server = await serve(t, { runner: false });
  if (schema) t.after(() => dropSchema(schema));
  const close = await startInProcessRunner(server.data, { faux: FAUX, mcpOwn: server.own });
  let closed;
  const halt = () => (closed ??= close());
  t.after(halt);
  return { ...server, halt, place: schema ? `pg:${schema}` : join(server.data, "store.sqlite") };
}

/** Every `table.column` of a row whose value holds `word`, from every table the store's schema made (listed from the
 *  database, never by hand): text, JSON (as its text) and bytes (as UTF-8). */
async function inTables(place, word) {
  const db = await raw(place, { readOnly: true });
  try {
    const tables = db.kind === "sqlite"
      ? await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      : await db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name");
    assert.ok(tables.length > 20, `the schema's tables are read: ${tables.length}`);
    const found = new Set();
    for (const { name } of tables) {
      for (const row of await db.all(`SELECT * FROM "${name}"`)) {
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value !== null && typeof value === "object" ? JSON.stringify(value) : undefined;
          if (text?.includes(word)) found.add(name === "settings" ? `settings[${row.key}]` : `${name}.${column}`);
        }
      }
    }
    return [...found].sort();
  } finally {
    await db.close();
  }
}

/** Every file under `dir` (symbolic links not followed) whose bytes hold `word`, by its path under `dir`; the SQLite
 *  store's own file and the WAL and shared memory beside it aside (inTables reads its rows). */
async function inFiles(dir, word, under = "") {
  const found = [];
  for (const entry of await readdir(join(dir, under), { withFileTypes: true }).catch(() => [])) {
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await inFiles(dir, word, path)));
    else if (entry.isFile() && !/^store\.sqlite(-wal|-shm)?$/.test(path)) {
      if ((await lstat(join(dir, path))).size > 64 * 1024 * 1024) continue;
      if ((await readFile(join(dir, path).toString()).catch(() => Buffer.alloc(0))).includes(word)) found.push(path);
    }
  }
  return found.sort();
}

/** The GET routes the server's OpenAPI document lists, each path with its parameters filled from `fill` (a route with a
 *  parameter `fill` has no value for is not read: listed in `unread`), and `extra` query strings for those that take
 *  them. */
function getRoutes(fill) {
  const doc = openapiDocument(() => undefined);
  const paths = [];
  const unread = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (!ops.get) continue;
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    if (names.some((name) => !fill[name]?.length)) {
      unread.push(path);
      continue;
    }
    let filled = [path];
    for (const name of names) filled = filled.flatMap((one) => fill[name].map((value) => one.replace(`{${name}}`, encodeURIComponent(value))));
    paths.push(...filled);
  }
  return { paths, unread };
}

/** Every GET answer of `paths` (each also with WINDOW and with archived=true, as /usage, /stats and the run lists take
 *  them) whose body holds `word`: "<path> <status>". */
async function inRoutes(api, paths, word) {
  const found = [];
  for (const path of paths) {
    for (const query of ["", `?${WINDOW}`, "?archived=true"]) {
      if (query && !/^\/(usage|stats|runs|agents\/[^/]+\/runs|agents\/[^/]+\/learning\/cost)$/.test(path)) continue;
      const answer = await api("GET", `${path}${query}`, undefined, {}, { raiseCheck: false });
      const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      if (text.includes(word)) found.push(`${path}${query} ${answer.status}`);
    }
  }
  return found;
}

/** Polls GET /runs/{id} until `done` holds of its answer, at most 60 seconds. */
async function until(api, id, done, what) {
  const end = Date.now() + 60_000;
  for (;;) {
    const answer = await api("GET", `/runs/${id}`);
    if (done(answer.body)) return answer.body;
    assert.ok(Date.now() < end, `${what}: ${JSON.stringify(answer.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A run of agent `agentId` written to the store by the test (a replay of another's input, an audit's shadow), claimed
 *  under the test's own claim and ended, as its runner would: only on a server whose runner is halted. */
async function endedRun(store, agentId, id, launch) {
  const agent = await store.agents.get(agentId);
  await store.runs.create({ id, agentId, revisionId: agent.currentRevision }, { body: launch });
  const claim = await store.claim(id, "runner-test", { leaseMs: 120_000 });
  assert.ok(claim, `run ${id} is claimed`);
  await store.runs.update(claim, { state: "ended", costUsd: 0.01, summary: `What ${id} answered.` });
}

test(`a purged run leaves no copy of what it was given or did (${STORE}): one sentinel, planted in everything a run is given or makes and read back before, is in no table's row, no setting, no file under the data directory and no GET answer after`, { timeout: 300_000 }, async (t) => {
  const word = `PURGE-SENTINEL-${randomBytes(6).toString("hex")}`;
  const { api, data, store, halt, place } = await sweepServer(t);

  // Its input, a file it writes, a tool call's arguments and result, its answer and its thinking (the faux model's "Keep
  // <word> everywhere."); then a follow-up message, whose answer quotes it.
  const gone = (await startRun(api, "calc", `Keep ${word} everywhere.`, { tools: ["write", "read"] })).run_id;
  await follow(api, gone, ["completed"]);
  const sent = await api("POST", `/runs/${gone}/messages`, { content: `And ${word} again.` });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await until(api, gone, (run) => run.status === "completed" && JSON.stringify(run).includes("Again:"), "the follow-up is answered");
  // A sibling run, kept: its own content stays.
  const kept = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(kept.status, 202, JSON.stringify(kept.body));
  await follow(api, kept.body.run_id, ["completed"]);
  // A grade's expected answer and its words.
  const graded = await api("PUT", `/runs/${gone}/grade`, { correct: false, expected: { answer: word }, label: `It should say ${word}.` });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  await halt();

  // The runs made from it: its audit's shadow run and a replay of its input, each holding its input.
  const shadow = shadowRunId(gone);
  const replay = `replay-of-${gone}`;
  await endedRun(store, "calc", shadow, { input: { content: `Keep ${word} everywhere.` }, title: "Audit", place: { mode: "runner" }, audit: { of: gone, workflow: "flow", digest: "d-audit" } });
  await endedRun(store, "calc", replay, { input: { content: `Keep ${word} everywhere.` }, title: "Replay", place: { mode: "runner" }, replay: { of: gone, workflow: "flow", digest: "d-check" } });
  // A workflow check that disagreed with it, decided as a claim decides one (its copy of the input, the agent's answer,
  // the draft's answer, and the grader's words, which its reason quotes); and one input it agreed on, the sibling's.
  const draft = `Draft of ${word}`;
  const agentAnswer = `Kept ${word}.`;
  const bar = { compile_after: 2, agree_min: 0.9, alone_min: 0.5, attempt: 1 };
  // Its grade's expected answer, the sentinel a key of it and in its value, written over the agent's answer (a JSON
  // object here): the check judges the draft against that corrected answer whole.
  const expected = { [word]: `It is ${word}.` };
  const agentJson = JSON.stringify({ note: agentAnswer });
  const corrected = JSON.stringify({ note: agentAnswer, ...expected });
  const rows = [
    { of: gone, input: `Keep ${word} everywhere.`, agent: agentJson, outcome: "answered", answer: draft, correct: false, expected, compared: { same: false, grader: "faux-fast", differs_on: `whether it says ${word}`, pair: answersPair(draft, corrected) } },
    { of: kept.body.run_id, input: "What is six times seven?", agent: "The answer is 42.", outcome: "answered", answer: "The answer is 42." },
  ];
  const decided = await decideCheck({ store, agentId: "calc", log: () => {}, shown: async () => ({ text: (text) => text }) }, "flow", "d-check", bar, { rows, cost: 0.02, outcomes: { answered: 2, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 }, (was) => was === undefined, {});
  assert.equal(decided.won, true, "the check is decided");
  assert.equal(decided.record.decided, "hold", `it disagreed, so it is held: ${decided.record.reason}`);
  // An audit hold that disagreed with it, as runner/audit.ts applyHold writes one.
  await recordPromotion(store.settings, "calc", {
    workflow: "flow", digest: "d-audit", at: new Date().toISOString(), decided: "hold", reason: "its audits disagreed with the agent on 1 of 1",
    audit: { window: 1, disagree: 1, rows: 1, disagreements: [{ run: shadow, served: gone, input: `Keep ${word} everywhere.`, agent: agentAnswer, draft }] },
  }, () => true);
  // A connected agent's check still collecting native turns, which disagreed on it (runner/promotion.ts sdkCheckTurn).
  const collecting = {
    workflow: "turns", digest: "d-turns", at: new Date().toISOString(), decided: "replaying", via: "sdk", replay_id: "turns-check", reason: "Waiting for the next native turn of the connected agent that it takes.",
    check: { ...bar, turns: { n: 1, agreed: 0, alone: 1, of: [gone], outcomes: { answered: 1, handed_back: 0, failed: 0, skipped_write: 0 }, disagreements: [{ run: gone, input: `Keep ${word} everywhere.`, agent: agentAnswer, draft }] } },
  };
  await recordPromotion(store.settings, "calc", collecting, () => true);
  // Its kept learning: what its learning turn asked and what it proposed.
  const db = await raw(place);
  try {
    await db.run("INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, learning_run_id, created_at) VALUES (?, 99, 'calc', ?, ?, NULL, ?)", gone, JSON.stringify({ asked: `What did ${word} mean?` }), JSON.stringify({ state: "merged", detail: `Learned ${word}.` }), Date.now());
  } finally {
    await db.close();
  }

  const fill = {
    agent_id: ["calc"], run_id: [gone, kept.body.run_id, shadow, replay], path: ["kept.md"], name: ["flow"], digest: ["d-check", "d-audit"],
    file: ["audits.jsonl"], replay_id: [], file_id: [], trigger_id: [], provider: [],
  };
  const { paths, unread } = getRoutes(fill);
  assert.ok(paths.length > 40, `the GET routes read: ${paths.length}`);
  t.diagnostic(`GET routes not read (a parameter with no value here): ${unread.join(", ")}`);

  // Before: each place holds it, so each scan below is known to see what it looks at.
  const before = { tables: await inTables(place, word), files: await inFiles(data, word), routes: await inRoutes(api, paths, word) };
  t.diagnostic(`before the purge: ${JSON.stringify(before)}`);
  for (const where of ["run_launch.body", "learning_proposals.turn", "learning_proposals.proposal", "settings[learning.promotions.calc]", "settings[learning.grades.calc]"]) {
    assert.ok(before.tables.includes(where), `${where} holds it before: ${before.tables.join(", ")}`);
  }
  assert.ok(before.tables.some((where) => !where.startsWith("settings[") && !["run_launch.body", "learning_proposals.turn", "learning_proposals.proposal"].includes(where)), `its journal holds it before: ${before.tables.join(", ")}`);
  assert.ok(before.files.some((path) => path.endsWith("/work/kept.md")), `the file it wrote holds it before: ${before.files.join(", ")}`);
  assert.ok(before.routes.some((one) => one.startsWith(`/runs/${gone}/timeline `)), `its timeline holds it before: ${before.routes.join(", ")}`);
  assert.ok(before.routes.some((one) => one.startsWith("/agents/calc/learning/promotions ")), `the promotions read holds it before: ${before.routes.join(", ")}`);

  const deleted = await api("DELETE", `/runs/${gone}`);
  assert.equal(deleted.status, 204, `DELETE /runs/{id}: ${deleted.status} ${JSON.stringify(deleted.body)}`);

  const after = { tables: await inTables(place, word), files: await inFiles(data, word), routes: await inRoutes(api, paths, word) };
  assert.deepEqual(after, { tables: [], files: [], routes: [] }, `the sentinel is left after the purge: ${JSON.stringify(after)}`);

  // What a purge keeps of what it blanked: each record's decision, counts and run ids.
  const { promotions } = (await api("GET", "/agents/calc/learning/promotions")).body;
  const [check, audit] = ["d-check", "d-audit"].map((digest) => promotions.find((one) => one.digest === digest));
  assert.deepEqual([check?.decided, check?.check.n, check?.check.agreed, check?.check.alone, check?.check.of], ["hold", 2, 1, 2, [gone, kept.body.run_id]], `the check's decision and numbers are kept: ${JSON.stringify(check)}`);
  assert.deepEqual(check.check.disagreements, [{ run: gone, input: "", agent: null, draft: "", fields: ["answer"], expected: [{ field: "answer", known: "grade", value: "" }] }], "its disagreement names the run, the field it had wrong and where its known answer came from still, its content and that answer blanked");
  assert.deepEqual(Object.keys(check.check.fields), ["answer"], "no field is named from its grade's keys");
  assert.match(check.reason, /answer: 0 of 1 right against the grades' expected answers \(0\.0%, the bar 90\.0%\).*; 1 of 1 said what the agent said/, "its reason keeps its numbers, the grade's answer and the grader's words gone");
  assert.deepEqual([audit?.decided, audit?.audit.rows, audit?.audit.disagreements], ["hold", 1, [{ run: shadowRunId(gone), served: gone, input: "", agent: null, draft: null }]], `the audit's hold keeps its numbers and run ids: ${JSON.stringify(audit)}`);
  const turns = promotions.find((one) => one.digest === "d-turns")?.check.turns;
  assert.deepEqual([turns?.n, turns?.agreed, turns?.alone, turns?.of, turns?.disagreements], [1, 0, 1, [gone], [{ run: gone, input: "", agent: null, draft: "" }]], `the turns collected keep their numbers and run ids: ${JSON.stringify(turns)}`);
  // A next turn's write built on the turns read before the purge (sdkCheckTurn, racing it) keeps what the purge blanked.
  const next = { ...collecting, at: new Date().toISOString(), check: { ...collecting.check, turns: { ...collecting.check.turns, n: 2, alone: 2, agreed: 1, of: [kept.body.run_id, gone] } } };
  const written = await recordPromotion(store.settings, "calc", next, () => true);
  assert.deepEqual([written.won, written.record.check.turns.n, written.record.check.turns.disagreements], [true, 2, [{ run: gone, input: "", agent: null, draft: "" }]], `the copy read before the purge is written blanked: ${JSON.stringify(written.record)}`);
  assert.deepEqual(await inTables(place, word), [], "no table holds the sentinel again");
  // The sibling is untouched.
  const sibling = await api("GET", `/runs/${kept.body.run_id}/timeline`);
  assert.ok(JSON.stringify(sibling.body).includes("42"), "the sibling's timeline is kept");
});
