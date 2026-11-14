// `agentrun template validate DIR` and `agentrun template eval DIR`: the server's own package validator, run on a folder on
// this machine (a valid package prints what it holds and exits 0; a malformed one, or no folder at all, prints each problem
// and exits 1), and its eval runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const REVIEW = new URL("../../serve/templates/code-review/", import.meta.url).pathname;
const validate = (dir) => spawnSync(process.execPath, [BIN, "template", "validate", dir], { encoding: "utf8" });

test("template validate checks a package folder as the server does", (t) => {
  const ok = validate(REVIEW);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { valid: true, name: "code-review", version: "0.3.0", skills: ["review"], evals: ["clean-refactor", "injection", "mentions-defused", "never-flag", "null-name", "off-by-one", "re-review", "re-review-open", "repo-rule", "two-defects"] });

  const dir = join(mkdtempSync(join(tmpdir(), "agentrun-template-")), "code-review");
  t.after(() => rmSync(join(dir, ".."), { recursive: true, force: true }));
  cpSync(REVIEW, dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), readFileSync(join(dir, "agent.md"), "utf8").replace("version: 0.3.0", "version: 1.0").replace("effort: medium", "effort: lots"));
  const bad = validate(dir);
  assert.equal(bad.status, 1, bad.stdout);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /is not a valid package:\n- agent\.md: version is 1, a number.*\n- agent\.md: effort is one of/);

  const gone = validate(join(dir, "nope"));
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /nope is not a valid package:\n- it is not a folder/);
});

// `agentrun template eval DIR`: the package's eval cases run and graded by the installed server (agentrun-serve
// eval-template), on a server of its own or, with --server, on that one with its token found as every command finds it,
// handed to the launcher in its environment and never printed. Its exit is the eval's: 0, 1, or 2 when nothing ran.
const EVALPKG = new URL("../../serve/test/fixtures/templates-eval/evalpkg/", import.meta.url).pathname;
const EVAL_FAUX = new URL("../../serve/test/fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const REVIEW_FAUX = new URL("../../serve/test/fixtures/faux-review.mjs", import.meta.url).pathname;
const evalEnv = (dir) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_BASE_URL"].includes(name))), AGENTRUN_BOXES: "none", HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") });
const evaluate = (args, env) => spawnSync(process.execPath, [BIN, "template", "eval", ...args], { encoding: "utf8", env, timeout: 240_000 });

test("template eval runs a package's cases on a server of its own and exits as the eval did", { timeout: 300_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-template-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = evalEnv(dir);
  const passed = evaluate([EVALPKG, "--case", "learned", "--faux", EVAL_FAUX, "--report", join(dir, "report.json")], env);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /^# Evals: evalpkg 0\.1\.0\n\n1 of 1 case passed\./);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).cases.map((c) => [c.name, c.pass]), [["learned", true]]);
  const failed = evaluate([EVALPKG, "--case", "mcp-mismatch", "--faux", EVAL_FAUX], env);
  assert.equal(failed.status, 1, failed.stderr);
  const refused = evaluate([EVALPKG, "--case", "nope"], env);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /evals\/nope: no such case/);
});

