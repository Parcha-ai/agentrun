// A template eval case's fake feed (template-eval.ts `feed:`, eval-feed.ts): each run gets a fake feed of its own, served
// from the case's fixture on loopback, read in place of the first URL the package's feed trigger names (its other URLs
// read an empty feed of the same format), so no run reads a real feed. The package is applied, the trigger's first poll
// takes its start on the fixture's items, the fixture's new or updated `item` is added, and the trigger's next poll fires
// on it: the run is its firing's. The package's agent is played by test/fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CaseError, evalTemplate, readCases } from "../dist/template-eval.js";
import { scratch } from "./support.mjs";
import { incident, pull } from "./feed-support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));

const STATUS = ["https://www.githubstatus.com/history.atom", "https://status.openai.com/history.atom"];
/** A package whose one trigger is a feed (its `source` YAML), its run's answer FEED-RUN; its cases as given. */
async function feedPackage(t, cases, { source = `{ kind: feed, urls: ${JSON.stringify(STATUS)}, every_s: 900 }`, parameters = "" } = {}) {
  const dir = join(await scratch(t), "feedpkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: feedpkg",
    "version: 0.1.0",
    "description: Says what each new or updated feed item is about.",
    "harness: [pi]",
    "tools: [read]",
    "budget: { per_run_usd: 0.5 }",
    ...(parameters ? [parameters] : []),
    "triggers:",
    "  - name: New item",
    `    source: ${source}`,
    "    target:",
    "      kind: start_run",
    "      input:",
    "        content: |",
    "          Answer:",
    "          FEED-RUN",
    "---",
    "You say what each feed item is about.",
    "",
  ].join("\n"));
  for (const [name, { fixture, graders = { "judged.md": "---\ntype: llm\n---\nPass if the answer contains \"FEED-RUN\".\n" }, yaml = "" }] of Object.entries(cases)) {
    const at = join(dir, "evals", name);
    mkdirSync(join(at, "graders"), { recursive: true });
    mkdirSync(join(at, "fixtures"), { recursive: true });
    writeFileSync(join(at, "case.yaml"), `feed: fixtures/feed.json\n${yaml}`);
    writeFileSync(join(at, "prompt.md"), `---\ndescription: ${fixture.description}\n---\n`);
    writeFileSync(join(at, "fixtures", "feed.json"), JSON.stringify(fixture, null, 1));
    for (const [file, text] of Object.entries(graders)) writeFileSync(join(at, "graders", file), text);
  }
  return dir;
}

const OPENED = incident(3, "Degraded Actions", "2026-11-14T08:00:00Z", "2026-11-14T08:00:00Z");
const UPDATED_CASE = {
  fixture: {
    description: "An open incident on GitHub's status page gets a status post.",
    format: "atom",
    title: "GitHub Status - Incident History",
    items: [OPENED, incident(2, "Old outage", "2026-11-01T10:00:00Z")],
    item: { ...OPENED, updated: "2026-11-14T09:30:00Z", content: "<p><strong>Resolved</strong> - This incident has been resolved.</p>" },
  },
};

test("a feed case's run is its trigger's on a fake feed: the start taken on the fixture's items, the updated incident fired with update: true, the trigger's own URL in the payload", { timeout: 600_000 }, async (t) => {
  const dir = await feedPackage(t, { updated: UPDATED_CASE });
  const report = await evalTemplate({ dir, cases: ["updated"], serve: { faux: FAUX } });
  const [c] = report.cases;
  assert.equal(c.runs.length, 1, JSON.stringify(c, null, 1));
  const [run] = c.runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.match(run.answer, /FEED-RUN/);
  assert.equal(c.pass, true, JSON.stringify(c, null, 1));
  const [input] = graderInputs().filter((one) => one.includes("<trigger-payload source=\"feed\""));
  assert.ok(input, "the grader saw the run's input, the feed's payload in it");
  assert.match(input, /"title":"Degraded Actions"/);
  assert.match(input, /"update":true/);
  assert.match(input, /"summary":"Resolved - This incident has been resolved\."/);
  assert.ok(input.includes(`"url":"${STATUS[0]}"`), "the payload names the trigger's URL, never the fake's");
});

