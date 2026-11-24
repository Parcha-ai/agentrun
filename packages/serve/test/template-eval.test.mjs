// The template eval runner (template-eval.ts, `agentrun-serve eval-template`): a package's eval cases run as real runs of
// its agent on a server and graded by each case's graders. The fixture package (fixtures/templates-eval/evalpkg) has a
// case per behaviour, its agent and its grader played by fixtures/faux-template-eval.mjs: no key, no network. Every
// shipped package's cases are read and their fakes served here too, so a broken case fails CI, never the paid run.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";
import { CaseError, callsOf, evalTemplate, exitCodeOf, fakeAnswer, gradeDeterministic, graderInput, markdownReport, metricsOf, outputVerdict, readCases, searched, startFake, verdictOf } from "../dist/template-eval.js";
import { lastJsonBlock, structuredAnswer } from "../dist/answer-json.js";
import { MAX_EVAL_FILE_BYTES, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, PackageError, readPackage, readPackages, TEMPLATES_DIR } from "../dist/templates.js";
import { scratch, serve, withEnv } from "./support.mjs";
import { ran, started, within } from "./fixtures/started.mjs";
import { calls as fauxMonidCalls, KEY as FAUX_MONID_KEY } from "./fixtures/faux-monid.mjs";

const FIXTURES = new URL("./fixtures/templates-eval/", import.meta.url).pathname;
const PKG = join(FIXTURES, "evalpkg");
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

// The faux's state, in this file's process (each test file runs in a process of its own), which the runs' processes
// inherit: the flaky case's count, and every input a grader run was given.
const STATE = await scratch();
// The server's zone: a run's day is told in it (environment.ts), so the clock tests name a zone west of UTC.
process.env.TZ = "America/Los_Angeles";
process.env.AGENTRUN_TEST_EVAL_COUNTER =join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
/** Resolves once `path` exists, or `ended` settles (the process that would make it is gone): told by its folder's
 *  watch, never polled. The watch is set before the first look, so a file made in between is not missed. */
const untilFile = (path, ended) => new Promise((resolve) => {
  const done = () => (watcher.close(), resolve());
  const watcher = watch(dirname(path), (_, name) => name === basename(path) && existsSync(path) && done());
  if (existsSync(path)) done();
  ended.then(done, done);
});
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));

// One eval of every fixture case, on one in-process server, which the tests below read.
let all;
const eval_ = () => (all ??= evalTemplate({ dir: PKG, serve: { faux: FAUX } }));
const caseOf = async (name) => (await eval_()).cases.find((c) => c.name === name);
const graderOf = (run, file) => run.graders.find((g) => g.grader === file);

test("every shipped package's cases load, and each case's fake MCP servers serve their fixtures", { timeout: 120_000 }, async () => {
  const packages = readPackages(TEMPLATES_DIR);
  assert.deepEqual(packages.map((p) => p.name), ["agent-scout", "code-review", "inbound-lead", "kyb", "market-monitor", "release-notes"]);
  for (const p of packages) {
    const { cases } = readCases(join(TEMPLATES_DIR, p.name));
    assert.deepEqual(cases.map((c) => c.name), p.evals, `${p.name}: every case reads`);
    for (const one of cases) {
      assert.ok(one.input.length > 0 && one.graders.length > 0 && one.runs >= 1, `${p.name}/${one.name}`);
      // Each fake as the runner serves it, through the MCP client the server uses: it lists the fixture's tools, and a
      // call whose `when` carries the tool's required arguments gets that answer's result.
      for (const [name, fixture] of Object.entries(one.mcp)) {
        const fake = await startFake(name, fixture);
        const client = new Client({ name: "eval-test", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(fake.url)));
          const { tools } = await client.listTools();
          assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(fixture.tools).sort(), `${p.name}/${one.name}: ${name} lists its fixture's tools`);
          const made = [];
          for (const [tool, spec] of Object.entries(fixture.tools)) {
            const answer = spec.answers.find((a) => (spec.input.required ?? []).every((key) => Object.hasOwn(a.when, key)));
            if (!answer) continue;
            const result = await client.callTool({ name: tool, arguments: answer.when });
            assert.deepEqual(result.content, answer.result.content, `${p.name}/${one.name}: ${name}.${tool} answers from its fixture`);
            made.push({ tool: `mcp:${name}/${tool}`, arguments: answer.when });
          }
          assert.deepEqual(fake.calls, made, "each call is recorded, with its arguments");
        } finally {
          await client.close().catch(() => undefined);
          await fake.close();
        }
      }
    }
  }
});