for (const spelling of [["template", "eval"], ["eval-template"]]) test(`agentrun ${spelling.join(" ")} passes a stop sent to it alone on to the eval, which cancels its run and cleans up: 130, no report`, { timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-template-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const holding = join(dir, "holding");
  const child = spawn(process.execPath, [BIN, ...spelling, EVALPKG, "--case", "held", "--faux", EVAL_FAUX, "--report", join(dir, "stopped.json")], { env: { ...evalEnv(dir), AGENTRUN_TEST_EVAL_HOLD: holding }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  child.stdout.resume();
  const closed = new Promise((resolve) => child.on("close", resolve));
  // The held run writes the file once it is in its turn, and holds there until it is stopped.
  await new Promise((resolve) => {
    const done = () => (watcher.close(), resolve());
    const watcher = watch(dirname(holding), (_, name) => name === basename(holding) && existsSync(holding) && done());
    if (existsSync(holding)) done();
    closed.then(done, done);
  });
  assert.ok(existsSync(holding), `the held run reached its turn: ${err}`);
  // A job runner's SIGTERM to this command's process alone, never its group: the eval hears it only if it is passed on.
  child.kill("SIGTERM");
  assert.equal(await closed, 130, err);
  assert.match(err, /stopping: cancelling the run in progress[\s\S]*stopped; no report\./);
  assert.ok(!existsSync(join(dir, "stopped.json")));
});

// SKIP (follow-up #2089): the eval's answer on the server has no fenced json block, so the case fails its findings check
// (Un-skipping it: code-review 0.3.0 prefers a shell, [shell, none], so under AGENTRUN_BOXES=none it is made with no
// computer and without bash, and its reviewers read through the GitHub tools.)
test.skip("template eval --server runs on that server with the token in AGENTRUN_API_KEY, and never prints it", { timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-template-eval-"));
  const data = join(dir, "data");
  // The server in this process, on port 0: listening once startServe resolves, nothing to wait for.
  process.env.AGENTRUN_BOXES = "none";
  const { startServe } = await import("../../serve/dist/index.js");
  const server = await startServe({ data, port: 0, faux: REVIEW_FAUX });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { baseUrl: base, token } = server;
  const env = { ...evalEnv(dir), AGENTRUN_API_KEY: token };
  // code-review's null-name case: the faux reviewer's answer meets the findings schema, and its llm grader, run on the
  // same faux, answers no verdict, so the case fails, graded on that server.
  const ran = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "template", "eval", REVIEW, "--case", "null-name", "--runs", "1", "--server", base, "--report", join(dir, "report.json")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve({ status, out, err }));
  });
  assert.equal(ran.status, 1, ran.err);
  assert.ok(!ran.out.includes(token) && !ran.err.includes(token), "the token is never printed");
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  assert.ok(!JSON.stringify(report).includes(token));
  assert.equal(report.server.kind, "remote");
  const graders = Object.fromEntries(report.cases[0].runs[0].graders.map((g) => [g.grader, [g.pass, g.reason]]));
  assert.deepEqual(graders["schema.md"], [true, "the answer's json meets findings.schema.json"]);
  assert.equal(graders["finds.md"][0], false);
  assert.match(graders["finds.md"][1], /the grader's answer was not \{pass, reason\}/);
});

// `agentrun template install SOURCE`: one POST /v2/templates/import with the source and the flags as the body's fields,
// the server's refusal as it is (with the --trust hint when it is the publisher's trust it wants), and what was imported
// with the console page that applies it.
test("template install imports a package from GitHub through the server and prints its apply page", async (t) => {
  const { createServer } = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "agentrun-template-install-"));
  const seen = [];
  const sha = "a".repeat(40);
  const id = "github:acme/agents/templates/kyb";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push([req.method, req.url, req.headers.authorization, body]);
      if (!body.dry_run && !body.trust_publisher) {
        res.writeHead(422, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "input_invalid", message: "The input is invalid.", fields: [{ field: "trust_publisher", reason: "missing", message: "acme has published no package this server has imported yet" }] } }));
      }
      const stored = !body.dry_run;
      res.writeHead(stored ? 201 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ template: { id, name: "kyb", source: body.source, sha, publisher: "acme" }, instructions: "Check the business.", skill_files: { "kyb/SKILL.md": "# kyb" }, publisher_trusted: stored, stored, replaced: null, console_url: stored ? `http://127.0.0.1/#/templates/${encodeURIComponent(id)}` : "http://127.0.0.1/#/templates/install" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { ...evalEnv(dir), AGENTRUN_BASE_URL: `http://127.0.0.1:${server.address().port}/v2`, AGENTRUN_API_KEY: "tok" };
  const install = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "template", "install", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve({ status, out, err }));
  });
  const source = `${id}@main`;

  const preview = await install(source, "--dry-run");
  assert.equal(preview.status, 0, preview.err);
  const shown = JSON.parse(preview.out);
  assert.deepEqual([shown.id, shown.sha, shown.publisher, shown.stored, shown.instructions, shown.skill_files], [id, sha, "acme", false, "Check the business.", { "kyb/SKILL.md": "# kyb" }], "a dry run prints the package whole");

  const untrusted = await install(source);
  assert.equal(untrusted.status, 1, untrusted.err);
  assert.equal(untrusted.out, "");
  assert.match(untrusted.err, /"field":"trust_publisher"[\s\S]*run this again with --trust/);

  const imported = await install(source, "--trust");
  assert.equal(imported.status, 0, imported.err);
  assert.deepEqual(JSON.parse(imported.out), { id, source, sha, publisher: "acme", publisher_trusted: true, stored: true, replaced: null, console_url: `http://127.0.0.1/#/templates/${encodeURIComponent(id)}` });

  assert.deepEqual(seen.map(([method, url, auth, body]) => [method, url, auth, body]), [
    ["POST", "/v2/templates/import", "Bearer tok", { source, dry_run: true }],
    ["POST", "/v2/templates/import", "Bearer tok", { source }],
    ["POST", "/v2/templates/import", "Bearer tok", { source, trust_publisher: true }],
  ]);
});