test("a feed case on a JSON list (pr-alert's pulls, its url filled from the case's parameters) fires on the new pull request alone", { timeout: 600_000 }, async (t) => {
  const source = `{ kind: feed, urls: ["https://api.github.com/repos/\${parameters.owner}/\${parameters.repo}/pulls?state=open&sort=created&direction=desc"], every_s: 14400 }`;
  const parameters = 'parameters:\n  owner: { type: string, description: "the owner" }\n  repo: { type: string, description: "the repository" }';
  const dir = await feedPackage(t, {
    pr: { fixture: { description: "A new pull request on acme/web.", format: "json-list", items: [pull(2, "Two"), pull(1, "One")], item: pull(3, "Add a feed trigger", "2026-11-14T08:00:00Z") }, yaml: "parameters: { owner: acme, repo: web }\n" },
  }, { source, parameters });
  const report = await evalTemplate({ dir, cases: ["pr"], serve: { faux: FAUX } });
  const [c] = report.cases;
  assert.deepEqual(c.runs.map((r) => r.status), ["completed"], JSON.stringify(c, null, 1));
  const input = graderInputs().filter((one) => one.includes("<trigger-payload source=\"feed\"")).at(-1);
  assert.match(input, /"title":"Add a feed trigger"/);
  assert.match(input, /"link":"https:\/\/github\.com\/acme\/web\/pull\/3"/);
});

test("a feed case checks when it is read: its fixture, a feed trigger to start from, no prompt of its own, and only on the eval's own server", async (t) => {
  const problems = (dir) => {
    try {
      readCases(dir);
      return [];
    } catch (error) {
      assert.ok(error instanceof CaseError, String(error));
      return error.problems;
    }
  };
  const good = await feedPackage(t, { updated: UPDATED_CASE });
  assert.deepEqual(problems(good), []);
  const [one] = readCases(good).cases;
  assert.equal(one.feed.trigger, "New item");
  assert.equal(one.feed.format, "atom");

  const bad = await feedPackage(t, {
    format: { fixture: { ...UPDATED_CASE.fixture, format: "csv" } },
    itemless: { fixture: { ...UPDATED_CASE.fixture, item: undefined } },
    lost: { fixture: { ...UPDATED_CASE.fixture, trigger: "Nightly" } },
    said: UPDATED_CASE,
  });
  writeFileSync(join(bad, "evals", "said", "prompt.md"), "---\ndescription: A prompt of its own.\n---\nRead it.\n");
  const said = problems(bad);
  assert.ok(said.some((p) => /format\/fixtures\/feed\.json: format is rss, atom, json-feed or json-list/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /itemless\/fixtures\/feed\.json: item is the new or updated item/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /lost\/fixtures\/feed\.json: trigger Nightly is not one of the package's triggers \(New item\)/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /said\/prompt\.md: a feed case's run is started by the package's trigger/.test(p)), said.join("\n"));

  const scheduled = await feedPackage(t, { updated: UPDATED_CASE }, { source: '{ kind: schedule, cron: "0 9 * * *", timezone: UTC }' });
  assert.ok(problems(scheduled).some((p) => /updated\/fixtures\/feed\.json: a feed case starts its run through the package's feed trigger, and the package has none/.test(p)), problems(scheduled).join("\n"));

  await assert.rejects(evalTemplate({ dir: good, server: { baseUrl: "http://127.0.0.1:9", token: "x" } }), (error) => error instanceof CaseError && error.problems.some((p) => /evals\/updated: feed fakes the package's feeds on the eval's own server alone: run it without --server/.test(p)));
});
