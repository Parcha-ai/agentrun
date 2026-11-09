// The template eval runner (template-eval.ts, `agentrun-serve eval-template`): a package's eval cases run as real runs of
// its agent on a server and graded by each case's graders. The fixture package (fixtures/templates-eval/evalpkg) has a
// case per behaviour, its agent and its grader played by fixtures/faux-template-eval.mjs: no key, no network. Every
// shipped package's cases are read and their fakes served here too, so a broken case fails CI, never the paid run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";
import { CaseError, evalTemplate, fakeAnswer, gradeDeterministic, lastJsonBlock, markdownReport, readCases, startFake, verdictOf } from "../dist/template-eval.js";
import { PackageError, readPackages, TEMPLATES_DIR } from "../dist/templates.js";
import { scratch, serve } from "./support.mjs";

const FIXTURES = new URL("./fixtures/templates-eval/", import.meta.url).pathname;
const PKG = join(FIXTURES, "evalpkg");
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

// The faux's state, in this file's process (each test file runs in a process of its own), which the runs' processes
// inherit: the flaky case's count, and every input a grader run was given.
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
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
  assert.deepEqual(packages.map((p) => p.name), ["code-review", "inbound-lead", "kyb", "market-monitor", "release-notes"]);
  let count = 0;
  for (const p of packages) {
    const { cases } = readCases(join(TEMPLATES_DIR, p.name));
    assert.deepEqual(cases.map((c) => c.name), p.evals, `${p.name}: every case reads`);
    count += cases.length;
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
  assert.equal(count, 31, "the five packages' cases");
});

test("a case that does not check fails before anything runs, each problem named", async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  write("evals/all-pass/graders/regex.md", "---\ntype: regex\npattern: '(unclosed'\n---\n");
  write("evals/all-pass/graders/wrote.md", "---\ntype: tool_used\ntool: mcp:nowhere/thing\nargs: { id: 1 }\n---\n");
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
    /graders\/wrote\.md: mcp:nowhere\/thing is neither a tool this server binds nor an MCP tool the package lists/, /graders\/wrote\.md: args are checked on a faked MCP tool's calls alone/,
    /learned\/case\.yaml: parameters\.colour: The package evalpkg takes no parameter colour/, /learned\/case\.yaml: learning names "fixtures\/missing\/", not a folder in the case/,
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
  assert.deepEqual(new Set(run.graders.map((g) => g.type)), new Set(["schema", "regex", "tool_used", "file_exists", "llm"]));
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
    assert.match(input, /<tool-calls untrusted>\n1\. write \(notes\/out\.md\) -> success/);
  }
  assert.ok(!plain.includes("SUMMARY-MARKER\".") && !targeted.includes("GOOD-MARKER\"."), "one rubric each");
});

