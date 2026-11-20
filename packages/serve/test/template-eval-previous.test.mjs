// A template eval case's previous runs (template-eval.ts `previous:`, eval-previous.ts): the case names earlier completed
// results of the package's schedule trigger, each seeded in the eval's own server's store as a completed run of the run's
// agent, that trigger's firing, its output checked against its own output_schema (else the package's). The case's run is
// then the trigger's own firing on the eval's clock, so it is handed what previousResultOf hands a scheduled run
// (trigger-targets.ts): the last result whole up to 32 KiB, else the fields its run's schema names in x-carried, the first
// entries of the largest carried array dropped to fit, else nothing, said so. What the run was handed is on its record
// (`handed_previous`), which a `handed` grader reads. The package's agent is played by test/fixtures/faux-template-eval.mjs,
// which answers with its input after "Answer:", so a run's answer shows what it was handed after its message.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CaseError, evalTemplate, readCases } from "../dist/template-eval.js";
import { PREVIOUS_RESULT_MAX_BYTES, previousResultTooLarge, previousResultWords } from "../dist/trigger-targets.js";
import { asOwner, scratch, serve } from "./support.mjs";
import { ADDRESS, mailbox, saved } from "./email-support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;

/** The package's output schema: a digest's `items` (what its next run reads back, carried) and a `summary`. */
const DIGEST = { type: "object", "x-carried": ["items"], required: ["items"], properties: { items: { type: "array", items: { type: "string" } }, summary: { type: "string" } } };

/** A package whose one trigger is a weekly schedule, its run's answer DIGEST-RUN and what it was handed after it (the
 *  faux answers with its input after "Answer:"); its cases each a previous fixture, with graders as given. */
async function digestPackage(t, cases, { source = '{ kind: schedule, cron: "0 9 * * 1", timezone: UTC }' } = {}) {
  const dir = join(await scratch(t), "digestpkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "digest.schema.json"), JSON.stringify(DIGEST, null, 1));
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: digestpkg",
    "version: 0.1.0",
    "description: A weekly digest that leaves out what its last run reported.",
    "harness: [pi]",
    "tools: [read]",
    "budget: { per_run_usd: 0.5 }",
    "output: { schema: digest.schema.json }",
    "triggers:",
    "  - name: Weekly",
    `    source: ${source}`,
    "    target:",
    "      kind: start_run",
    "      input:",
    "        content: |",
    "          Answer:",
    "          DIGEST-RUN",
    "---",
    "You write a weekly digest.",
    "",
  ].join("\n"));
  for (const [name, { fixture, graders = { "whole.md": handedGrader("whole") }, yaml = "" }] of Object.entries(cases)) {
    const at = join(dir, "evals", name);
    mkdirSync(join(at, "graders"), { recursive: true });
    mkdirSync(join(at, "fixtures"), { recursive: true });
    writeFileSync(join(at, "case.yaml"), `previous: fixtures/previous.json\n${yaml}`);
    writeFileSync(join(at, "prompt.md"), `---\ndescription: ${fixture.description ?? name}\n---\n`);
    writeFileSync(join(at, "fixtures", "previous.json"), JSON.stringify(fixture, null, 1));
    for (const [file, text] of Object.entries(graders)) writeFileSync(join(at, "graders", file), text);
  }
  return dir;
}

/** `n` listing URLs, each the same length, so how many must go from the front to fit is plain arithmetic. */
const listings = (n) => Array.from({ length: n }, (_, i) => `https://jobs.example.com/listing/${String(i).padStart(4, "0")}-${"x".repeat(60)}`);
/** The fewest first entries of `items` dropped for `{items}` to fit in PREVIOUS_RESULT_MAX_BYTES as it is handed. */
const toDrop = (items) => {
  let n = 0;
  while (Buffer.byteLength(JSON.stringify({ items: items.slice(n) }, null, 2)) > PREVIOUS_RESULT_MAX_BYTES) n++;
  return n;
};

const BIG = listings(500);
const DROPPED = toDrop(BIG);
/** A summary past the limit alone: a scalar, never cut. Words, not one run of letters a run's cut takes for a key. */
const LONG_SUMMARY = "word ".repeat(7 * 1024).trim();

const handedGrader = (expect, dropped) => `---\ntype: handed\nexpect: ${expect}${dropped ? `\ndropped: ${JSON.stringify(dropped)}` : ""}\n---\n`;
const verdictOf = (run, file) => run.graders.find((g) => g.grader === file);

