// GET /v2/runs/{run_id}/output: the run's output as its profile pack pinned it, its type, and its file in the run's
// workspace with that file's address under /files, or null for both when the output is the run's final answer. It reads
// nothing on disk: the files routes say whether the file is there. A run with no profile, or a profile with no output,
// is 404 saying which. During the run, after it, and archived. Faux harness.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const md = (name) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo ${name}.\n`;
const SKILLS = { "effort-x/SKILL.md": md("effort-x"), "writer-x/SKILL.md": md("writer-x") };
/** A pack whose `note` output writes note.txt, `report` report.md, and `answer` no file. */
const PACK = {
  version: 1, name: "inline",
  effort: { low: { skills: ["effort-x"] }, medium: { skills: ["effort-x"] }, high: { skills: ["effort-x"] } },
  outputs: { note: { skills: ["writer-x"], file: "note.txt" }, report: { skills: ["writer-x"], file: "report.md" }, answer: { skills: [] } },
};

async function setup(t) {
  const served = await serve(t, { fauxHarness: FAUX_HARNESS });
  const doc = await (await fetch(`${served.baseUrl}/openapi.json`)).json();
  for (const [id, instructions, tools] of [["writes", "Write then read.", ["read", "write"]], ["chats", "Answer.", []]]) {
    const made = await served.api("POST", "/agents", { ...agent(id, { harness: "claude-agent", instructions, skills: ["effort-x", "writer-x"], tools }), skills: SKILLS });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  /** Start a run of `agentId` with `extra` in its body; the run's id. */
  const start = async (agentId, extra) => {
    const run = await served.api("POST", `/agents/${agentId}/runs`, { input: { content: "hi" }, ...extra });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    return run.body.run_id;
  };
  /** GET .../output, checked against the served document's answer for its status. */
  const output = async (runId) => {
    const answer = await served.api("GET", `/runs/${runId}/output`);
    let response = doc.paths["/runs/{run_id}/output"].get.responses[String(answer.status)];
    // An error answer is one of the contract's own responses, by reference.
    if (response.$ref) response = response.$ref.replace(/^#\//, "").split("/").reduce((node, key) => node[key], doc);
    const schema = response.content["application/json"].schema;
    assert.deepEqual(schemaProblems(doc, schema, answer.body), [], JSON.stringify(answer.body));
    return answer;
  };
  return { ...served, start, output };
}

test("an output with a file: its path and its address, the same before it is written and after; the address reads it once it is there", { timeout: 90_000 }, async (t) => {
  const { api, data, start, output } = await setup(t);
  // A run whose agent writes no file: its output is named while it runs and after, and its address finds nothing.
  const quiet = await start("chats", { profile: PACK, output: "report" });
  for (const when of ["during", "after"]) {
    if (when === "after") await follow(api, quiet, ["completed"], { deadlineMs: 55_000 });
    const answer = await output(quiet);
    assert.equal(answer.status, 200, when);
    assert.deepEqual(answer.body, { run_id: quiet, type: "report", path: "report.md", url: `/v2/runs/${quiet}/files/report.md` }, when);
  }
  assert.equal((await api("GET", `/runs/${quiet}/files/report.md`)).status, 404, "not written: the files route says so");
  // A run whose agent writes note.txt (the faux harness's write tool): its address reads it.
  const wrote = await start("writes", { profile: PACK, output: "note" });
  await follow(api, wrote, ["completed"], { deadlineMs: 55_000 });
  const text = await readFile(join(data, "runs", wrote, "work", "note.txt"), "utf8");
  const answer = await output(wrote);
  // Not HTML, so its url reads it in place, no download asked (an HTML output's url is one: pack-job.test.mjs).
  assert.deepEqual(answer.body, { run_id: wrote, type: "note", path: "note.txt", url: `/v2/runs/${wrote}/files/note.txt` });
  const file = await api("GET", answer.body.url.replace(/^\/v2/, ""));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-disposition"), null, "read in place");
  assert.equal(file.body, text, "the url reads the file");
  // Archived, it is still named.
  assert.equal((await api("POST", `/runs/${wrote}/archive`)).status, 200);
  assert.deepEqual((await output(wrote)).body, answer.body, "an archived run's output");
});

test("an output with no file has no path and no address: it is the run's final answer; a run with no profile, or a profile with no output, is 404 saying why", { timeout: 90_000 }, async (t) => {
  const { api, start, output } = await setup(t);
  const answered = await start("chats", { profile: PACK, output: "answer" });
  const answer = await output(answered);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { run_id: answered, type: "answer", path: null, url: null });
  const plain = await start("chats", {});
  const none = await output(plain);
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, "not_found");
  assert.match(none.body.error.message, /no profile/);
  const unasked = await start("chats", { profile: PACK });
  const noOutput = await output(unasked);
  assert.equal(noOutput.status, 404);
  assert.match(noOutput.body.error.message, /no output/);
  assert.equal((await api("GET", "/runs/no-such-run/output")).status, 404);
  for (const runId of [answered, plain, unasked]) await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
});

test("capabilities say this server names a run's output", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("GET", "/capabilities")).body.features.runs.output, true);
});