test("a case whose answer fails a grader of every type fails, each failure named in the report", { timeout: 600_000 }, async () => {
  const one = await caseOf("all-fail");
  assert.equal(one.pass, false);
  const [run] = one.runs;
  assert.equal(run.status, "completed", "the run itself went fine: its answer is what fails");
  const failed = Object.fromEntries(run.graders.map((g) => [g.grader, [g.pass, g.reason]]));
  assert.deepEqual(Object.keys(failed).sort(), ["file.md", "llm-target.md", "llm.md", "no-bad.md", "regex.md", "schema.md", "target.md", "wrote.md"]);
  assert.ok(Object.values(failed).every(([pass]) => pass === false), JSON.stringify(failed));
  assert.match(failed["schema.md"][1], /does not meet answer\.schema\.json: \/verdict must be equal to one of the allowed values; \/score must be <= 100/);
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

test("a learned note seeded through the learning API reaches the run", { timeout: 600_000 }, async () => {
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
  assert.deepEqual(report.cases.map((c) => [c.name, c.pass]), [["all-fail", false], ["all-pass", true], ["asks", true], ["flaky", false], ["held", true], ["learned", true], ["mcp-match", true], ["mcp-mismatch", false]]);
  assert.equal(report.passed, 5);
  assert.equal(report.cost_usd.total, Math.round((report.cost_usd.runs + report.cost_usd.graders) * 1e6) / 1e6);
  assert.equal(report.cost_usd.unknown, 0);
});

test("on an owner's server it applies that server's package only when it is this folder's, never replaces an MCP server, and archives what it made", { timeout: 300_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  const server = { baseUrl, token };
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
  assert.equal((await api("GET", "/settings/mcp-servers/crm")).body.url, owner.url, "the owner's entry is untouched");

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
 *  and passes the rest on. Its /v2 address. */
async function refusing(t, baseUrl, refuses) {
  const proxy = createServer(async (req, res) => {
    if (refuses(req)) return void res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"code":"internal","message":"refused by the test proxy"}}');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const answer = await fetch(`${baseUrl.replace(/\/v2$/, "")}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length")), ...(body.length ? { body } : {}) });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (proxy.closeAllConnections(), proxy.close(resolve))));
  return `http://127.0.0.1:${proxy.address().port}/v2`; // key-gate: loopback-rule the test's proxy listens on loopback
}

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

test("a listing of the server's templates that fails once fails that case alone: the next case asks again", { timeout: 300_000 }, async (t) => {
  const { baseUrl, token } = await serve(t, { faux: FAUX, templates: FIXTURES });
  let refused = 0;
  const proxy = await refusing(t, baseUrl, (req) => req.method === "GET" && req.url === "/v2/templates" && refused++ === 0);
  const report = await evalTemplate({ dir: PKG, cases: ["held", "learned"], server: { baseUrl: proxy, token } });
  assert.deepEqual(report.cases.map((c) => [c.name, c.pass]), [["held", false], ["learned", true]], JSON.stringify(report.cases, null, 1));
  assert.match(report.cases[0].error, /^listing the server's templates: 500 refused by the test proxy/);
  assert.equal(refused, 2, "asked once more after the refusal, then kept");
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

test("the schema grader agrees with ajv on the shipped packages' schemas", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const p of readPackages(TEMPLATES_DIR)) {
    const { cases } = readCases(join(TEMPLATES_DIR, p.name));
    const grader = cases.flatMap((c) => c.graders).find((g) => g.type === "schema");
    const check = ajv.compile(JSON.parse(readFileSync(join(TEMPLATES_DIR, p.name, grader.schema), "utf8")));
    for (const value of [{}, [], null, "x", { findings: [] }]) {
      const ours = gradeDeterministic(grader, { answer: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, calls: [], mcpCalls: [], files: [] }, []).pass;
      assert.equal(ours, check(value), `${p.name}: ${JSON.stringify(value)}`);
    }
  }
});

test("agentrun-serve eval-template: exit 0 when every case passes, 1 when one fails, 2 when nothing ran; the report as JSON", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "eval-template", ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "AGENTRUN_API_KEY" && name !== "AGENTRUN_TOKEN")), AGENTRUN_BOXES: "none" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const passed = await run([PKG, "--case", "learned", "--faux", FAUX, "--report", join(dir, "pass.json")]);
  assert.equal(passed.code, 0, passed.err);
  assert.match(passed.out, /^# Evals: evalpkg 0\.1\.0\n\n1 of 1 case passed\./);
  assert.match(passed.err, /case learned run 1: completed, pass/);
  const report = JSON.parse(readFileSync(join(dir, "pass.json"), "utf8"));
  assert.deepEqual([report.pass, report.cases.map((c) => c.name), report.server], [true, ["learned"], { kind: "in_process" }]);

  const failed = await run([PKG, "--case", "mcp-mismatch", "--case", "learned", "--runs", "1", "--faux", FAUX, "--report", join(dir, "fail.json")]);
  assert.equal(failed.code, 1, failed.err);
  assert.match(failed.out, /\| mcp-mismatch \| 0\/1 \| \*\*fail\*\* \|/);
  assert.equal(JSON.parse(readFileSync(join(dir, "fail.json"), "utf8")).passed, 1);

  // A Ctrl-C while the held run is in its turn (the file its faux writes says so) cancels it, cleans up and exits 130
  // with no report.
  const holding = join(dir, "holding");
  const held = spawn(process.execPath, [CLI, "eval-template", PKG, "--case", "held", "--faux", FAUX, "--report", join(dir, "stopped.json")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_BOXES: "none", AGENTRUN_TEST_EVAL_HOLD: holding } });
  let heldErr = "";
  held.stderr.on("data", (chunk) => (heldErr += chunk));
  held.stdout.resume();
  const closed = new Promise((resolve) => held.on("close", resolve));
  await untilFile(holding, closed);
  assert.ok(existsSync(holding), `the held run reached its turn: ${heldErr}`);
  held.kill("SIGINT");
  const code = await closed;
  assert.equal(code, 130, heldErr);
  assert.match(heldErr, /stopping: cancelling the run in progress[\s\S]*stopped; no report\./);
  assert.throws(() => readFileSync(join(dir, "stopped.json")), { code: "ENOENT" });

  // A report path that exists and can't be written: refused before anything runs.
  const readOnly = join(dir, "read-only.json");
  writeFileSync(readOnly, "{}");
  chmodSync(readOnly, 0o444);
  for (const [args, said] of [
    [[PKG, "--case", "nope", "--faux", FAUX], /evals\/nope: no such case/],
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