test("a previous case's run is handed its trigger's seeded last result: whole after its message, as its carried array trimmed with the count named, or nothing, said so", { timeout: 600_000 }, async (t) => {
  assert.ok(DROPPED > 0 && Buffer.byteLength(JSON.stringify({ items: BIG }, null, 2)) > PREVIOUS_RESULT_MAX_BYTES, "the big result is over the limit by its carried array alone");
  const dir = await digestPackage(t, {
    // (a) Two earlier results, the newer one small: handed whole, after the run's message; the older one never.
    small: {
      fixture: { description: "Last week's digest is handed whole.", results: [{ output: { items: ["https://jobs.example.com/old"] } }, { output: { items: ["https://jobs.example.com/1", "https://jobs.example.com/2"], summary: "two listings" } }] },
      graders: { "whole.md": handedGrader("whole"), "carried.md": handedGrader("carried") },
    },
    // (b) Over the limit, its schema carrying items: only items, its first entries dropped to fit, the count named.
    big: {
      fixture: { results: [{ output: { items: BIG, summary: "five hundred listings" } }] },
      graders: { "trimmed.md": handedGrader("carried", { items: DROPPED }), "miscounted.md": handedGrader("carried", { items: DROPPED + 1 }), "misspelled.md": handedGrader("carried", { itmes: 0 }) },
    },
    // (c) Its own run's schema carries summary alone, a scalar still over: nothing is handed, said so. The package's
    // schema (carrying items, which would fit) is not the one read: the producing run's revision's is.
    scalar: {
      fixture: { results: [{ output: { items: ["https://jobs.example.com/1"], summary: LONG_SUMMARY }, output_schema: { ...DIGEST, "x-carried": ["summary"] } }] },
      graders: { "refused.md": handedGrader("too_large"), "whole.md": handedGrader("whole") },
    },
  });
  const report = await evalTemplate({ dir, serve: { faux: FAUX } });
  const run = (name) => {
    const c = report.cases.find((one) => one.name === name);
    assert.equal(c.runs.length, 1, JSON.stringify(c, null, 1).slice(0, 2000));
    assert.equal(c.runs[0].status, "completed", JSON.stringify(c.runs[0], null, 1).slice(0, 2000));
    return c.runs[0];
  };

  const small = run("small");
  const handed = small.handed_previous;
  assert.equal(handed.kind, "whole", JSON.stringify(handed));
  // The server's own words, its run's id and end as the server read them back from the seeded run.
  const ended = /, ended ([^)]+)\)/.exec(handed.text)?.[1];
  assert.ok(ended && !Number.isNaN(Date.parse(ended)), handed.text.slice(0, 300));
  assert.equal(handed.text, previousResultWords(handed.run_id, ended, JSON.stringify({ items: ["https://jobs.example.com/1", "https://jobs.example.com/2"], summary: "two listings" }, null, 2)));
  assert.ok(!small.answer.includes("https://jobs.example.com/old"), "only the last completed result is handed, never an older one");
  // The answer is the run's input after "Answer:": its message, the schedule's line, then what it was handed.
  assert.ok(small.answer.startsWith("DIGEST-RUN\n"), small.answer.slice(0, 300));
  assert.ok(small.answer.indexOf(handed.text) > small.answer.indexOf("(Started by the schedule \"Weekly\""), "handed after the trigger's message and its line");
  assert.deepEqual([verdictOf(small, "whole.md").pass, verdictOf(small, "carried.md").pass], [true, false], JSON.stringify(small.graders));

  const big = run("big");
  assert.equal(big.handed_previous.kind, "carried", JSON.stringify(big.handed_previous).slice(0, 500));
  assert.deepEqual(big.handed_previous.fields, ["items"]);
  assert.deepEqual(big.handed_previous.dropped, { items: DROPPED });
  assert.ok(big.handed_previous.text.includes(`(items: the first ${DROPPED} entries dropped)`), big.handed_previous.text.slice(0, 600));
  assert.ok(big.handed_previous.text.endsWith(`\`\`\`json\n${JSON.stringify({ items: BIG.slice(DROPPED) }, null, 2)}\n\`\`\``), "the rest handed in their order, nothing of summary");
  assert.deepEqual([verdictOf(big, "trimmed.md").pass, verdictOf(big, "miscounted.md").pass], [true, false], JSON.stringify(big.graders));
  // A misspelled field is no carried array the run was handed: it fails by name, never read as 0 dropped.
  assert.equal(verdictOf(big, "misspelled.md").pass, false, JSON.stringify(big.graders));
  assert.match(verdictOf(big, "misspelled.md").reason, /the grader counts itmes, which is no carried array it was handed \(items\)$/, verdictOf(big, "misspelled.md").reason);
  assert.match(verdictOf(big, "miscounted.md").reason, new RegExp(`items: the first ${DROPPED} entries dropped; the grader expects items: the first ${DROPPED + 1} dropped$`), verdictOf(big, "miscounted.md").reason);

  const scalar = run("scalar");
  assert.equal(scalar.handed_previous.kind, "too_large", JSON.stringify(scalar.handed_previous).slice(0, 500));
  assert.equal(scalar.handed_previous.text, previousResultTooLarge(scalar.handed_previous.run_id));
  assert.ok(!scalar.answer.includes("https://jobs.example.com/1"), "nothing of the result, its items neither: the run's own schema carries summary alone");
  assert.deepEqual([verdictOf(scalar, "refused.md").pass, verdictOf(scalar, "whole.md").pass], [true, false], JSON.stringify(scalar.graders));
});

