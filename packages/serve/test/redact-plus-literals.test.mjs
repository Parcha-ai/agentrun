// A held value that holds a "+" (a key's body line, base64), which a run prints as code that builds it from string
// literals joined by "+": `"<first 31>" + "<rest>"`, or 16 characters a line. On beta.61 such an answer was served with
// the value readable in it, joined, on the run's view (result.final_answer), its Timeline, the Timeline's event stream
// and the run's export, and an eval's grader read it so. Each now serves "[redacted]" in its place, and the grader's
// prompt holds "[redacted]" where the answer stands.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evalTemplate } from "../dist/template-eval.js";
import { PLUS_KEY } from "./fixtures/faux-model.mjs";
import { agent, call, follow, scratch, serve, withEnv } from "./support.mjs";

assert.ok(PLUS_KEY.length === 64 && PLUS_KEY[31] === "+" && PLUS_KEY[55] === "+", PLUS_KEY);
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"];
/** Every 12 characters of the held value: no piece of it, a chunk the answer printed or a half, shows. */
const PIECES = Array.from({ length: PLUS_KEY.length - 11 }, (_, i) => PLUS_KEY.slice(i, i + 12));
const shown = (text) => PIECES.filter((piece) => text.includes(piece));

// The eval's faux writes each input its grader is given to this file (fixtures/faux-template-eval.mjs).
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");

test("an answer printing a saved key that holds \"+\" as string literals joined by \"+\": the run's view, its Timeline, the Timeline's event stream and its export serve \"[redacted]\", no piece of the key", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: `not-a-secret-${"plus-model-0123456789"}`, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, NAMES);
  const s = await serve(t);
  assert.equal((await s.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: PLUS_KEY } })).status, 204, "the key is saved");
  assert.equal((await s.api("POST", "/agents", agent("plus"))).status, 201);
  for (const how of ["in lines", "in halves"]) {
    const started = await s.api("POST", "/agents/plus/runs", { input: { content: `Answer printing the plus key ${how}.` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    // The Timeline's live pages, followed to the run's end, as the console reads them.
    const { rows } = await follow(s.api, runId, ["completed"], { deadlineMs: 60_000 });
    assert.deepEqual(shown(JSON.stringify(rows)), [], `${how}: the Timeline's live pages`);
    assert.equal(rows.findLast((row) => row.kind === "final_answer")?.text, "[redacted]", `${how}: the live answer row`);

    const view = (await s.api("GET", `/runs/${runId}`)).body;
    assert.deepEqual(shown(JSON.stringify(view)), [], `${how}: the run's view`);
    assert.equal(view.result.final_answer, "[redacted]", `${how}: the run's answer`);

    const page = (await s.api("GET", `/runs/${runId}/timeline`)).body;
    assert.deepEqual(shown(JSON.stringify(page)), [], `${how}: the Timeline`);
    assert.equal(page.rows.findLast((row) => row.kind === "final_answer")?.text, "[redacted]", `${how}: the Timeline's answer row`);

    // The event stream of an ended run: its rows, then its end.
    const stream = await call(s.port, { path: `/v2/runs/${runId}/timeline`, headers: { authorization: `Bearer ${s.token}`, accept: "text/event-stream" } });
    assert.equal(stream.status, 200, stream.text.slice(0, 200));
    assert.match(stream.text, /event: end/, `${how}: the stream ends`);
    assert.deepEqual(shown(stream.text), [], `${how}: the event stream`);
    assert.ok(stream.text.includes('"text":"[redacted]"'), `${how}: the stream's answer row: ${stream.text.slice(0, 400)}`);

    const exported = await call(s.port, { path: `/v2/runs/${runId}/export`, headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(exported.status, 200, exported.text.slice(0, 400));
    assert.deepEqual(shown(exported.text), [], `${how}: the export`);
    assert.ok(exported.text.includes("[redacted]"), `${how}: the export's answer`);
  }
});

test("an eval's llm grader reading a run that printed a held key holding \"+\" as string literals joined by \"+\" is given \"[redacted]\" as its answer, no piece of the key", { timeout: 300_000 }, async (t) => {
  // Held by the eval's server (a variable named as a key); the faux prints the halves from the environment, so the run's
  // input, which the grader is given as its task, never holds them.
  withEnv(t, { PLUSTEST_API_KEY: PLUS_KEY, PLUSTEST_HEAD: PLUS_KEY.slice(0, 31), PLUSTEST_REST: PLUS_KEY.slice(31) });
  const dir = join(await scratch(t), "evalpkg");
  cpSync(new URL("./fixtures/templates-eval/evalpkg/", import.meta.url).pathname, dir, { recursive: true });
  const at = join(dir, "evals", "plus-literals");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\n");
  writeFileSync(join(at, "prompt.md"), '---\ndescription: Prints a held key as string literals joined by "+".\n---\nAnswer:\nPLUS-LITERALS const body = "{{env:PLUSTEST_HEAD}}" + "{{env:PLUSTEST_REST}}";\n\n```json\n{"verdict": "good", "score": 50, "summary": "plus-literals"}\n```\n');
  writeFileSync(join(at, "graders", "redacted.md"), '---\ntype: llm\n---\nPass if the answer contains "[redacted]".\nThe run printed a body.\n');
  const report = await evalTemplate({ dir, cases: ["plus-literals"], serve: { faux: new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  const prompts = readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((input) => input.includes("The run printed a body."));
  assert.equal(prompts.length, 1, "the grader ran once");
  const [prompt] = prompts;
  assert.deepEqual(shown(prompt), [], `the grader's prompt: ${prompt}`);
  const answer = prompt.slice(prompt.indexOf("<answer untrusted>"), prompt.indexOf("</answer>"));
  assert.ok(answer.includes("[redacted]"), `the grader's answer: ${answer}`);
  assert.deepEqual(shown(JSON.stringify(report)), [], "the report");
  assert.equal(run.graders.find((g) => g.grader === "redacted.md")?.pass, true, JSON.stringify(run.graders));
});