test("a case that does not check fails before anything runs, each problem named", async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  write("evals/all-pass/graders/regex.md", "---\ntype: regex\npattern: '(unclosed'\n---\n");
  write("evals/all-pass/graders/wrote.md", "---\ntype: tool_used\ntool: mcp:nowhere/thing\nargs: [1]\n---\n");
  write("evals/all-pass/graders/file.md", "---\ntype: file_exists\npath: ../out.md\n---\n");
  write("evals/all-pass/prompt.md", "---\nruns: 0\nmax_cost: 1\n---\nAnswer.\n");
  write("evals/learned/case.yaml", "parameters:\n  team: blue\n  colour: red\nlearning: fixtures/missing/\n");
  write("evals/mcp-match/fixtures/crm.json", '{"server": "crm", "description": "x", "tools": {"get_contact": {"description": "x", "input": {"type": "object"}, "answers": [{"if": {}}]}}}');
  write("evals/mcp-mismatch/case.yaml", "parameters:\n  team: blue\nmcp:\n  crm: fixtures/crm.json\ngrants: [mcp:crm/delete_contact]\n");
  const error = (() => {
    try {
      readCases(dir);
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.ok(error instanceof CaseError, String(error));
  const said = error.problems.join("\n");
  for (const expected of [
    /all-pass\/prompt\.md: no field max_cost/, /all-pass\/prompt\.md: runs is a whole number/,
    /graders\/regex\.md: its pattern does not compile/, /graders\/file\.md: a file_exists grader names a path in the run's work folder/,
    /graders\/wrote\.md: mcp:nowhere\/thing is neither a tool this server binds, an MCP tool the package lists \(mcp:<toolkit>\/<tool>\) nor a monid endpoint it grants by name/, /graders\/wrote\.md: args is a mapping of the arguments a call must carry/,
    /learned\/case\.yaml: parameters\.colour: parameters keeps no field colour/, /learned\/case\.yaml: learning names "fixtures\/missing\/", not a file in the case/,
    /mcp-match\/fixtures\/crm\.json: tools\.get_contact is \{description, input/, /mcp-mismatch\/case\.yaml: grants\.0: grants\.0 is not a tool of the package evalpkg/,
  ]) assert.match(said, expected);
  assert.throws(() => readCases(dir, ["nope"]), (e) => e instanceof CaseError && /evals\/nope: no such case/.test(e.message));
  assert.throws(() => readCases(join(dir, "evals")), PackageError);
});

test("a case whose answer meets a grader of every type passes, each llm grader a blind run of the grader agent", { timeout: 600_000 }, async () => {
  const one = await caseOf("all-pass");
  assert.equal(one.pass, true, JSON.stringify(one, null, 1));
  const [run] = one.runs;
  assert.equal(run.status, "completed");
  assert.deepEqual(new Set(run.graders.map((g) => g.type)), new Set(["output", "regex", "tool_used", "file_exists", "llm"]));
  assert.equal(graderOf(run, "output").reason, "the answer's json meets answer.schema.json");
  assert.ok(run.graders.every((g) => g.pass), JSON.stringify(run.graders));
  assert.match(graderOf(run, "file.md").reason, /work folder holds notes\/out\.md/);
  assert.match(graderOf(run, "wrote.md").reason, /^2 calls of write; the grader expects exactly 2$/);
  // A file past the listing's depth (WALK_DEPTH) is read by its path, never taken for absent.
  assert.match(graderOf(run, "deep-file.md").reason, /work folder holds d1\/d2\/.*\/deep\.md/);
  assert.match(graderOf(run, "target.md").reason, /the answer's summary matches/);
  // Each run's cost and each llm grade's, from the run records: known, and in the case's total.
  const llm = run.graders.filter((g) => g.type === "llm");
  assert.ok(run.cost_usd > 0 && llm.every((g) => g.cost_usd > 0 && g.run_id), JSON.stringify(run));
  assert.equal(one.cost_usd, Math.round((run.cost_usd + llm.reduce((sum, g) => sum + g.cost_usd, 0)) * 1e6) / 1e6);
  // The grader saw its rubric, the run's input and its answer (and the target field, for the one that names it), never
  // another grader's file, the case's description or what the case expects.
  const inputs = graderInputs().filter((input) => input.includes("Write notes/out.md"));
  const plain = inputs.find((input) => input.includes('Pass if the answer contains "GOOD-MARKER".'));
  const targeted = inputs.find((input) => input.includes('Pass if the answer contains "SUMMARY-MARKER".'));
  assert.ok(plain && targeted, inputs.join("\n----\n"));
  assert.match(plain, /<answer untrusted>\nChecked\. GOOD-MARKER/);
  assert.match(targeted, /<target field="summary" untrusted>\nSUMMARY-MARKER all fine\n<\/target>/);
  for (const input of [plain, targeted]) {
    assert.doesNotMatch(input, /BAD-MARKER|summary-marker"|answer\.schema\.json|passes a grader of every type/);
    // The file the run wrote, whole ahead of its calls, and the call that wrote it pointing there.
    assert.match(input, /<files untrusted>\n[^]*<file path="notes\/out\.md" bytes="17">\nthe team's notes\n\n<\/file>\n[^]*<\/files>\n\n<tool-calls untrusted>\n/);
    assert.match(input, /<tool-calls untrusted>\n1\. write \{"path":"notes\/out\.md","content":"the team's notes\\n"\} -> success \[the file notes\/out\.md is in <files>, whole unless marked cut\]: Successfully wrote to notes\/out\.md\n/);
  }
  assert.ok(!plain.includes("SUMMARY-MARKER\".") && !targeted.includes("GOOD-MARKER\"."), "one rubric each");
});

test("a case whose answer fails a grader of every type fails, each failure named in the report", { timeout: 600_000 }, async () => {
  const one = await caseOf("all-fail");
  assert.equal(one.pass, false);
  const [run] = one.runs;
  assert.equal(run.status, "completed", "the run itself went fine: its answer is what fails");
  const failed = Object.fromEntries(run.graders.map((g) => [g.grader, [g.pass, g.reason]]));
  assert.deepEqual(Object.keys(failed).sort(), ["file.md", "llm-target.md", "llm.md", "no-bad.md", "output", "regex.md", "target.md", "wrote.md"]);
  assert.ok(Object.values(failed).every(([pass]) => pass === false), JSON.stringify(failed));
  // No grader file asks for it: the package declares its output schema, and the run's own output_error fails it.
  assert.match(failed.output[1], /^the answer misses answer\.schema\.json: the answer's json does not meet the output schema: \/verdict must be equal to one of the allowed values; \/score must be <= 100/);
  assert.match(failed["regex.md"][1], /does not match .*expects a match/);
  assert.match(failed["no-bad.md"][1], /matches \/BAD-MARKER\/, and the grader expects none/);
  assert.match(failed["target.md"][1], /the answer's summary does not match/);
  assert.match(failed["wrote.md"][1], /^0 calls of write; the grader expects exactly 1$/);
  assert.match(failed["file.md"][1], /has no notes\/out\.md/);
  assert.match(failed["llm.md"][1], /lacks "GOOD-MARKER"/);
  assert.match(failed["llm-target.md"][1], /lacks "SUMMARY-MARKER"/);
  const markdown = markdownReport(await eval_());
  for (const file of Object.keys(failed)) assert.match(markdown, new RegExp(`^  - ${file.replace(".", "\\.")} \\(\\w+\\): `, "m"), markdown);
});

test("a fake MCP server answers from its fixture and records each call; tool_used's args match a call or fail naming it", { timeout: 600_000 }, async () => {
  // update_contact is pinned to id 7 (evalpkg's agent.md): the agent keeps that pin, and on its own server the runner pins
  // it too, as an owner would before the apply, so the granted write reaches the fake.
  const match = await caseOf("mcp-match");
  assert.equal(match.pass, true, JSON.stringify(match, null, 1));
  const [run] = match.runs;
  assert.match(graderOf(run, "updated.md").reason, /^1 call of mcp:crm\/update_contact with \{"id":"7","fields":\{"score":80\}\}; the grader expects exactly 1$/);
  assert.match(graderOf(run, "answered.md").reason, /matches/, "the run read the fixture's answer");
  assert.match(graderOf(run, "either.md").reason, /^2 calls of mcp:crm\/get_contact or mcp:crm\/update_contact/);
  const mismatch = await caseOf("mcp-mismatch");
  assert.equal(mismatch.pass, false);
  assert.match(graderOf(mismatch.runs[0], "updated.md").reason, /^0 calls of mcp:crm\/update_contact with \{"id":"8"\}; the grader expects exactly 1$/);
});

test("an MCP answer too long to read whole is filed where read pages through it to its end, in a run with no shell", { timeout: 600_000 }, async () => {
  // The hosted shape (support.mjs: no box), so the run has read and its MCP tools and no shell: the answer's start names
  // the file and the offset to go on from, and read's pages each name the next, through pi's bound on a tool's output.
  const one = await caseOf("mcp-filed");
  assert.equal(one.pass, true, JSON.stringify(one, null, 1));
  const [run] = one.runs;
  assert.equal(run.status, "completed");
  assert.match(graderOf(run, "end.md").reason, /matches/, "the record's last line was read");
  assert.match(graderOf(run, "read.md").reason, /^\d+ calls? of read/);
});

test("a background shell call keeps its own name in the grading record, as the gate's request does: never counted as bash", () => {
  const rows = [
    { kind: "tool_use", tool_use_id: "1", tool_name: "bash_background", tool_input_preview: "sleep 1" },
    { kind: "tool_use", tool_use_id: "2", tool_name: "bash", tool_input_preview: "ls" },
    { kind: "tool_use", tool_use_id: "3", tool_name: "bash_output", tool_input_preview: "1" },
    { kind: "tool_use", tool_use_id: "4", tool_name: "mcp:crm/get_contact", tool_input_preview: "{}" },
  ];
  assert.deepEqual(callsOf(rows, "claude-agent").map((c) => c.tool), ["bash_background", "bash", "bash_output", "mcp:crm/get_contact"]);
  const record = { answer: "", calls: callsOf(rows, "pi"), mcpCalls: [], files: [] };
  assert.equal(gradeDeterministic({ file: "bg.md", type: "tool_used", tools: ["bash_background"], expect: "called" }, record, []).pass, true);
  assert.equal(gradeDeterministic({ file: "sh.md", type: "tool_used", tools: ["bash"], count: 1 }, record, []).pass, true, "bash counts its own call alone");
  // A need an owner's saved server filled under another name (my-crm for crm): its calls are graded by the package's name.
  const owned = [{ kind: "tool_use", tool_use_id: "5", tool_name: "mcp:my-crm/get_contact", tool_input_preview: "{}" }];
  const renamed = { answer: "", calls: callsOf(owned, "claude-agent", { "my-crm": "crm" }), mcpCalls: [], files: [] };
  assert.deepEqual(renamed.calls.map((c) => c.tool), ["mcp:crm/get_contact"]);
  assert.equal(gradeDeterministic({ file: "got.md", type: "tool_used", tools: ["mcp:crm/get_contact"], expect: "called" }, renamed, []).pass, true);
});

test("a codemode script's call is graded as codemode on every harness, never as a computer kind's tool; a computer tool it called is graded as its kind", () => {
  const rows = [
    { kind: "tool_use", tool_use_id: "1", tool_name: "codemode", tool_input_preview: "return 1;" },
    { kind: "tool_use", tool_use_id: "1/s1", tool_name: "computer_act", tool_input_preview: "{}" },
  ];
  for (const harness of ["pi", "claude-agent", "opencode"]) assert.deepEqual(callsOf(rows, harness).map((c) => c.tool), ["codemode", "desktop"], harness);
});

test("tool_used's at_least passes on that many matching calls or more, its args filtering first as count's do; count stays exact, and a grader gives one of the two", async (t) => {
  const search = (query) => ({ tool: "web_search", arguments: { query }, status: "success", result: "{}" });
  const record = { answer: "", calls: ["a", "b", "c", "d", "robots"].map(search), mcpCalls: [], files: [] };
  const grade = (fields) => gradeDeterministic({ file: "s.md", type: "tool_used", tools: ["web_search"], expect: "called", ...fields }, record, []);
  assert.deepEqual(grade({ atLeast: 4 }), { pass: true, reason: "5 calls of web_search; the grader expects at least 4" }, "five searches pass at least 4");
  assert.equal(grade({ atLeast: 5 }).pass, true);
  assert.deepEqual(grade({ atLeast: 6 }), { pass: false, reason: "5 calls of web_search; the grader expects at least 6" });
  assert.equal(grade({ count: 4 }).pass, false, "count is still exact");
  assert.deepEqual(grade({ atLeast: 2, args: { query: "robots" } }), { pass: false, reason: `1 call of web_search with {"query":"robots"}; the grader expects at least 2` }, "args filter the calls first");
  // Read from a grader's front matter: at_least, a whole number of calls of 1 or more, and never beside count.
  const dir = await webPackage(t, "graded", "unavailable", [["web_search", { objective: "x" }]]);
  const grader = (name, front) => writeFileSync(join(dir, "evals", "graded", "graders", name), `---\ntype: tool_used\ntool: web_search\n${front}\n---\n`);
  grader("most.md", "at_least: 4");
  assert.deepEqual(readCases(dir, ["graded"]).cases[0].graders.find((g) => g.file === "most.md"), { file: "most.md", type: "tool_used", tools: ["web_search"], expect: "called", atLeast: 4 });
  grader("both.md", "count: 4\nat_least: 4");
  grader("zero.md", "at_least: 0");
  grader("none.md", "expect: not_called\nat_least: 2");
  assert.throws(() => readCases(dir, ["graded"]), (e) => {
    for (const said of [/graders\/both\.md: count is an exact number of calls and at_least a least one: give one, not both/, /graders\/zero\.md: at_least is a whole number of calls, 1 or more/, /graders\/none\.md: expect not_called and at_least 2 say different things/]) assert.match(e.message, said);
    return true;
  });
});

/** A copy of the fixture package whose agent is also granted `grants` (monid endpoints), with one case `monid` whose
 *  agent calls monid's /person/enrich by its wire name and whose graders are `graders` ({file: front matter}). */
async function monidPackage(t, grants, graders) {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const manifest = readFileSync(join(dir, "agent.md"), "utf8");
  writeFileSync(join(dir, "agent.md"), manifest.replace("tools: [read, write, ask_person]", `tools: [read, write, ask_person, ${grants.join(", ")}]`));
  const at = join(dir, "evals", "monid");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\n");
  writeFileSync(join(at, "prompt.md"), '---\ndescription: Enriches Ada through monid.\n---\nCall monid__faux__person__enrich with {"body": {"name": "Ada"}}\nAnswer:\nmonid said: {{last-result}}\n\n```json\n{"verdict": "good", "score": 50, "summary": "monid"}\n```\n');
  for (const [file, front] of Object.entries(graders)) writeFileSync(join(at, "graders", file), `---\n${front}\n---\n`);
  return dir;
}
const caseProblems = (dir) => {
  try {
    readCases(dir, ["monid"]);
  } catch (thrown) {
    if (thrown instanceof CaseError) return thrown.problems;
    throw thrown;
  }
  return [];
};

test("a tool_used grader names a monid endpoint the package grants by name, and its calls (the harness's wire name) count under that name", { timeout: 300_000 }, async (t) => {
  withEnv(t, { MONID_API_KEY: FAUX_MONID_KEY });
  const dir = await monidPackage(t, ["monid:faux/person/enrich"], { "enriched.md": "type: tool_used\ntool: monid:faux/person/enrich\ncount: 1" });
  assert.deepEqual(caseProblems(dir), [], "the grader reads");
  const report = await evalTemplate({ dir, cases: ["monid"], serve: { faux: FAUX, fauxMonid: FAUX_MONID } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.match(run.answer, /monid said: .*"full_name":"Ada"/, "the endpoint ran");
  assert.deepEqual(run.calls.map((call) => [call.tool, call.name]), [["monid:faux/person/enrich", "monid:faux/person/enrich"]], JSON.stringify(run.calls));
  assert.equal(graderOf(run, "enriched.md").reason, "1 call of monid:faux/person/enrich; the grader expects exactly 1");
  assert.equal(report.pass, true, JSON.stringify(run.graders));
});

test("a tool_used grader naming a monid endpoint the package does not grant by name is refused, a provider's wildcard grant too", async (t) => {
  const dir = await monidPackage(t, ["monid:faux/person/enrich", "monid:apollo/*"], {
    "other.md": "type: tool_used\ntool: monid:faux/tweets",
    "wild.md": "type: tool_used\ntool: monid:apollo/people/match",
    "star.md": "type: tool_used\ntool: monid:apollo/*",
  });
  const said = caseProblems(dir).join("\n");
  assert.match(said, /graders\/other\.md: monid:faux\/tweets is not a monid endpoint the package grants by name \(it grants monid:faux\/person\/enrich\)/);
  assert.match(said, /graders\/wild\.md: monid:apollo\/people\/match is not a monid endpoint the package grants by name .*monid:apollo\/\* grants .* by monid's listing when the agent is saved, which is not read here: grant monid:apollo\/people\/match by name/);
  assert.match(said, /graders\/star\.md: monid:apollo\/\* is not a monid endpoint the package grants by name/);
});

test("a monid: unavailable case's monid call answers as monid unreachable does, unsent and uncharged, and no run of it reaches monid", { timeout: 300_000 }, async (t) => {
  withEnv(t, { MONID_API_KEY: FAUX_MONID_KEY });
  const dir = await monidPackage(t, ["monid:faux/person/enrich"], { "enriched.md": "type: tool_used\ntool: monid:faux/person/enrich\ncount: 1" });
  writeFileSync(join(dir, "evals", "monid", "case.yaml"), "parameters:\n  team: blue\nmonid: unavailable\n");
  const before = fauxMonidCalls.length;
  const report = await evalTemplate({ dir, cases: ["monid"], serve: { faux: FAUX, fauxMonid: FAUX_MONID } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  // monid-run.ts' own words for a call whose price can't be read because monid can't be reached (monid.ts failure).
  const words = "monid:faux/person/enrich was not sent: monid's price for it could not be read before the call (monid could not be reached: fetch failed).";
  assert.deepEqual(run.calls.map((call) => [call.tool, JSON.parse(call.result.split("\n")[0])]), [["monid:faux/person/enrich", { error: words }]], JSON.stringify(run.calls));
  assert.equal(graderOf(run, "enriched.md").reason, "1 call of monid:faux/person/enrich; the grader expects exactly 1", "tool_used counts the call under its monid name");
  // The save still reads monid's listing to pin the endpoint (free); the call itself sends nothing.
  const sent = fauxMonidCalls.slice(before).map((call) => `${call.method} ${call.path}`);
  assert.ok(!sent.some((line) => line === "POST /v1/run"), `no run reached monid: ${sent.join(", ")}`);
});

test("a monid: case checks: unavailable only, on a package that grants a monid endpoint, and only on the eval's own server", async (t) => {
  const said = { "said.md": "type: regex\npattern: monid" };
  const dir = await monidPackage(t, ["monid:faux/person/enrich"], said);
  writeFileSync(join(dir, "evals", "monid", "case.yaml"), "parameters:\n  team: blue\nmonid: unavailable\n");
  assert.deepEqual(caseProblems(dir), [], "unavailable on a package that grants an endpoint reads");
  await assert.rejects(evalTemplate({ dir, cases: ["monid"], server: { baseUrl: "http://127.0.0.1:9/v2", token: "unused" } }), (e) => e instanceof CaseError && /evals\/monid: monid fakes the package's monid endpoints on the eval's own server alone: run it without --server/.test(e.message));
  writeFileSync(join(dir, "evals", "monid", "case.yaml"), "parameters:\n  team: blue\nmonid: down\n");
  assert.match(caseProblems(dir).join("\n"), /evals\/monid\/case\.yaml: monid is unavailable \(not "down"\)/);
  const bare = await monidPackage(t, ["web_search"], said);
  writeFileSync(join(bare, "evals", "monid", "case.yaml"), "parameters:\n  team: blue\nmonid: unavailable\n");
  assert.match(caseProblems(bare).join("\n"), /evals\/monid\/case\.yaml: monid fakes the package's monid endpoints, and it grants none/);
});

test("an llm grader sees each call's whole arguments, a web_fetch's URL with its query, and never a secret one carried", { timeout: 300_000 }, async (t) => {
  // A secret-shaped header and github token (an sk- key, a GitHub token): the run's own redaction takes them out of what is
  // served, so neither the grader's prompt nor the report holds them. The URL's query is no secret, and is shown whole.
  const url = "https://pricing.example.test/plans?tier=enterprise&seats=50";
  // Both are built at run time, so no key-shaped literal sits in the source.
  const bearer = `sk-${"evalargs0123456789".repeat(2)}`;
  const github = `ghp_${"Ab1".repeat(12)}`;
  // The faux fills them into its call from the environment, so the run's input (the grader's <task>) never holds them.
  withEnv(t, { EVAL_ARGS_BEARER: bearer, EVAL_ARGS_GITHUB: github });
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const manifest = readFileSync(join(dir, "agent.md"), "utf8");
  writeFileSync(join(dir, "agent.md"), manifest.replace("tools: [read, write, ask_person]", "tools: [read, write, ask_person, web_fetch]"));
  const at = join(dir, "evals", "fetch-args");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\n");
  const call = { url, headers: { Authorization: "Bearer {{env:EVAL_ARGS_BEARER}}" }, github: "{{env:EVAL_ARGS_GITHUB}}" };
  writeFileSync(join(at, "prompt.md"), `---\ndescription: Fetches the pricing page with a header.\n---\nCall web_fetch with ${JSON.stringify(call)}\nAnswer:\nFETCH-ARGS done\n\n\`\`\`json\n{"verdict": "good", "score": 50, "summary": "fetch-args"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "fetched.md"), `---\ntype: llm\n---\nPass if the answer contains "FETCH-ARGS".\nThe run fetched ${url}.\n`);
  // Every call's arguments are known now, so tool_used's args match a call of a tool no fake serves.
  writeFileSync(join(at, "graders", "url.md"), `---\ntype: tool_used\ntool: web_fetch\ncount: 1\nargs: { url: "${url}" }\n---\n`);
  const report = await evalTemplate({ dir, cases: ["fetch-args"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.equal(graderOf(run, "url.md").reason, `1 call of web_fetch with {"url":"${url}"}; the grader expects exactly 1`);
  const prompt = graderInputs().find((input) => input.includes("The run fetched https://pricing.example.test"));
  assert.ok(prompt, "the grader ran");
  const calls = prompt.slice(prompt.indexOf("<tool-calls untrusted>"));
  assert.ok(calls.includes(url), `the grader's calls hold the whole URL:\n${calls}`);
  for (const secret of [bearer, github]) {
    assert.ok(!prompt.includes(secret), `no secret reaches the grader's prompt:\n${calls}`);
    assert.ok(!JSON.stringify(report).includes(secret), "no secret reaches the report");
  }
  const fetched = run.calls.find((one) => one.tool === "web_fetch");
  assert.deepEqual(fetched?.arguments, { url, headers: { Authorization: "Bearer [redacted]" }, github: "[redacted]" }, JSON.stringify(run.calls));
});

/** The fixture package copied with web_search and web_fetch granted, and one case `name` whose case.yaml says `web` and
 *  whose prompt makes `calls` ([tool, args]) in order, then answers. `files`: more files in the case, by path. */
async function webPackage(t, name, web, calls, files = {}) {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const manifest = readFileSync(join(dir, "agent.md"), "utf8");
  writeFileSync(join(dir, "agent.md"), manifest.replace("tools: [read, write, ask_person]", "tools: [read, write, ask_person, web_search, web_fetch]"));
  const at = join(dir, "evals", name);
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), `parameters:\n  team: blue\nweb: ${web}\n`);
  const lines = calls.map(([tool, args]) => `Call ${tool} with ${JSON.stringify(args)}`).join("\n");
  writeFileSync(join(at, "prompt.md"), `---\ndescription: Searches and reads the web.\n---\n${lines}\nAnswer:\nWEB done\n\n\`\`\`json\n{"verdict": "good", "score": 50, "summary": "web"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "searched.md"), `---\ntype: tool_used\ntool: web_search\ncount: ${calls.filter(([tool]) => tool === "web_search").length}\n---\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(at, path)), { recursive: true });
    writeFileSync(join(at, path), text);
  }
  return dir;
}
/** A call's result as the model read it: its JSON line. */
const resultOf = (call) => JSON.parse(call.result.split("\n")[0]);

test("a web: unavailable case's run gets the real failed-search words on every web_search, a failed page on every web_fetch, and never the network", { timeout: 300_000 }, async (t) => {
  const { RATE_LIMITED } = await import("../dist/web-run.js");
  const dir = await webPackage(t, "search-failed", "unavailable", [["web_search", { objective: "industrial robotics deals this week" }], ["web_search", { objective: "robotics funding" }], ["web_fetch", { url: "https://deals.example.test/week" }]]);
  const report = await evalTemplate({ dir, cases: ["search-failed"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  const searches = run.calls.filter((call) => call.tool === "web_search");
  assert.equal(searches.length, 2, JSON.stringify(run.calls));
  for (const search of searches) assert.deepEqual(resultOf(search), { error: RATE_LIMITED }, search.result);
  const [fetched] = run.calls.filter((call) => call.tool === "web_fetch");
  assert.equal(resultOf(fetched).ok, false, fetched.result);
  assert.equal(resultOf(fetched).url, "https://deals.example.test/week");
  assert.equal(resultOf(fetched).error, "fetch failed", fetched.result);
  // The calls count as any call does.
  assert.equal(graderOf(run, "searched.md").pass, true, graderOf(run, "searched.md").reason);
});

test("a web: fixture answers a matching query and a fetched URL from the case, and a query or URL it does not match gets its default", { timeout: 300_000 }, async (t) => {
  const hit = { url: "https://news.example.test/robot-deal", title: "Acme raises $40M", snippet: "Acme raised $40M for warehouse robots.", published: "2026-11-12" };
  const fixture = {
    search: { answers: [{ query: "robot", results: [hit] }, { query: "^outage", error: "Parallel's search answered 503" }], default: { results: [] } },
    fetch: { answers: [{ url: hit.url, title: "Acme raises $40M", text: "Acme raised $40M for warehouse robots on 12 November." }, { url: "https://news.example.test/gone", status: 404, text: "" }], default: { error: "fetch failed" } },
  };
  const dir = await webPackage(t, "web-fixture", "fixtures/web.json", [
    ["web_search", { objective: "Robot funding rounds" }],
    ["web_search", { objective: "outage at the exchange" }],
    ["web_search", { objective: "weather in Lisbon" }],
    ["web_fetch", { url: hit.url }],
    ["web_fetch", { url: "https://news.example.test/gone" }],
    ["web_fetch", { url: "https://elsewhere.example.test/" }],
  ], { "fixtures/web.json": JSON.stringify(fixture) });
  const report = await evalTemplate({ dir, cases: ["web-fixture"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  const [robot, outage, weather] = run.calls.filter((call) => call.tool === "web_search").map(resultOf);
  assert.deepEqual({ ...robot, provider: undefined }, { provider: undefined, objective: "Robot funding rounds", queries: ["Robot funding rounds"], results: [hit] });
  assert.ok(["native", "firecrawl-keyless", "parallel"].includes(robot.provider), robot.provider);
  assert.deepEqual(outage, { error: "Parallel's search answered 503" });
  assert.deepEqual({ ...weather, provider: undefined }, { provider: undefined, objective: "weather in Lisbon", queries: ["weather in Lisbon"], results: [] });
  const [page, gone, elsewhere] = run.calls.filter((call) => call.tool === "web_fetch").map(resultOf);
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(page.title, "Acme raises $40M");
  assert.equal(page.text, "Acme raised $40M for warehouse robots on 12 November.");
  assert.deepEqual([gone.ok, gone.status, gone.error], [false, 404, "the page answered 404"]);
  assert.deepEqual([elsewhere.ok, elsewhere.error], [false, "fetch failed"]);
  assert.equal(graderOf(run, "searched.md").pass, true, graderOf(run, "searched.md").reason);
});

test("a web: case checks: unavailable or a fixture file of the case whose answers are whole, and only on the eval's own server", async (t) => {
  const dir = await webPackage(t, "web-bad", "fixtures/web.json", [["web_search", { objective: "x" }]], { "fixtures/web.json": JSON.stringify({ search: { answers: [{ query: "(unclosed", results: [] }, { results: [] }], default: { results: [] } }, fetch: { answers: [{ url: "https://a.example.test/" }], default: { error: "x" } } }) });
  const problems = (() => {
    try {
      readCases(dir, ["web-bad"]);
    } catch (thrown) {
      if (thrown instanceof CaseError) return thrown.problems.join("\n");
      throw thrown;
    }
    return "";
  })();
  assert.match(problems, /web-bad\/fixtures\/web\.json: search\.answers\.0\.query does not compile as a regular expression/);
  assert.match(problems, /web-bad\/fixtures\/web\.json: search\.answers\.1 is \{query, results\} or \{query, error\}/);
  assert.match(problems, /web-bad\/fixtures\/web\.json: fetch\.answers\.0 is \{url, status\?, title\?, text\} or \{url, error\}/);
  const missing = await webPackage(t, "web-missing", "fixtures/none.json", [["web_search", { objective: "x" }]]);
  assert.throws(() => readCases(missing, ["web-missing"]), (e) => e instanceof CaseError && /web-missing\/case\.yaml: web is unavailable, or a fixture file in the case \(not "fixtures\/none\.json"\)/.test(e.message));
  // A package with no web tool, its tools named without one or not named at all (its computer's shell tools, or none).
  for (const tools of ["tools: [read, write, ask_person]\n", ""]) {
    const bare = await webPackage(t, "web-bare", "unavailable", [["web_search", { objective: "x" }]]);
    const manifest = readFileSync(join(bare, "agent.md"), "utf8");
    writeFileSync(join(bare, "agent.md"), manifest.replace("tools: [read, write, ask_person, web_search, web_fetch]\n", tools));
    assert.notEqual(readFileSync(join(bare, "agent.md"), "utf8"), manifest);
    assert.throws(() => readCases(bare, ["web-bare"]), (e) => e instanceof CaseError && /web-bare\/case\.yaml: web fakes web_search, web_fetch and web_save, and the package's tools name none of them/.test(e.message), JSON.stringify(tools));
  }
  // A package that names web_save alone gets the fake too: its files answer from the case.
  const saver = await webPackage(t, "web-save-only", "unavailable", []);
  const saverManifest = readFileSync(join(saver, "agent.md"), "utf8");
  writeFileSync(join(saver, "agent.md"), saverManifest.replace("tools: [read, write, ask_person, web_search, web_fetch]\n", "tools: [read, write, web_save]\n"));
  assert.notEqual(readFileSync(join(saver, "agent.md"), "utf8"), saverManifest);
  assert.doesNotThrow(() => readCases(saver, ["web-save-only"]));
  const named = await webPackage(t, "search-failed", "unavailable", [["web_search", { objective: "x" }]]);
  await assert.rejects(evalTemplate({ dir: named, cases: ["search-failed"], server: { baseUrl: "http://127.0.0.1:9/v2", token: "unused" } }), (e) => e instanceof CaseError && /evals\/search-failed: web fakes the web tools on the eval's own server alone: run it without --server/.test(e.message));
});

test("a web: fixture with no search is refused when the package is read, in the words the eval's case read uses", async (t) => {
  const files = { "fixtures/web.json": JSON.stringify({ fetch: { answers: [], default: { error: "no" } } }) };
  const dir = await webPackage(t, "web-nosearch", "fixtures/web.json", [["web_fetch", { url: "https://example.test/" }]], files);
  assert.throws(() => readCases(dir, ["web-nosearch"]), (e) => e instanceof CaseError && /web-nosearch\/fixtures\/web\.json: a web fixture is \{search: \{answers, default\}, fetch: \{answers, default\}\}/.test(e.message));
  assert.throws(() => readPackage(dir), (e) => e instanceof PackageError && /evals\/web-nosearch\/fixtures\/web\.json: a web fixture is \{search: \{answers, default\}, fetch: \{answers, default\}\}/.test(e.message), "validate-template reads it as eval-template does");
});

test("a grader's prompt stays under its cap: the longest results lose their middle first, then the middle calls, and the list says so", () => {
  const grader = { file: "g.md", type: "llm", rubric: "Pass if it fetched the page." };
  const call = (i, result) => ({ tool: "web_fetch", arguments: { url: `https://example.test/${i}` }, status: "success", result });
  const long = `HEAD-${"a".repeat(6000)}-MIDDLE-${"b".repeat(6000)}-TAIL`;
  const run = { answer: "done", calls: [call(1, "short one"), call(2, long), call(3, long)], mcpCalls: [], files: [] };
  // Under the cap, whole.
  assert.ok(graderInput(grader, "task", run).includes(long));
  const prompt = graderInput(grader, "task", run, 6000);
  assert.ok(prompt.length <= 6000, String(prompt.length));
  const calls = prompt.slice(prompt.indexOf("<tool-calls untrusted>"));
  assert.match(calls, /^<tool-calls untrusted>\n\(Cut to keep this prompt under its cap: each long result keeps its head and tail, its middle cut where marked\.\)\n1\. web_fetch \{"url":"https:\/\/example\.test\/1"\} -> success: short one\n/);
  assert.equal(calls.match(/HEAD-a+ \[\.\.\. \d+ characters cut \.\.\.\] b+-TAIL/g)?.length, 2, calls);
  assert.doesNotMatch(calls, /MIDDLE/);
  // So many calls that not even their heads fit: the first and last stay, the middle ones are dropped, and said.
  const many = { ...run, calls: Array.from({ length: 400 }, (_, i) => call(i + 1, long)) };
  const crowded = graderInput(grader, "task", many, 4000);
  assert.ok(crowded.length <= 4000, String(crowded.length));
  assert.match(crowded, /\(Cut to keep this prompt under its cap: every result is left out, and \d+ calls in the middle\.\)\n1\. web_fetch/);
  assert.match(crowded, /\[\.\.\. \d+ calls cut \.\.\.\]\n(?:.+\n)*400\. web_fetch \{"url":"https:\/\/example\.test\/400"\} -> success\n<\/tool-calls>/);
  // A fake MCP server's calls share the same room: its long arguments lose their middle too, and the cap holds.
  const mcp = (i) => ({ tool: "mcp__crm__lookup", arguments: { note: long, i } });
  const faked = { ...run, mcpCalls: [mcp(1), mcp(2), mcp(3)] };
  const both = graderInput(grader, "task", faked, 9000);
  assert.ok(both.length <= 9000, String(both.length));
  const fakes = both.slice(both.indexOf("<mcp-calls untrusted>"));
  assert.match(fakes, /^<mcp-calls untrusted>\nThe calls the MCP servers received, with their arguments, in order:\n\(Cut to keep this prompt under its cap: each long argument list keeps its head and tail, its middle cut where marked\.\)\n1\. mcp__crm__lookup: \{"note":"HEAD-a+ \[\.\.\. \d+ characters cut \.\.\.\] b+-TAIL","i":1\}\n/);
  assert.match(both, /<tool-calls untrusted>\n\(Cut to keep this prompt under its cap: each long result/);
  // Under the cap, whole, one call to a line.
  assert.ok(graderInput(grader, "task", faked).includes(`1. mcp__crm__lookup: ${JSON.stringify(mcp(1).arguments)}`));
});

test("a grader's prompt cut for room keeps every url a web call answered: snippets and page text give way first, url lists last, and the list says so", () => {
  const grader = { file: "g.md", type: "llm", rubric: "Pass only if every item it reports has a link that appears in its search or fetch results." };
  const hits = (q) => Array.from({ length: 10 }, (_, i) => ({ url: `https://vendor.example/${q}/story-${i + 1}`, title: `Story ${i + 1}`, snippet: `Story ${i + 1}: ${"the team closed its books faster ".repeat(94)}`, published: "2026-11-01" }));
  const search = (q) => ({ tool: "web_search", name: "web_search", arguments: { query: q }, status: "success", result: `${JSON.stringify({ provider: "parallel", query: q, results: hits(q) })}\nCite the URL of each result you rely on.` });
  const page = { ok: true, url: "https://vendor.example/blog/switched", status: 200, title: "Customers who switched", text: "Each team moved its cards over in a week. ".repeat(180), links: [] };
  const fetch = { tool: "web_fetch", name: "web_fetch", arguments: { url: page.url }, status: "success", result: JSON.stringify(page) };
  const bash = { tool: "bash", name: "bash", arguments: { command: "cat notes.md" }, status: "success", result: `HEAD-${"a".repeat(6000)}-TAIL` };
  const run = { answer: "Story 9: https://vendor.example/a/story-9", calls: [search("a"), search("b"), fetch, bash], mcpCalls: [], files: [] };
  const prompt = graderInput(grader, "task", run, 20_000);
  assert.ok(prompt.length <= 20_000, String(prompt.length));
  const calls = prompt.slice(prompt.indexOf("<tool-calls untrusted>"));
  assert.match(calls, /^<tool-calls untrusted>\n\(Cut to keep this prompt under its cap: each long result keeps its head and tail, its middle cut where marked; a web_search keeps every result's url, title and date, and a web_fetch its url and title, their snippets and page text cut\.\)\n/);
  for (const q of ["a", "b"]) for (let i = 1; i <= 10; i++) assert.ok(calls.includes(`"url":"https://vendor.example/${q}/story-${i}","title":"Story ${i}"`), `${q} ${i}`);
  assert.ok(calls.includes(`"url":"${page.url}","status":200,"title":"${page.title}"`));
  assert.match(calls, /4\. bash \{"command":"cat notes\.md"\} -> success: HEAD-a+ \[\.\.\. \d+ characters cut \.\.\.\] a+-TAIL/);
  // Room for the url lists alone: every other result is left out, every url still shown, and the list says so.
  const tight = graderInput(grader, "task", run, 3_500);
  assert.ok(tight.length <= 3_500, String(tight.length));
  for (const q of ["a", "b"]) for (let i = 1; i <= 10; i++) assert.ok(tight.includes(`https://vendor.example/${q}/story-${i}"`), `${q} ${i}`);
  assert.ok(tight.includes(`"url":"${page.url}","status":200,"title":"${page.title}"`));
  // So many searches that their url lists alone pass the room: those lose their middle, said on the list's first line.
  const crowded = graderInput(grader, "task", { ...run, calls: Array.from({ length: 12 }, (_, i) => search(`q${i}`)) }, 6_000);
  assert.ok(crowded.length <= 6_000, String(crowded.length));
  assert.match(crowded, /<tool-calls untrusted>\n\(Cut to keep this prompt under its cap: the web calls' url lists alone pass it, so every other result is left out, and each url list keeps its head and tail, its middle cut where marked\.\)\n1\. web_search/);
  assert.match(crowded, /\n12\. web_search \{"query":"q11"\} -> success: \{"provider":"parallel","query":"q11","results":\[\{"url":"https:\/\/vendor\.example\/q11\/story-1",[^\n]* \[\.\.\. \d+ characters cut \.\.\.\] [^\n]*\nCite the URL of each result you rely on\.\n<\/tool-calls>/);
});

test("the eval's exit code is 1 when any case failed, however many passed beside it, and 0 only when every case passed", () => {
  const of = (...passes) => exitCodeOf({ cases: passes.map((pass, i) => ({ name: `c${i}`, pass })) });
  assert.deepEqual([of(true), of(true, true), of(false), of(true, false), of(false, true, true)], [0, 0, 1, 1, 1]);
});

/** A copy of the fixture package with a case `clock` whose agent answers the day its environment line names, graded by
 *  a regex and an llm grader; its case.yaml carries `now` when given. */
async function clockPackage(t, now, today, mark = "CLOCK-CASE") {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "clock");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), `parameters:\n  team: blue\n${now === undefined ? "" : `now: ${now}\n`}`);
  writeFileSync(join(at, "prompt.md"), `---\ndescription: The run is told the day.\n---\nAnswer:\nToday: {{today}} (${mark})\n\n\`\`\`json\n{"verdict": "good", "score": 50, "summary": "clock"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "day.md"), `---\ntype: regex\npattern: "Today: ${today}"\n---\n`);
  writeFileSync(join(at, "graders", "judged.md"), `---\ntype: llm\n---\nPass if the answer contains "${mark}".\n`);
  return dir;
}

test("a case's now is its runs' clock: the environment line names its day, and its llm graders are told it", { timeout: 300_000 }, async (t) => {
  const report = await evalTemplate({ dir: await clockPackage(t, "2026-11-14T09:00:00Z", "Saturday 14 November 2026"), cases: ["clock"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.match(run.answer, /^Today: Saturday 14 November 2026 \(CLOCK-CASE\)/, "the environment line says the case's day");
  assert.equal(report.cases[0].pass, true, JSON.stringify(run.graders));
  const graded = graderInputs().filter((input) => input.includes("CLOCK-CASE"));
  assert.equal(graded.length, 1);
  assert.match(graded[0], /^The run ran on a clock set to 2026-11-14T09:00:00Z: its date was Saturday 14 November 2026 \(America\/Los_Angeles\), whatever today's date is where you are\.$/m);
});

test("a case without now runs on the real clock, and its graders are told no clock", { timeout: 300_000 }, async (t) => {
  const dayNow = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).replace(",", "");
  const today = dayNow();
  const report = await evalTemplate({ dir: await clockPackage(t, undefined, today, "REAL-CLOCK"), cases: ["clock"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  // A run that crossed midnight in the zone says the next day.
  assert.ok([today, dayNow()].some((day) => run.answer.startsWith(`Today: ${day} `)), run.answer);
  const graded = graderInputs().filter((input) => input.includes("REAL-CLOCK"));
  assert.equal(graded.length, 1);
  assert.doesNotMatch(graded[0], /clock set to/);
});

test("readCases refuses a now that is not a date and time with its offset, and a now case refuses a named server", async (t) => {
  for (const bad of ["2026-11-14", "2026-11-14T09:00:00", "2026-02-30T09:00:00Z", "tomorrow", "2026-11-14T25:00:00Z"]) {
    const dir = await clockPackage(t, bad, "x");
    assert.throws(() => readCases(dir, ["clock"]), (thrown) => thrown instanceof CaseError && thrown.problems.includes(`evals/clock/case.yaml: now is a date and time with its offset (2026-11-14T09:00:00Z), not ${JSON.stringify(bad)}`), bad);
  }
  const dir = await clockPackage(t, "2026-11-14T09:00:00+02:00", "x");
  assert.equal(readCases(dir, ["clock"]).cases[0].now, "2026-11-14T09:00:00+02:00");
  // Only the eval's own server sets a run's clock: a named one would run the case on its own, and is refused unreached.
  await assert.rejects(evalTemplate({ dir, cases: ["clock"], server: { baseUrl: "http://127.0.0.1:9", token: "x" } }), (thrown) => thrown instanceof CaseError && thrown.problems.includes("evals/clock: now sets its runs' clock on the eval's own server alone: run it without --server"));
});

/** A copy of the fixture package with a case `resume`: a run that resumes on keys an earlier one made. Its case.yaml
 *  seeds `files` (YAML text, absent for none) and its fake CRM answers get_contact only for keys of the stem
 *  k7m2p9qa, by $pattern; its agent asks for a fresh stem's key, then the seeded stem's, then reads the seeded file. */
async function resumePackage(t, files = '  media/run-keys.json: "{\\"stem\\": \\"k7m2p9qa\\"}\\n"\n') {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "resume");
  mkdirSync(join(at, "graders"), { recursive: true });
  mkdirSync(join(at, "fixtures"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), `parameters:\n  team: blue\nmcp:\n  crm: fixtures/crm.json\ngrants:\n  - mcp:crm/get_contact\n${files === undefined ? "" : `files:\n${files}`}`);
  const text = (text) => ({ content: [{ type: "text", text }] });
  writeFileSync(join(at, "fixtures", "crm.json"), JSON.stringify({ server: "crm", description: "Keys of the stem k7m2p9qa.", tools: {
    get_contact: { description: "Read a contact by key.", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      answers: [{ when: { id: { $pattern: "ns-k7m2p9qa-[a-z-]+" } }, result: text("resumed k7m2p9qa") }], default: { ...text("no such key"), isError: true } },
    update_contact: { description: "Set a contact's fields.", input: { type: "object" }, answers: [], default: { ...text("no such contact"), isError: true } },
  } }));
  writeFileSync(join(at, "prompt.md"), `---\ndescription: A resumed run reads its stem from the seeded keys file, and the fake answers that stem's keys alone.\n---\nCall mcp__crm__get_contact with {"id": "ns-zz9yx8wv-voice-cold-open"}\nCall mcp__crm__get_contact with {"id": "ns-k7m2p9qa-voice-cold-open"}\nCall read with {"path": "media/run-keys.json"}\nAnswer:\nKeys: {{last-result}}\n\n\`\`\`json\n{"verdict": "good", "score": 50, "summary": "resume"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "keys.md"), `---\ntype: regex\npattern: 'Keys:[\\s\\S]*"stem": "k7m2p9qa"'\n---\n`);
  writeFileSync(join(at, "graders", "seeded.md"), "---\ntype: file_exists\npath: media/run-keys.json\n---\n");
  return dir;
}

test("a case's files are in its run's work folder before its first turn: the run reads them, and its files list them", { timeout: 300_000 }, async (t) => {
  const report = await evalTemplate({ dir: await resumePackage(t), cases: ["resume"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.equal(report.cases[0].pass, true, JSON.stringify(run.graders));
  assert.match(run.calls.find((call) => call.tool === "read").result, /"stem": "k7m2p9qa"/, "the run read the seeded file");
  assert.match(graderOf(run, "seeded.md").reason, /^the run's work folder holds media\/run-keys\.json$/);
  // The fake answers the seeded stem's key by its $pattern, and a fresh stem's gets its default.
  const asked = run.calls.filter((call) => call.tool === "mcp:crm/get_contact");
  assert.equal(asked.length, 2, JSON.stringify(run.calls));
  assert.match(asked[0].result, /no such key/);
  assert.match(asked[1].result, /resumed k7m2p9qa/);
});

test("readCases checks a case's files: each a relative path in the work folder, outside inputs/, to its text; and only the eval's own server seeds them", async (t) => {
  const dir = await resumePackage(t);
  assert.deepEqual(readCases(dir, ["resume"]).cases[0].files, { "media/run-keys.json": '{"stem": "k7m2p9qa"}\n' });
  const problems = (files) => {
    writeFileSync(join(dir, "evals", "resume", "case.yaml"), `parameters:\n  team: blue\nmcp:\n  crm: fixtures/crm.json\nfiles: ${files}\n`);
    try {
      readCases(dir, ["resume"]);
    } catch (thrown) {
      if (thrown instanceof CaseError) return thrown.problems;
      throw thrown;
    }
    return [];
  };
  const unseeded = "is not a path in the run's work folder (relative, with no empty, . or .. segment)";
  for (const path of ["/etc/keys.json", "media/../../keys.json", "..", "./keys.json", "media//keys.json", "media/", "media\\keys.json"]) {
    assert.deepEqual(problems(JSON.stringify({ [path]: "x" })), [`evals/resume/case.yaml: files: ${JSON.stringify(path)} ${unseeded}`], path);
  }
  assert.deepEqual(problems('{"": "x"}'), [`evals/resume/case.yaml: files: "" ${unseeded}`]);
  assert.deepEqual(problems('{"inputs/message.md": "x"}'), ["evals/resume/case.yaml: files: \"inputs/message.md\" is under inputs/, where the server puts the run's uploads and its message"]);
  assert.deepEqual(problems('{"a.json": 5, "b.json": {"stem": "x"}}'), ["evals/resume/case.yaml: files: \"a.json\" is the file's text, a string", "evals/resume/case.yaml: files: \"b.json\" is the file's text, a string"]);
  assert.deepEqual(problems("[media/run-keys.json]"), ["evals/resume/case.yaml: files is a mapping of a path in the run's work folder to the text that file starts with"]);
  // A path that names an object's own property is a file like any other: none is lost to the object it is kept in.
  assert.deepEqual(problems('{"__proto__": "p", "constructor": "c", "a/__proto__": "q"}'), []);
  const named = readCases(dir, ["resume"]).cases[0].files;
  assert.deepEqual(Object.keys(named).sort(), ["__proto__", "a/__proto__", "constructor"]);
  assert.deepEqual([named.__proto__, named.constructor, named["a/__proto__"]], ["p", "c", "q"]);
  assert.equal(Object.getPrototypeOf(named), Object.prototype);
  // The eval's own runner writes them at the claim: a named server's runs would start without them.
  assert.equal(problems('{"media/run-keys.json": "{}"}').length, 0);
  await assert.rejects(evalTemplate({ dir, cases: ["resume"], server: { baseUrl: "http://127.0.0.1:9", token: "x" } }), (thrown) => thrown instanceof CaseError && thrown.problems.includes("evals/resume: files seeds its runs' work folders on the eval's own server alone: run it without --server"));
});

test("a fake's when matches a string argument whole by {$pattern}; any other value, a string or an object, still by equality", () => {
  const text = (text) => ({ content: [{ type: "text", text }] });
  const fixture = { server: "studio", description: "", tools: {
    submit: { description: "", input: { type: "object" }, answers: [
      { when: { submission_key: { $pattern: "ns-[a-z0-9]{8}-voice-cold-open" }, kind: "voice" }, result: text("cold open") },
      { when: [{ submission_key: { $pattern: "ns-a|ns-b" } }, { ref: { $pattern: "r-\\d+" } }], result: text("either") },
      { when: { submission_key: "exact" }, result: text("exact") },
      { when: { submission_key: { pattern: "x" } }, result: text("an object, equal") },
    ], default: { ...text("none"), isError: true } },
  } };
  const said = (args) => fakeAnswer(fixture, "submit", args).content[0].text;
  assert.equal(said({ submission_key: "ns-k7m2p9qa-voice-cold-open", kind: "voice", more: 1 }), "cold open", "the whole string matches, every other listed argument equal");
  assert.equal(said({ submission_key: "ns-k7m2p9qa-voice-cold-open", kind: "music" }), "none", "a pattern does not excuse another argument");
  for (const key of ["ns-k7m2p9qa-voice-cold-open-2", "x-ns-k7m2p9qa-voice-cold-open", "ns-k7m2p9q-voice-cold-open", "ns-K7M2P9QA-voice-cold-open"]) assert.equal(said({ submission_key: key, kind: "voice" }), "none", `${key}: only the whole string matches`);
  // An alternation is anchored as a whole: ns-a|ns-b takes ns-a and ns-b alone, never a string that starts with ns-a.
  assert.equal(said({ submission_key: "ns-b" }), "either");
  assert.equal(said({ submission_key: "ns-a-later" }), "none");
  assert.equal(said({ ref: "r-12" }), "either", "a when list's entry by pattern");
  for (const ref of [12, ["r-12"], { r: "r-12" }, null]) assert.equal(said({ ref }), "none", `${JSON.stringify(ref)}: a pattern matches a string alone`);
  assert.equal(said({ kind: "voice" }), "none", "an argument the call lacks matches no pattern");
  assert.equal(said({ submission_key: "exact" }), "exact");
  assert.equal(said({ submission_key: "exactly" }), "none", "a plain string is equality, never a pattern");
  assert.equal(said({ submission_key: { pattern: "x" } }), "an object, equal");
});

test("readCases refuses a $pattern that is no string, does not compile, or shares its object with another key, naming the tool and the answer", async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = "evals/mcp-match/fixtures/crm.json";
  const result = { content: [{ type: "text", text: "x" }] };
  writeFileSync(join(dir, at), JSON.stringify({ server: "crm", description: "x", tools: {
    get_contact: { description: "x", input: { type: "object" }, answers: [
      { when: { id: { $pattern: "(unclosed" } }, result },
      { when: [{ id: "7" }, { id: { $pattern: 7 } }], result },
      { when: { id: { $pattern: "ns-[a-z0-9]{8}" } }, result },
    ] },
    update_contact: { description: "x", input: { type: "object" }, answers: [{ when: { id: { $pattern: "7", flags: "i" } }, result }] },
  } }));
  const error = (() => {
    try {
      readCases(dir, ["mcp-match"]);
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.ok(error instanceof CaseError, String(error));
  assert.equal(error.problems.length, 3, error.problems.join("\n"));
  assert.match(error.problems[0], /^evals\/mcp-match\/fixtures\/crm\.json: tools\.get_contact\.answers\[0\]\.when\.id: its \$pattern does not compile: Invalid regular expression/);
  assert.equal(error.problems[1], "evals/mcp-match/fixtures/crm.json: tools.get_contact.answers[1].when[1].id: $pattern is a regular expression's source, a string");
  assert.equal(error.problems[2], "evals/mcp-match/fixtures/crm.json: tools.update_contact.answers[0].when.id: a {\"$pattern\": ...} value holds no other key, and this one holds flags");
});

test("a correction seeded through the learning API reaches the run", { timeout: 600_000 }, async () => {
  const one = await caseOf("learned");
  assert.equal(one.pass, true, JSON.stringify(one, null, 1));
});

test("a run that asks its person ends there, and is graded as it stood", { timeout: 600_000 }, async () => {
  const one = await caseOf("asks");
  assert.equal(one.pass, true, JSON.stringify(one, null, 1));
  const [run] = one.runs;
  assert.equal(run.status, "input_required");
  assert.match(run.error, /^the run waited on a person \(.*Which region\?.*\); graded as it stood$/);
  assert.match(graderOf(run, "asked.md").reason, /^1 call of ask_person; the grader expects exactly 1$/);
});

test("a case passes only when every run passes: one failing run of two fails it", { timeout: 600_000 }, async () => {
  const one = await caseOf("flaky");
  assert.deepEqual(one.runs.map((r) => [r.run, r.status, r.pass]), [[1, "completed", true], [2, "completed", false]]);
  assert.equal(one.pass, false);
  assert.notEqual(one.runs[0].agent_id, one.runs[1].agent_id, "each run its own agent");
  const report = await eval_();
  assert.equal(report.pass, false);
  assert.deepEqual(report.cases.map((c) => [c.name, c.pass]), [["all-fail", false], ["all-pass", true], ["asks", true], ["flaky", false], ["held", true], ["learned", true], ["mcp-filed", true], ["mcp-match", true], ["mcp-mismatch", false]]);
  assert.equal(report.passed, 6);
  assert.equal(report.cost_usd.total, Math.round((report.cost_usd.runs + report.cost_usd.graders) * 1e6) / 1e6);
  assert.equal(report.cost_usd.unknown, 0);
});

test("an eval runs under approvals never, which grants nothing: a tool of the package the case did not grant is still refused, never sent", { timeout: 300_000 }, async (t) => {
  // evalpkg asks (approvals ask), and the eval applies it with approvals never; its two crm tools are the package's, and
  // the case grants get_contact alone. The eval writes no permission for either.
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "widens-nothing");
  mkdirSync(join(at, "graders"), { recursive: true });
  mkdirSync(join(at, "fixtures"), { recursive: true });
  cpSync(join(PKG, "evals", "mcp-match", "fixtures", "crm.json"), join(at, "fixtures", "crm.json"));
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\nmcp:\n  crm: fixtures/crm.json\ngrants: [mcp:crm/get_contact]\n");
  writeFileSync(join(at, "prompt.md"), '---\ndescription: Reads contact 7, then tries the update the case did not grant.\n---\nCall mcp__crm__get_contact with {"id": "7"}\nCall mcp__crm__update_contact with {"id": "7", "fields": {"score": 80}}\nAnswer:\nThe CRM said: {{last-result}}\n');
  writeFileSync(join(at, "graders", "ran.md"), "---\ntype: regex\npattern: \"The CRM said\"\n---\n");
  const report = await evalTemplate({ dir, cases: ["widens-nothing"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  // The grant ran unasked: approvals never lifts the ask of a tool the agent was granted.
  assert.deepEqual(run.mcp_calls.map((call) => call.tool), ["mcp:crm/get_contact"], "only the granted tool reached the fake");
  assert.equal(run.calls.find((call) => call.tool === "mcp:crm/get_contact")?.status, "success", JSON.stringify(run.calls));
  // The tool the case did not grant is not the agent's: never has nothing to lift, so it is refused and never sent.
  const update = run.calls.find((call) => call.name === "mcp__crm__update_contact");
  assert.ok(!update || update.status !== "success", JSON.stringify(run.calls));
  assert.match(run.answer ?? "", /^The CRM said: /, run.answer);
  assert.doesNotMatch(run.answer, /updated 7/, "the ungranted write never ran");
});

test("on an owner's server it applies that server's package only when it is this folder's, never replaces an MCP server, and archives what it made", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const server = { baseUrl, token };
  // The owner's settings are theirs, and the runner writes none of them. The eval applies with approvals never here too,
  // so the case's grants run unasked. Unpinned there, the pinned write is held by the agent's own pin, and the case passes.
  const before = (await api("GET", "/settings/tools")).body;
  const unpinned = await evalTemplate({ dir: PKG, cases: ["mcp-match"], server });
  assert.equal(unpinned.pass, true, JSON.stringify(unpinned.cases[0].runs.map((r) => r.error ?? r.status)));
  assert.deepEqual((await api("GET", "/settings/tools")).body, before, "the runner wrote no setting of the owner's");
  assert.equal((await api("PUT", "/settings/tools", { ...before, "mcp:crm/update_contact": { pin: { id: "7" } } })).status, 200);
  const report = await evalTemplate({ dir: PKG, cases: ["mcp-match"], server });
  assert.equal(report.pass, true, JSON.stringify(report, null, 1));
  assert.deepEqual(report.server, { kind: "remote", base_url: baseUrl.replace(/\/$/, "") });
  assert.equal((await api("GET", "/settings/mcp-servers/crm")).status, 404, "the fake's entry is gone");
  const listed = (await api("GET", "/agents")).body.agents.map((a) => a.agent_id);
  assert.ok(!listed.includes(report.cases[0].runs[0].agent_id), "the agent it made is archived");

  // An MCP server of the owner's by the fake's name stays, and the case fails saying why.
  const owner = await startFake("crm", readCases(PKG, ["mcp-match"]).cases[0].mcp.crm);
  t.after(() => owner.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/crm", { url: owner.url, auth: { type: "none" } })).status, 200);
  const kept = await evalTemplate({ dir: PKG, cases: ["mcp-match"], server });
  assert.equal(kept.pass, false);
  assert.match(kept.cases[0].error, /already has an MCP server named crm/);
  assert.equal((await api("GET", "/settings/mcp-servers/crm")).body.url, `${new URL(owner.url).origin}/…`, "the owner's entry is untouched (its URL shown as its origin)");

  // A folder whose package differs from the one the server ships is not measured on that server.
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), readFileSync(join(dir, "agent.md"), "utf8").replace("You answer for", "You now answer for"));
  const other = await evalTemplate({ dir, cases: ["learned"], server });
  assert.equal(other.pass, false);
  assert.match(other.cases[0].error, /the server's evalpkg package is not this folder's/);
});

test("a stopped eval cancels the run in progress and cleans up what it made, as its end does", { timeout: 300_000 }, async (t) => {
  // Set before the server starts, so its runs' processes inherit it: the held case's run writes the file once it is in
  // its turn, and holds there until it is stopped.
  const holding = join(await scratch(t), "holding");
  process.env.AGENTRUN_TEST_EVAL_HOLD = holding;
  t.after(() => delete process.env.AGENTRUN_TEST_EVAL_HOLD);
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const stop = new AbortController();
  const stopped = evalTemplate({ dir: PKG, cases: ["held", "learned"], server: { baseUrl, token }, signal: stop.signal });
  await untilFile(holding, stopped);
  assert.ok(existsSync(holding), "the held run reached its turn");
  const runs = (await api("GET", "/runs")).body.runs;
  assert.equal(runs.length, 1, "the held run, in its turn");
  stop.abort();
  await assert.rejects(stopped, { name: "AbortError" });
  assert.equal((await api("GET", `/runs/${runs[0].run_id}`)).body.status, "cancelled", "the run in progress is cancelled");
  assert.equal((await api("GET", "/agents")).body.agents.length, 0, "the agent it made is archived, and no other was made");
});

/** A proxy on port 0 to the server at `baseUrl` (ending /v2) that answers 500 to each request `refuses(req)` says so,
 *  and passes the rest on, each answer as `edit(req, body)` makes it when given one (the body a Buffer, or a promise of
 *  one: one that never settles is a server that stalls). Its /v2 address. A pass-on that fails (the server closed first: its hook was added before
 *  this proxy's, so it runs first at the test's end) is answered 502, never left as an unhandled rejection that fails
 *  the test after its assertions passed. */
async function refusing(t, baseUrl, refuses, edit = (_req, body) => body) {
  const proxy = createServer(async (req, res) => {
    if (refuses(req)) return void res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"code":"internal","message":"refused by the test proxy"}}');
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const answer = await fetch(`${baseUrl.replace(/\/v2$/, "")}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length")), ...(body.length ? { body } : {}) });
      const passed = Buffer.from(await answer.arrayBuffer());
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" }).end(await edit(req, passed));
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "bad_gateway", message: `the test proxy's pass-on failed: ${error.message}` } }));
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (proxy.closeAllConnections(), proxy.close(resolve))));
  return `http://127.0.0.1:${proxy.address().port}/v2`; // key-gate: loopback-rule the test's proxy listens on loopback
}

test("the test proxy answers 502 when the server it passes on to is gone, never an unhandled rejection", { timeout: 30_000 }, async (t) => {
  // A server that listened and closed: its port answers nothing, as the eval's server does once its hook has run.
  const gone = createServer();
  await new Promise((resolve) => gone.listen(0, "127.0.0.1", resolve));
  const { port } = gone.address();
  await new Promise((resolve) => gone.close(resolve));
  const closed = new URL("http://127.0.0.1/v2"); // key-gate: loopback-rule a closed loopback port the proxy cannot reach
  closed.port = String(port);
  const proxy = await refusing(t, closed.href, () => false);
  // A bound on the request, so a proxy that never answers fails here, not at the test's timeout.
  const answer = await fetch(`${proxy}/agents`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(answer.status, 502);
  const { error } = await answer.json();
  assert.equal(error.code, "bad_gateway");
  assert.match(error.message, /^the test proxy's pass-on failed: /);
});

test("a run whose wait fails keeps its result and is cancelled before the eval goes on, never left going", { timeout: 300_000 }, async (t) => {
  // The held case's run never answers on its own: only a cancel ends it.
  process.env.AGENTRUN_TEST_EVAL_HOLD = join(await scratch(t), "holding");
  t.after(() => delete process.env.AGENTRUN_TEST_EVAL_HOLD);
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const report = await evalTemplate({ dir: PKG, cases: ["held"], server: { baseUrl: await refusing(t, baseUrl, (req) => /\/runs\/[^/]+\/timeline/.test(req.url)), token } });
  // The run was started, so it is paid for: it keeps a result (its id, its cost as the server says it), failed with why,
  // never dropped from the case.
  const [one] = report.cases[0].runs;
  assert.equal(report.cases[0].pass, false);
  assert.ok(one, JSON.stringify(report.cases[0]));
  assert.match(one.error, /^after the run started: .*timeline: 500 refused by the test proxy/);
  assert.deepEqual([one.status, one.pass], ["unknown", false]);
  const runs = (await api("GET", "/runs?archived=true")).body.runs;
  assert.equal(runs.length, 1);
  assert.equal(one.run_id, runs[0].run_id);
  assert.equal((await api("GET", `/runs/${runs[0].run_id}`)).body.status, "cancelled", "the run the eval started is cancelled");
});

test("a run no runner takes fails by name once it has stayed queued past its bound, never left to the run's whole timeout", { timeout: 120_000 }, async (t) => {
  // A server with no runner beside it: every run it takes stays queued.
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES, runner: false });
  const report = await evalTemplate({ dir: PKG, cases: ["learned"], server: { baseUrl, token }, queueTimeoutMs: 3_000 });
  const [one] = report.cases[0].runs;
  assert.ok(one, JSON.stringify(report.cases[0]));
  assert.deepEqual([one.status, one.pass], ["timed_out", false]);
  assert.match(one.error, /^the run stayed queued for 3 s with no runner holding it, and it was cancelled$/);
  // The eval asked to cancel it and cleaned up what it made (the agent archived); no runner ever claimed the run.
  const left = (await api("GET", `/runs/${one.run_id}`)).body;
  assert.equal(left.claim, null, "never claimed");
});

test("a run a runner holds is waited for while its view still reads queued (its first rows not shown): the queued bound is for a run no runner holds", { timeout: 180_000 }, async (t) => {
  // The held case's run is claimed and holds in its turn until it is cancelled (the file its faux writes there says so).
  // Until then the proxy holds each of the eval's timeline pages back, so the queued bound is never asked before a runner
  // holds the run, however long the claim takes; from then on it serves each page as a held run's view reads before its
  // first rows show: queued. The eval is stopped once it reads the page after a run read that found the run held: it
  // went on waiting, never cancelling the run as queued, with no wait on any bound of its own.
  const holding = join(await scratch(t), "holding");
  process.env.AGENTRUN_TEST_EVAL_HOLD = holding;
  t.after(() => delete process.env.AGENTRUN_TEST_EVAL_HOLD);
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const inTurn = untilFile(holding, new Promise((resolve) => t.after(resolve)));
  const stop = new AbortController();
  const timeline = (req) => /\/runs\/[^/]+\/timeline/.test(req.url);
  let heldRead = false;
  const arrived = (req) => {
    if (heldRead && timeline(req)) stop.abort();
    return false;
  };
  const queued = async (req, body) => {
    if (req.method === "GET" && /^\/v2\/runs\/[^/?]+$/.test(req.url)) {
      if (JSON.parse(String(body)).claim) heldRead = true;
      return body;
    }
    if (!timeline(req)) return body;
    await inTurn;
    const page = JSON.parse(String(body));
    return page.final ? body : Buffer.from(JSON.stringify({ ...page, status: "queued", state: "working" }));
  };
  const proxy = await refusing(t, baseUrl, arrived, queued);
  const stopped = evalTemplate({ dir: PKG, cases: ["held"], server: { baseUrl: proxy, token }, queueTimeoutMs: 1_000, signal: stop.signal });
  // A wait that gave up on the run as queued ends the eval with a report, never this stop.
  await assert.rejects(stopped, { name: "AbortError" });
  assert.ok(existsSync(holding), "the run reached its turn: a runner held it");
  assert.ok(heldRead, "a run read found the run held while its view read queued");
  const runs = (await api("GET", "/runs?archived=true")).body.runs;
  assert.equal(runs.length, 1);
  assert.equal((await api("GET", `/runs/${runs[0].run_id}`)).body.status, "cancelled", "the run the eval started is cancelled at the stop");
});

test("a claim read that stalls doesn't hold the run's deadline: the read is given up on at the deadline, never its own longer bound, and the run cancelled then", { timeout: 120_000 }, async (t) => {
  // No runner: the run stays queued. Until the eval cancels it, the proxy never answers the run read the queued bound
  // asks, as a server that took the request and stalled would.
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES, runner: false });
  let stalledAt, cancelAt;
  // The cancel's arrival, timed as it comes in.
  const arrived = (req) => {
    if (req.method === "POST" && /\/runs\/[^/]+\/cancel$/.test(req.url)) cancelAt ??= Date.now();
    return false;
  };
  const stalled = (req, body) => {
    if (req.method !== "GET" || !/^\/v2\/runs\/[^/?]+$/.test(req.url) || cancelAt !== undefined) return body;
    stalledAt ??= Date.now();
    return new Promise(() => {});
  };
  const report = await evalTemplate({ dir: PKG, cases: ["learned"], server: { baseUrl: await refusing(t, baseUrl, arrived, stalled), token }, queueTimeoutMs: 1_000, runTimeoutMs: 8_000 });
  // The deadline is 8 s after the run started. The read stalls before it, at the first queued page past the 1 s bound (a
  // timeline page waits at most 5 s), so the cancel comes at most 7 s after the stall began: at the deadline, never at
  // the read's own 10 s bound (CLAIM_READ_TIMEOUT_MS), which ends past it.
  assert.ok(stalledAt !== undefined && cancelAt !== undefined, "a run read stalled, and the run was cancelled");
  assert.ok(cancelAt - stalledAt < 9_000, `the cancel came ${cancelAt - stalledAt} ms after the stalled read began`);
  const [one] = report.cases[0].runs;
  assert.ok(one, JSON.stringify(report.cases[0]));
  assert.deepEqual([one.status, one.pass], ["timed_out", false]);
  assert.match(one.error, /^the run took longer than 8 s \(state \w+ when the wait gave up\) and was cancelled$/);
  assert.equal((await api("GET", `/runs/${one.run_id}`)).body.status, "cancelled", "the run the eval started is cancelled");
});

test("a listing of the server's templates that fails once fails that case alone: the next case asks again", { timeout: 300_000 }, async (t) => {
  const { baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  let refused = 0;
  const proxy = await refusing(t, baseUrl, (req) => req.method === "GET" && req.url === "/v2/templates" && refused++ === 0);
  const report = await evalTemplate({ dir: PKG, cases: ["held", "learned"], server: { baseUrl: proxy, token } });
  assert.deepEqual(report.cases.map((c) => [c.name, c.pass]), [["held", false], ["learned", true]], JSON.stringify(report.cases, null, 1));
  assert.match(report.cases[0].error, /^listing the server's templates: 500 refused by the test proxy/);
  assert.equal(refused, 2, "asked once more after the refusal, then kept");
});

test("an eval runs its agents with approvals never, whatever the package's default, and its report says so", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const report = await evalTemplate({ dir: PKG, cases: ["mcp-match"], runs: 1, server: { baseUrl, token } });
  assert.deepEqual(report.approvals, { measured: "never", package: "ask" });
  const agent = (await api("GET", `/agents/${encodeURIComponent(report.cases[0].runs[0].agent_id)}`)).body;
  assert.equal(agent.definition?.approvals, "never", JSON.stringify(agent.definition));
  assert.equal((await api("GET", "/templates")).body.templates.find((x) => x.name === "evalpkg").approvals_default, "ask", "the package's own setting is unchanged");
  assert.match(markdownReport(report), /Measured with approvals never \(the package's own default is ask\)\./);
});

test("an eval of a package with a composio trigger runs its case: the eval's own server can't set the trigger up (no public URL), so its apply skips it, as a github trigger's, and the fake stands in for the need", { timeout: 300_000 }, async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8")
    .replace("  - source: url\n    toolkit: crm\n", "  - source: composio\n    toolkit: crm\n    required: true\n")
    .replace("learning: true", "learning: true\nbudget: { per_run_usd: 0.5 }\ntriggers:\n  - name: contact-updated\n    source: { kind: composio, server: crm, event: CRM_CONTACT_UPDATED, config: {} }\n    target: { kind: start_run, input: { content: \"Answer for the contact.\" } }"));
  const report = await evalTemplate({ dir, cases: ["mcp-match"], runs: 1, serve: { faux: FAUX } });
  assert.equal(report.cases[0].error, undefined, JSON.stringify(report.cases[0]));
  assert.equal(report.cases[0].runs.length, 1, JSON.stringify(report.cases[0]));
  assert.equal(report.cases[0].pass, true, JSON.stringify(report.cases[0].runs[0]?.graders));
});

test("an eval's agent has none of the package's triggers: market-monitor's weekly schedule is deleted at its apply", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t, { faux: FAUX });
  const report = await evalTemplate({ dir: join(TEMPLATES_DIR, "market-monitor"), cases: ["nothing-changed"], runs: 1, server: { baseUrl, token } });
  assert.equal(report.cases[0].runs.length, 1, JSON.stringify(report.cases[0]));
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, [], "no trigger left");
});

test("on another server, a package that differs in what runs (budget, effort, tools) fails the case, naming the field", { timeout: 300_000 }, async (t) => {
  const shipped = join(await scratch(t), "templates");
  cpSync(PKG, join(shipped, "evalpkg"), { recursive: true });
  const manifest = join(shipped, "evalpkg", "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("tools: [read, write, ask_person]", "tools: [read, write, ask_person, web_fetch]").replace("learning: true", "learning: true\neffort: high\nbudget: { per_run_usd: 9 }"));
  const { baseUrl, token } = await serve(t, { faux: FAUX, templates: shipped });
  const report = await evalTemplate({ dir: PKG, cases: ["learned"], server: { baseUrl, token } });
  assert.equal(report.pass, false);
  assert.match(report.cases[0].error, /the server's evalpkg package is not this folder's: it differs in budget, effort, tools/);
});

test("on another server, a need the owner's server fills under another name is this folder's package still: its text is compared on that server's names", { timeout: 300_000 }, async (t) => {
  const shipped = join(await scratch(t), "templates");
  const dir = join(shipped, "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), readFileSync(join(dir, "agent.md"), "utf8").replace("You answer for", "Read a contact with mcp:crm/get_contact. You answer for"));
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: shipped });
  const owner = await startFake("my-crm", readCases(PKG, ["mcp-match"]).cases[0].mcp.crm);
  t.after(() => owner.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/my-crm", { url: owner.url, auth: { type: "none" }, toolkit: "crm" })).status, 200);
  const report = await evalTemplate({ dir, cases: ["learned"], server: { baseUrl, token } });
  assert.equal(report.cases[0].error, undefined, report.cases[0].error);
  assert.equal(report.cases[0].runs.length, 1, JSON.stringify(report.cases[0]));
  const agent = (await api("GET", `/agents/${report.cases[0].runs[0].agent_id}`)).body;
  assert.match(agent.definition.instructions, /mcp:my-crm\/get_contact/, "apply put the need on the owner's server");
});

test("a stop asked after the last run is waited for still stops the eval: no report", { timeout: 300_000 }, async () => {
  const stop = new AbortController();
  // The line for run 1 is told once it is waited for and graded: the last run, so nothing is left to wait on.
  const eval_ = evalTemplate({ dir: PKG, cases: ["learned"], serve: { faux: FAUX }, signal: stop.signal, log: (line) => line.startsWith("case learned run 1:") && stop.abort() });
  await assert.rejects(eval_, { name: "AbortError" });
});

test("graders read the answer as written: the last fenced json block, a target field, and a grader's verdict", () => {
  assert.equal(lastJsonBlock("a\n```json\n{\"a\":1}\n```\nb\n````json\n{\"b\": \"```\"}\n````\n"), '{"b": "```"}');
  assert.equal(lastJsonBlock("```js\n1\n```"), undefined);
  assert.deepEqual(verdictOf('ok\n```json\n{"pass": false, "reason": "no"}\n```'), { pass: false, reason: "no" });
  assert.deepEqual(verdictOf('So {"pass": true, "reason": "fine"} it is.'), { pass: true, reason: "fine" });
  assert.equal(verdictOf('```json\n{"pass": "yes"}\n```'), undefined);
  const record = (answer, extra = {}) => ({ answer, calls: [], mcpCalls: [], files: [], ...extra });
  const regex = { file: "r.md", type: "regex", pattern: "^## Upgrading", flags: "m", expect: "match", target: "draft.text" };
  assert.equal(gradeDeterministic(regex, record('```json\n{"draft": {"text": "x\\n## Upgrading\\n"}}\n```'), []).pass, true);
  assert.match(gradeDeterministic(regex, record('```json\n{"draft": {}}\n```'), []).reason, /has no field draft\.text/);
  assert.match(gradeDeterministic({ ...regex, expect: "no_match" }, record("no json"), []).reason, /has no fenced json block/);
  const used = { file: "t.md", type: "tool_used", tools: ["mcp:crm/update_contact"], expect: "not_called", args: { method: "update" } };
  const calls = { mcpCalls: [{ tool: "mcp:crm/update_contact", arguments: { method: "create", body: "x" } }], calls: [{ tool: "mcp:crm/update_contact" }] };
  assert.equal(gradeDeterministic(used, record("", calls), ["crm"]).pass, true, "the fake's log, with its arguments, for a faked server");
  assert.equal(gradeDeterministic({ ...used, args: { method: "create" } }, record("", calls), ["crm"]).pass, false);
  const fixture = { server: "crm", description: "", tools: { get: { description: "", input: { type: "object" }, answers: [{ when: { id: "7", tags: ["a"] }, result: { content: [{ type: "text", text: "seven" }] } }], default: { content: [{ type: "text", text: "none" }], isError: true } } } };
  assert.equal(fakeAnswer(fixture, "get", { tags: ["a"], id: "7", more: 1 }).content[0].text, "seven", "every listed argument equal, others ignored");
  assert.equal(fakeAnswer(fixture, "get", { id: "7", tags: ["a", "b"] }).content[0].text, "none");
  assert.equal(fakeAnswer(fixture, "nope", {}).isError, true);
});

test("an answer that is one JSON object and nothing else is its json block: for the output, a target and a grader's verdict", () => {
  const schema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
  assert.deepEqual(structuredAnswer('{"verdict": "good"}', schema), { value: { verdict: "good" } });
  assert.deepEqual(structuredAnswer('\n  {"verdict": "good"}\n', schema), { value: { verdict: "good" } }, "trimmed");
  // Not one JSON object alone: prose around it, an array, two objects, or no JSON. Each is still no block.
  for (const answer of ['Here it is: {"verdict": "good"}', '[{"verdict": "good"}]', '{"verdict": "good"}\n{"verdict": "bad"}', "good"]) {
    assert.deepEqual(structuredAnswer(answer, schema), { why: "the answer has no fenced json block" }, answer);
  }
  // A fenced block is read as before, and an answer with one is never read whole.
  assert.deepEqual(structuredAnswer('Done.\n```json\n{"verdict": "fenced"}\n```', schema), { value: { verdict: "fenced" } });
  const record = (answer) => ({ answer, calls: [], mcpCalls: [], files: [] });
  const regex = { file: "r.md", type: "regex", pattern: "^## Upgrading", flags: "m", expect: "match", target: "draft.text" };
  assert.equal(gradeDeterministic(regex, record('{"draft": {"text": "x\\n## Upgrading\\n"}}'), []).pass, true, "a target in a bare object");
  assert.match(gradeDeterministic(regex, record('So {"draft": {"text": "## Upgrading"}}'), []).reason, /has no fenced json block/);
  // A grader's verdict as one object whose reason holds braces: read whole, as the run's answer is.
  assert.deepEqual(verdictOf('{"pass": false, "reason": "the {date} field is empty"}'), { pass: false, reason: "the {date} field is empty" });
  assert.equal(verdictOf('{"pass": "no", "reason": "a {b}"}'), undefined, "an object that is no verdict");
});

test("the output check agrees with ajv on the shipped packages' output schemas", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const p of readPackages(TEMPLATES_DIR)) {
    const check = ajv.compile(p.outputSchema);
    for (const value of [{}, [], null, "x", { findings: [] }]) {
      const ours = "value" in structuredAnswer(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, p.outputSchema);
      assert.equal(ours, check(value), `${p.name}: ${JSON.stringify(value)}`);
    }
  }
});

test("no case carries a schema grader: a package's output schema is held by the server's own verdict on each completed run", async (t) => {
  // The verdict is the run's result.output_error, set after the runner's one retry; a run with none meets the schema.
  const pkg = readPackage(PKG);
  assert.deepEqual(outputVerdict(pkg, { output: { verdict: "good" }, final_answer: "x" }), { grader: "output", type: "output", cost_usd: null, pass: true, reason: "the answer's json meets answer.schema.json" });
  assert.deepEqual(outputVerdict(pkg, { output: null, final_answer: "x", output_error: "the answer has no fenced json block" }), { grader: "output", type: "output", cost_usd: null, pass: false, reason: "the answer misses answer.schema.json: the answer has no fenced json block" });
  assert.equal(outputVerdict({ ...pkg, output: undefined, outputSchema: undefined }, { output: null }), undefined, "a package with no output schema has no output check");
  for (const p of readPackages(TEMPLATES_DIR)) {
    assert.ok(p.output, `${p.name} declares its output schema`);
    for (const one of readCases(join(TEMPLATES_DIR, p.name)).cases) assert.ok(!one.graders.some((g) => g.type === "schema"), `${p.name}/${one.name}`);
  }
  // A schema grader is a type no case takes now.
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  writeFileSync(join(dir, "evals/all-pass/graders/schema.md"), "---\ntype: schema\nschema: answer.schema.json\n---\n");
  assert.throws(() => readCases(dir), (e) => e instanceof PackageError && /evals\/all-pass\/graders\/schema\.md: type is one of llm, regex, tool_used, file_exists, mailbox, handed$/m.test(e.message));
});

test("code-review's cases hold the answer's head_sha to the head the prompt names: an answer naming another sha fails", () => {
  const { cases } = readCases(join(TEMPLATES_DIR, "code-review"));
  for (const one of cases) {
    const head = /head is now ([0-9a-f]{40})/.exec(one.input)?.[1] ?? /\b[0-9a-f]{40}\b/.exec(one.input)?.[0];
    const grader = one.graders.find((g) => g.type === "regex" && g.target === "head_sha");
    assert.ok(head && grader, `${one.name}: a head_sha grader`);
    const answer = (sha) => ({ answer: `\`\`\`json\n${JSON.stringify({ head_sha: sha, findings: [] })}\n\`\`\``, calls: [], mcpCalls: [], files: [] });
    assert.equal(gradeDeterministic(grader, answer(head), []).pass, true, `${one.name}: the prompt's head passes`);
    assert.equal(gradeDeterministic(grader, answer("0".repeat(40)), []).pass, false, `${one.name}: another sha fails`);
    const other = /last_reviewed_sha was ([0-9a-f]{40})/.exec(one.input)?.[1];
    if (other) assert.equal(gradeDeterministic(grader, answer(other), []).pass, false, `${one.name}: the last reviewed sha fails`);
  }
});

test("agentrun-serve eval-template: exit 0 when every case passes, 1 when one fails, 2 when nothing ran; the report as JSON", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  // Each command in a process group of its own, its wait bounded (fixtures/started.mjs).
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "AGENTRUN_API_KEY" && name !== "AGENTRUN_TOKEN")), AGENTRUN_BOXES: "none" };
  const run = async (args) => {
    const { status, out, err } = await ran(t, CLI, ["eval-template", ...args], env, 120_000);
    return { code: status, out, err };
  };
  const passed = await run([PKG, "--case", "learned", "--faux", FAUX, "--report", join(dir, "pass.json")]);
  assert.equal(passed.code, 0, passed.err);
  assert.match(passed.out, /^# Evals: evalpkg 0\.1\.0\n\n1 of 1 case passed\./);
  assert.match(passed.err, /case learned run 1: completed, pass/);
  const report = JSON.parse(readFileSync(join(dir, "pass.json"), "utf8"));
  assert.deepEqual([report.pass, report.cases.map((c) => c.name), report.server], [true, ["learned"], { kind: "in_process" }]);
  // Each run keeps its metrics as its end wrote them (GET /stats over its own agent): its requests, tokens and tool calls.
  const { metrics } = report.cases[0].runs[0];
  assert.ok(metrics && metrics.requests > 0 && metrics.input + metrics.cache_read + metrics.cache_write > 0 && metrics.output > 0, JSON.stringify(metrics));
  assert.equal(metrics.tool_calls, Object.values(metrics.tools).reduce((sum, t) => sum + t.calls, 0));

  // One failing case proves exit 1 and the report; a passing one beside it adds a real run and nothing more.
  const failed = await run([PKG, "--case", "mcp-mismatch", "--runs", "1", "--faux", FAUX, "--report", join(dir, "fail.json")]);
  assert.equal(failed.code, 1, failed.err);
  assert.match(failed.out, /\| mcp-mismatch \| 0\/1 \| \*\*fail\*\* \|/);
  assert.equal(JSON.parse(readFileSync(join(dir, "fail.json"), "utf8")).passed, 0);

  // A Ctrl-C while the held run is in its turn (the file its faux writes says so) cancels it, cleans up and exits 130
  // with no report.
  const holding = join(dir, "holding");
  const { child: held, seen, closed } = started(t, CLI, ["eval-template", PKG, "--case", "held", "--faux", FAUX, "--report", join(dir, "stopped.json")], { ...process.env, AGENTRUN_BOXES: "none", AGENTRUN_TEST_EVAL_HOLD: holding });
  await within(untilFile(holding, closed), 120_000, "the held run reaching its turn", seen);
  assert.ok(existsSync(holding), `the held run reached its turn: ${seen.err}`);
  held.kill("SIGINT");
  const code = await within(closed, 60_000, "eval-template after its SIGINT", seen);
  assert.equal(code, 130, seen.err);
  assert.match(seen.err, /stopping: cancelling the run in progress[\s\S]*stopped; no report\./);
  assert.throws(() => readFileSync(join(dir, "stopped.json")), { code: "ENOENT" });

  // A report path that exists and can't be written: refused before anything runs.
  const readOnly = join(dir, "read-only.json");
  writeFileSync(readOnly, "{}");
  chmodSync(readOnly, 0o444);
  for (const [args, said] of [
    [[PKG, "--case", "nope", "--faux", FAUX], /evals\/nope: no such case \(the package's are all-fail, all-pass, asks, flaky, held, learned, mcp-filed, mcp-match, mcp-mismatch\)/],
    [[PKG, "--runs", "0"], /--runs takes a whole number/],
    [[PKG, "--server", "https://agentrun.invalid", "--faux", FAUX], /--faux is the model of the server it starts itself/],
    [[PKG, "--server", "https://agentrun.invalid"], /--server needs that server's token in AGENTRUN_API_KEY/],
    [[PKG, "--grader-model", "nomodel", "--faux", FAUX], /--grader-model is "provider\/model-id"/],
    [[join(PKG, "evals")], /is not a valid package/],
    [[], /it takes one package folder/],
    [[PKG, "--faux", FAUX, "--report", join(dir, "no-such-folder", "report.json")], /--report's folder .*no-such-folder is not a folder this command can write in/],
    [[PKG, "--faux", FAUX, "--report", readOnly], /--report's folder .* or a file it can't write/],
  ]) {
    const refused = await run(args);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.err}`);
    assert.match(refused.err, said);
    assert.equal(refused.out, "");
  }
});

test("a fake's answer keyed by a list of whens is taken when any one matches; one no answer matches falls to its search, then its default", () => {
  const file = { content: [{ type: "text", text: "the file at abc" }] };
  const fixture = { server: "github", description: "", tools: {
    get_file_contents: { description: "", input: { type: "object" }, answers: [{ when: [{ path: "a.ts", sha: "abc" }, { path: "a.ts", ref: "abc" }, { path: "a.ts", ref: "refs/pull/7/head" }], result: file }], default: { content: [{ type: "text", text: "not here" }], isError: true } },
    search_code: { description: "", input: { type: "object" }, answers: [{ when: { query: "pinned" }, result: { content: [{ type: "text", text: "pinned answer" }] } }],
      search: { query: "query", note: "a subset", limit: 2, files: [{ path: "src/a.ts", text: "export function load(id) {\n  return cache.get(id);\n}\nload(1);\nload(2);" }, { path: "src/b.py", text: "def load(x):\n    return x" }] } },
  } };
  for (const args of [{ path: "a.ts", sha: "abc" }, { path: "a.ts", ref: "abc", owner: "o" }, { path: "a.ts", ref: "refs/pull/7/head" }]) assert.equal(fakeAnswer(fixture, "get_file_contents", args).content[0].text, "the file at abc", JSON.stringify(args));
  assert.equal(fakeAnswer(fixture, "get_file_contents", { path: "a.ts", sha: "def" }).isError, true, "no entry of the list matches");
  assert.equal(fakeAnswer(fixture, "search_code", { query: "pinned" }).content[0].text, "pinned answer", "an answer wins over the search");
  assert.equal(fakeAnswer(fixture, "search_code", { query: "load language:typescript" }).content[0].text, "a subset\n3 matching lines in 1 file (the first 2 shown)\nsrc/a.ts:1: export function load(id) {\nsrc/a.ts:4: load(1);");
  assert.equal(fakeAnswer(fixture, "search_code", { query: '"return x" path:src/' }).content[0].text, "a subset\n1 matching line in 1 file\nsrc/b.py:2: return x");
  assert.equal(fakeAnswer(fixture, "search_code", { query: "/cache\\.get\\(/ NOT nothing-here" }).content[0].text, "a subset\n1 matching line in 1 file\nsrc/a.ts:2: return cache.get(id);");
  assert.match(fakeAnswer(fixture, "search_code", { query: "load NOT cache" }).content[0].text, /^a subset\n1 matching line in 1 file\nsrc\/b\.py:1: def load\(x\):$/);
  assert.match(searched({ query: "q", files: [] }, "anything"), /^0 matching lines in 0 files$/);
});

test("a package's evals/ files are bounded apart from the agent's files: a fixture past 256 KiB loads, one past the eval bound does not", async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const fixture = JSON.parse(readFileSync(join(dir, "evals/mcp-match/fixtures/crm.json"), "utf8"));
  fixture.description = "x".repeat(MAX_FILE_BYTES + 1024);
  writeFileSync(join(dir, "evals/mcp-match/fixtures/crm.json"), JSON.stringify(fixture));
  assert.doesNotThrow(() => readPackage(dir), "an eval fixture over the agent's file limit");
  assert.equal(readCases(dir, ["mcp-match"]).cases[0].mcp.crm.description.length, MAX_FILE_BYTES + 1024);
  writeFileSync(join(dir, "big.md"), "y".repeat(MAX_FILE_BYTES + 1));
  assert.throws(() => readPackage(dir), (e) => e instanceof PackageError && /big\.md: is over \d+ bytes, a package file's limit/.test(e.message), "the agent's own files keep their limit");
  rmSync(join(dir, "big.md"));
  writeFileSync(join(dir, "evals/mcp-match/fixtures/huge.json"), Buffer.alloc(MAX_EVAL_FILE_BYTES + 1, 32));
  assert.throws(() => readPackage(dir), (e) => e instanceof PackageError && /evals\/mcp-match\/fixtures\/huge\.json: is over \d+ bytes, an eval file's limit/.test(e.message));
});

test("a fake search reads /.../ as literal text, so a pattern like /(a+)+$/ answers at once; NOT before a qualifier excludes its files and is spent there", () => {
  const long = "a".repeat(50_000) + "b";
  const search = { query: "query", files: [{ path: "src/load.ts", text: `load(1);\n${long}` }, { path: "tests/load.test.ts", text: "load(2);" }, { path: "docs/x.md", text: "(a+)+$ is a pattern" }] };
  const started = Date.now();
  assert.equal(searched(search, "/(a+)+$/"), "1 matching line in 1 file\ndocs/x.md:1: (a+)+$ is a pattern", "the pattern's text, matched as written");
  assert.ok(Date.now() - started < 1_000, "answered at once");
  assert.equal(searched(search, "/load\\(1\\)/"), "1 matching line in 1 file\nsrc/load.ts:1: load(1);", "an escaped mark is that mark");
  assert.equal(searched(search, "load NOT path:tests"), "1 matching line in 1 file\nsrc/load.ts:1: load(1);", "NOT path: excludes the tests");
  assert.equal(searched(search, "load -path:tests"), searched(search, "load NOT path:tests"), "as -path: does");
  assert.equal(searched(search, "NOT path:docs load"), "2 matching lines in 2 files\nsrc/load.ts:1: load(1);\ntests/load.test.ts:1: load(2);", "the NOT is spent on the qualifier: load is still wanted");
});

test("the answer's schema keeps the agent's file limits when it lives under evals/: it is given to the agent", async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  mkdirSync(join(dir, "skills/answer"), { recursive: true });
  writeFileSync(join(dir, "skills/answer/SKILL.md"), "---\nname: answer\ndescription: Answers.\n---\nAnswer.\n");
  const schema = readFileSync(join(dir, "answer.schema.json"), "utf8");
  const manifest = readFileSync(join(dir, "agent.md"), "utf8").replace("output: { schema: answer.schema.json }", "output: { schema: evals/mcp-match/fixtures/answer.schema.json }");
  writeFileSync(join(dir, "agent.md"), manifest);
  writeFileSync(join(dir, "evals/mcp-match/fixtures/answer.schema.json"), schema);
  const small = readPackage(dir);
  assert.deepEqual(small.outputSchema, JSON.parse(schema), "a small schema under evals/ is the agent's output schema");
  assert.equal(small.skills["answer/answer.schema.json"], undefined, "never copied beside the SKILL.md: the runner gives the model the schema");
  const big = JSON.stringify({ ...JSON.parse(schema), description: "x".repeat(MAX_FILE_BYTES + 1024) });
  writeFileSync(join(dir, "evals/mcp-match/fixtures/answer.schema.json"), big);
  assert.throws(() => readPackage(dir), (e) => e instanceof PackageError && /evals\/mcp-match\/fixtures\/answer\.schema\.json: is over \d+ bytes, a package file's limit: the answer's schema is given to the agent/.test(e.message), "past the agent's file limit, under evals/ too");
  writeFileSync(join(dir, "evals/mcp-match/fixtures/answer.schema.json"), schema);
  // The agent's own files one byte short of the schema's room: each within its limit, and together within POST /v2/agents'.
  let room = MAX_PACKAGE_BYTES - Buffer.byteLength(schema) + 1 - ["agent.md", "answer.schema.json", "skills/answer/SKILL.md"].reduce((sum, path) => sum + statSync(join(dir, path)).size, 0);
  for (let n = 1; room > 0; n++) {
    const size = Math.min(room, MAX_FILE_BYTES);
    writeFileSync(join(dir, `skills/answer/filler${n}.md`), "y".repeat(size));
    room -= size;
  }
  assert.throws(() => readPackage(dir), (e) => e instanceof PackageError && /answer\.schema\.json: takes the agent's files over \d+ bytes together/.test(e.message), "and it counts toward the agent's bytes together");
});

test("template eval metricsOf: a run's metrics from GET /stats?agent=, null whenever the read gives none, never a throw", async () => {
  const stats = (totals, tools = []) => async () => ({ status: 200, body: { analytics: { totals, tools } } });
  const totals = { runs_with_metrics: 1, input: 120, cache_read: 900, cache_write: 40, output: 75, requests: 3, unmetered: 0 };
  // The read asks for the run's own agent, with a signal that bounds it.
  let asked;
  const ok = await metricsOf(async (method, path, body, headers, options) => {
    asked = { method, path, signal: options?.signal instanceof AbortSignal };
    return stats(totals, [{ tool: "read", calls: 4, errors: 1 }, { tool: "bash", calls: 2, errors: 0 }])();
  }, "agt_1");
  assert.deepEqual(asked, { method: "GET", path: "/stats?agent=agt_1", signal: true });
  assert.deepEqual(ok, { input: 120, cache_read: 900, cache_write: 40, output: 75, requests: 3, unmetered: 0, tool_calls: 6, tools: { read: { calls: 4, errors: 1 }, bash: { calls: 2, errors: 0 } } });

  // None kept, a failed answer, a read that throws: null.
  assert.equal(await metricsOf(stats({ ...totals, runs_with_metrics: 0 }), "agt_1"), null);
  assert.equal(await metricsOf(async () => ({ status: 500, body: { error: { message: "boom" } } }), "agt_1"), null);
  assert.equal(await metricsOf(async () => ({ status: 200, body: "not json" }), "agt_1"), null);
  assert.equal(await metricsOf(async () => { throw new Error("the server did not answer"); }, "agt_1"), null);

  // A read that stalls: null once the timeout passes, or as soon as the eval stops. A stalled fake holds no socket and
  // AbortSignal.timeout's timer is unref'd, so a referenced timer keeps the loop alive until both waits end.
  const stalls = async (method, path, body, headers, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  const alive = setInterval(() => {}, 1_000);
  try {
    let started = Date.now();
    assert.equal(await metricsOf(stalls, "agt_1", undefined, 50), null);
    assert.ok(Date.now() - started < 5_000);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped")), 20);
    started = Date.now();
    assert.equal(await metricsOf(stalls, "agt_1", stop.signal, 60_000), null);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    clearInterval(alive);
  }
});