test("a previous case checks when it is read: its fixture's shape and each output against its schema, a schedule to start from, no prompt of its own, and only on the eval's own server", async (t) => {
  const problems = (dir) => {
    try {
      readCases(dir);
      return [];
    } catch (error) {
      assert.ok(error instanceof CaseError, String(error));
      return error.problems;
    }
  };
  const SMALL = { results: [{ output: { items: ["https://jobs.example.com/1"] } }] };
  const good = await digestPackage(t, { small: { fixture: SMALL, graders: { "whole.md": handedGrader("whole") } } });
  assert.deepEqual(problems(good), []);
  const [one] = readCases(good).cases;
  assert.equal(one.previous.trigger, "Weekly");
  assert.deepEqual(one.previous.results, [{ output: { items: ["https://jobs.example.com/1"] } }]);

  const bad = await digestPackage(t, {
    empty: { fixture: { results: [] } },
    extra: { fixture: { ...SMALL, when: "yesterday" } },
    shape: { fixture: { results: [{ output: ["https://jobs.example.com/1"] }] } },
    misses: { fixture: { results: [{ output: { items: "https://jobs.example.com/1" } }] } },
    carries: { fixture: { results: [{ output: { items: [] }, output_schema: { ...DIGEST, "x-carried": ["seen"] } }] } },
    lost: { fixture: { ...SMALL, trigger: "Nightly" } },
    graded: { fixture: SMALL, graders: { "handed.md": handedGrader("partly") } },
    said: { fixture: SMALL },
  });
  writeFileSync(join(bad, "evals", "said", "prompt.md"), "---\ndescription: A prompt of its own.\n---\nRead it.\n");
  const said = problems(bad);
  const has = (re) => assert.ok(said.some((p) => re.test(p)), `${re}\n${said.join("\n")}`);
  has(/empty\/fixtures\/previous\.json: results is the trigger's earlier completed runs, oldest first, at least one/);
  has(/extra\/fixtures\/previous\.json: no field when: its fields are description, results, trigger/);
  has(/shape\/fixtures\/previous\.json: results\[0\]\.output is the run's result\.output, a JSON object/);
  has(/misses\/fixtures\/previous\.json: results\[0\]\.output does not meet the package's output schema: \/items must be array/);
  has(/carries\/fixtures\/previous\.json: results\[0\]\.output_schema's x-carried names "seen", which the root's properties have no field for/);
  has(/lost\/fixtures\/previous\.json: trigger Nightly is not one of the package's triggers \(Weekly\)/);
  has(/graded\/graders\/handed\.md: expect is whole, carried, too_large or none/);
  has(/said\/prompt\.md: a previous case's run is started by the package's schedule trigger, on the trigger's input and cap/);

  // A handed grader reads what a previous case's run was handed: on any other case it is refused.
  const plain = join(good, "evals", "plain");
  mkdirSync(join(plain, "graders"), { recursive: true });
  writeFileSync(join(plain, "prompt.md"), "---\ndescription: An ordinary run.\n---\nAnswer:\nok\n");
  writeFileSync(join(plain, "graders", "handed.md"), handedGrader("whole"));
  assert.ok(problems(good).some((p) => /plain\/graders\/handed\.md: a handed grader reads what a previous case's run was handed, and the case has no previous/.test(p)), problems(good).join("\n"));

  const unscheduled = await digestPackage(t, { small: { fixture: SMALL } }, { source: '{ kind: webhook }' });
  assert.ok(problems(unscheduled).some((p) => /small\/fixtures\/previous\.json: a previous case starts its run through the package's schedule trigger, and the package has none/.test(p)), problems(unscheduled).join("\n"));

  await assert.rejects(evalTemplate({ dir: good, cases: ["small"], server: { baseUrl: "http://127.0.0.1:9", token: "x" } }), (error) => error instanceof CaseError && error.problems.some((p) => /evals\/small: previous seeds the case's earlier runs in the server's store on the eval's own server alone: run it without --server/.test(p)));
});

test("a previous case on an owner's folder whose server keeps an email account runs: it saves no mailbox, so the account is no reason to refuse it, and it stays", { timeout: 600_000 }, async (t) => {
  const faux = await mailbox(t);
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data });
  await saved(asOwner(first), faux);
  await first.stop();
  const dir = await digestPackage(t, { small: { fixture: { results: [{ output: { items: ["https://jobs.example.com/1"], summary: "one listing" } }] } } });
  const report = await evalTemplate({ dir, data, serve: { faux: FAUX } });
  assert.equal(report.cases[0].runs[0]?.status, "completed", JSON.stringify(report.cases[0], null, 1).slice(0, 2000));
  assert.equal(report.cases[0].runs[0].handed_previous.kind, "whole", JSON.stringify(report.cases[0].runs[0].handed_previous));
  const again = await serve(t, { data });
  const account = await asOwner(again)("GET", "/settings/email");
  assert.equal(account.body.address, ADDRESS, JSON.stringify(account.body));
});
