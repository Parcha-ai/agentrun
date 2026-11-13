// A write set to ask, on pi (the faux model): a "Saved <path>" row says a file was written, so a call that parked shows
// none while it waits, and none after a deny (no file was written). An allowed write is shown by the resume row, and its
// file is in the run's work folder. The note a person typed with a Deny shows on the Timeline once, on the resume row's
// summary, redacted whole with the run's redactor, then cut.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, call, cookieOf, follow, runDir, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const json = { "content-type": "application/json" };
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const HELD = ["not-a-secret", "saved-held-key", randomBytes(6).toString("hex")].join("-");
const holdsPiece = (text, secret) => [...Array(Math.max(0, secret.length - 7)).keys()].some((i) => text.includes(secret.slice(i, i + 8)));
const savedRows = (rows) => rows.filter((r) => /^Saved /.test(r.summary ?? ""));
/** The rows the server and the Timeline write, never the model's own words (pi's faux model echoes what it read). */
const serverRows = (rows) => rows.filter((r) => r.kind !== "final_answer" && r.kind !== "text_block");

/** The owner's password session on `server`: an answer to an approval, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

/** One run of agent `id`, which writes hello.txt once, parked for its approval: its pending approval and its rows. */
async function parkedWrite(api, id) {
  const ask = "Write hello.txt once.";
  assert.equal((await api("POST", "/agents", agent(id, { harness: "pi", instructions: ask, tools: ["write"] }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([view.pending?.kind, view.pending?.tool], ["approval", "write"], `${id}: parked on its write`);
  return { runId: run.body.run_id, approval: view.pending.id, rows };
}

test("a parked write shows no Saved row while it waits, none after a deny (and no file), and an allowed one is the resume row with its file written; a Deny's note shows once on the resume row, redacted whole then cut", { timeout: 150_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: HELD });
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { write: { permission: "ask" } })).status, 200);
  const NOTE = "use scratch instead";
  // A held key straddling the summary's cut of the note (200 characters): redacted whole first, no piece of it is left.
  const KEYED = `use scratch instead, never ${"x".repeat(165)}${HELD}\nand a second line`;
  // A link's query is scrubbed on the summary as on the row's text (scrubUrls): its values never show.
  const LINKED = "use scratch instead, see https://files.example/doc?sig=s3cr3tQueryValue&id=7";
  // The cut is by code points: an emoji straddling it is kept whole or dropped, never halved.
  const ASTRAL = `${"a".repeat(198)}😀bbb`;
  // A note sent with an Allow goes nowhere, as on main: not on the resume row, not in the message the model reads.
  const ALLOW_NOTE = "only the home page";
  const runs = await Promise.all([["allow"], ["deny", NOTE], ["deny", KEYED], ["deny", LINKED], ["deny", ASTRAL], ["allow", ALLOW_NOTE]].map(async ([decision, note], i) => ({ decision, note, ...(await parkedWrite(api, `saved-${i}`)) })));
  for (const run of runs) {
    assert.deepEqual(savedRows(run.rows).map((r) => r.summary), [], `${run.decision}: no Saved row while the write waits for its approval`);
    assert.equal(existsSync(join(runDir(server.data, run.runId), "work", "hello.txt")), false, `${run.decision}: nothing was written while it waits`);
  }
  for (const run of runs) assert.equal(await answer(run.runId, run.approval, run.note === undefined ? { decision: run.decision } : { decision: run.decision, note: run.note }), 204);
  for (const run of runs) {
    const { rows } = await follow(api, run.runId, ["completed"], { deadlineMs: 55_000 });
    const at = `${run.decision}${run.note === KEYED ? " (keyed note)" : run.note === LINKED ? " (linked note)" : run.note === ASTRAL ? " (astral note)" : run.note === ALLOW_NOTE ? " (with a note)" : ""}`;
    const file = join(runDir(server.data, run.runId), "work", "hello.txt");
    const resume = rows.filter((r) => r.origin === "server" && /^AgentRun: (write |You declined write)/.test(r.summary ?? ""));
    assert.equal(resume.length, 1, `${at}: one resume row: ${JSON.stringify(rows.map((r) => r.summary))}`);
    if (run.decision === "allow") {
      assert.equal(resume[0].summary, "AgentRun: write ran once you allowed it; its result went to the agent", at);
      if (run.note) {
        assert.equal(JSON.stringify(serverRows(rows)).includes(run.note), false, `${at}: the allow's note is on no row`);
        assert.equal((rows.findLast((r) => r.kind === "final_answer")?.text ?? "").includes(run.note), false, `${at}: the model never read the allow's note`);
      }
      assert.equal(await readFile(file, "utf8"), "hello", `${at}: the file was written`);
      assert.deepEqual(savedRows(rows).map((r) => r.summary), [], `${at}: the parked call's own Saved row is gone; the resume row says it ran`);
      continue;
    }
    assert.equal(existsSync(file), false, `${at}: no file`);
    assert.deepEqual(savedRows(rows).map((r) => r.summary), [], `${at}: no Saved row after a deny`);
    const shown = serverRows(rows);
    if (run.note === NOTE) {
      assert.equal(resume[0].summary, "AgentRun: You declined write: use scratch instead", at);
      assert.equal(shown.filter((r) => String(r.summary ?? "").includes(NOTE)).length, 1, `${at}: the note on one row's summary: ${JSON.stringify(shown.map((r) => r.summary))}`);
      assert.deepEqual(shown.filter((r) => `${r.summary ?? ""}\n${r.text ?? ""}`.includes(NOTE)).map((r) => r.id), [resume[0].id], `${at}: on the resume row alone`);
    } else if (run.note === LINKED) {
      assert.match(resume[0].summary, /^AgentRun: You declined write: use scratch instead, see https:\/\/files\.example\/doc\?sig=/, at);
      assert.equal(JSON.stringify(shown).includes("s3cr3tQueryValue"), false, `${at}: the link's query value shows on no row: ${resume[0].summary}`);
    } else if (run.note === ASTRAL) {
      assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(resume[0].summary), false, `${at}: no half of a surrogate pair: ${JSON.stringify(resume[0].summary.slice(-4))}`);
      assert.ok(resume[0].summary.endsWith("…"), `${at}: cut`);
    } else {
      assert.match(resume[0].summary, /^AgentRun: You declined write: use scratch instead, never /, at);
      assert.equal(resume[0].summary.includes("second line"), false, `${at}: its first line only`);
      assert.ok(resume[0].summary.length <= "AgentRun: You declined write: ".length + 200, `${at}: cut: ${resume[0].summary.length}`);
      assert.equal(holdsPiece(JSON.stringify(shown), HELD), false, `${at}: no 8 characters of the held key on any row: ${resume[0].summary}`);
    }
  }
});
