// `agentrun deploy [AGENT|DIR] --to URL`: a package folder uploaded to another AgentRun (POST /v2/templates/import
// {files}), its plan read (apply with dry_run) and printed, applied once confirmed (--yes off a terminal), and a lock
// written beside it (DIR/.agentrun/deploy.json). The next deploy of the same package is "up to date" and sends nothing
// that writes; a changed one writes revision n+1; a target edited since the lock is refused without --force. A package
// whose keys the target lacks exits 3 with nothing made. `deploy rollback` makes the previous revision current, and
// `deploy delete` removes the agent and the lock. Two real servers on loopback with a faux model: A, where the command
// runs, and B, where it deploys.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "../../serve/test/support.mjs";
import { packageFiles, packageSha256 } from "../lib/deploy.mjs";
import { cli as agentrun, scratch as scratchOf, server as serverOf } from "./support.mjs";

const scratch = () => scratchOf("deploy");
/** A server on DIR/NAME with a faux model (support.mjs server). */
const server = (t, dir, env, name) => serverOf(t, { data: join(dir, name), env, faux: 'export default (context, faux) => faux.message("Nothing changed today.");\n' });
/** The CLI with `extra` on its environment; stdin closed (no terminal). */
const cli = (env, args, extra = {}) => agentrun({ ...env, ...extra }, args);

/** Whether a request to one of this file's fakes is the CLI's, an API request under /v2/. Another process on the machine
 *  may send `GET /` to any new loopback listener: a fake neither counts nor parses it. */
const ours = (req) => req.url.startsWith("/v2/");

/** A loopback proxy in front of `to` that records each API request's method and path: what a deploy sent. */
async function recorder(t, to) {
  const seen = [];
  const target = new URL(to);
  const proxy = createServer((req, res) => {
    if (ours(req)) seen.push(`${req.method} ${req.url}`);
    const out = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on("error", () => res.writeHead(502).end());
    req.pipe(out);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (proxy.closeAllConnections(), proxy.close(resolve))));
  return { base: `http://127.0.0.1:${proxy.address().port}${target.pathname}`, seen };
}

const SKILL = (line = "Say what changed.") => `---
name: check
description: Check what changed and say it in one line.
---
# Check

${line}
`;
// It names its tools (none): a package that names none would get Docker's box, which these servers do not have (a deploy
// of one is refused, below).
const AGENT = ({ name = "pr-alert", extra = [], bare = false } = {}) => `---
name: ${name}
version: 0.1.0
description: Says what changed in the repository today.
budget: { per_run_usd: 1.00 }
${bare ? "" : "tools: []\n"}${extra.join("\n")}
triggers:
  - name: daily
    source: { kind: schedule, cron: "0 8 * * *" }
    target: { kind: start_run, input: { content: "Run the daily check." } }
---
You check what changed. Use your check skill.
`;

/** A package folder named as its manifest; `bare`, one that names no tools. */
function folder(dir, { name = "pr-alert", extra = [], skill, bare = false } = {}) {
  const at = join(dir, name);
  mkdirSync(join(at, "skills", "check"), { recursive: true });
  writeFileSync(join(at, "agent.md"), AGENT({ name, extra, bare }));
  writeFileSync(join(at, "skills", "check", "SKILL.md"), SKILL(skill));
  return at;
}

const WRITES = /^(POST|PUT|PATCH|DELETE) /;

test("agentrun deploy DIR --to B: plan, apply and lock; up to date sends nothing that writes; a changed skill is revision n+1; a target edited since is refused without --force; rollback; delete", { timeout: 300_000 }, async (t) => {
  const { dir, env } = scratch();
  const a = await server(t, dir, env, "a");
  const b = await server(t, dir, env, "b");
  const proxy = await recorder(t, b.base);
  const pkg = folder(dir);
  const lockFile = join(pkg, ".agentrun", "deploy.json");
  const deploy = (...args) => cli(env, ["deploy", ...args, "--data", a.data], { AGENTRUN_API_KEY: b.token });
  const agents = async () => (await b.api("GET", "/agents")).body.agents;

  // Off a terminal, without --yes: the plan is printed, nothing is applied.
  const asked = await deploy(pkg, "--to", proxy.base);
  assert.equal(asked.code, 2, asked.err);
  assert.match(asked.err, /Plan for .*\n[\s\S]*\+ agent\s+pr-alert\s+new[\s\S]*\+ trigger\s+daily\s+schedule/);
  assert.match(asked.err, /--yes/);
  assert.deepEqual(await agents(), []);
  assert.equal(existsSync(lockFile), false);

  const first = await deploy(pkg, "--to", proxy.base, "--yes");
  assert.equal(first.code, 0, first.err);
  const done = first.json();
  assert.equal(done.status, "deployed");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), ["agent_id", "deployed_at", "package_sha256", "revision_id", "target"]);
  assert.deepEqual([lock.target, lock.agent_id, lock.revision_id, lock.package_sha256], [proxy.base, done.agent_id, done.revision_id, done.package_sha256]);
  assert.match(lock.package_sha256, /^[0-9a-f]{64}$/);
  const made = (await b.api("GET", `/agents/${lock.agent_id}`)).body;
  assert.deepEqual([made.revision, made.template.id, made.template.sha], [lock.revision_id, "upload:pr-alert", lock.package_sha256]);
  assert.deepEqual((await b.api("GET", "/triggers")).body.triggers.map((one) => [one.name, one.agent_id ?? one.target?.agent_id]), [["daily", lock.agent_id]]);
  assert.ok(proxy.seen.includes("POST /v2/templates/import"), proxy.seen.join("\n"));

  // The same package again: up to date, and nothing sent writes.
  proxy.seen.length = 0;
  const same = await deploy(pkg, "--yes");
  assert.equal(same.code, 0, same.err);
  assert.equal(same.json().status, "up_to_date");
  assert.match(same.err, /up to date/);
  assert.deepEqual(proxy.seen.filter((line) => WRITES.test(line)), [], proxy.seen.join("\n"));
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}/revisions`)).body.revisions.length, 1);
  // --params is never up to date (the lock holds no parameters): the apply runs, and keeps the revision when they are
  // the ones it already has.
  const params = join(dir, "params.json");
  writeFileSync(params, "{}");
  const given = await deploy(pkg, "--yes", "--params", params);
  assert.equal(given.code, 0, given.err);
  assert.deepEqual([given.json().status, given.json().agent_change, given.json().revision_id], ["deployed", "unchanged", lock.revision_id]);
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}/revisions`)).body.revisions.length, 1);

  // A changed skill: revision n+1 of the same agent.
  writeFileSync(join(pkg, "skills", "check", "SKILL.md"), SKILL("Say what changed, and who changed it."));
  const changed = await deploy(pkg, "--yes");
  assert.equal(changed.code, 0, changed.err);
  const second = changed.json();
  assert.deepEqual([second.status, second.agent_id, second.agent_change], ["deployed", lock.agent_id, "updated"]);
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}/revisions`)).body.revisions.length, 2);
  const lock2 = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.notEqual(lock2.revision_id, lock.revision_id);
  assert.notEqual(lock2.package_sha256, lock.package_sha256);
  assert.match(changed.err, /~ agent\s+pr-alert\s+revise/);

  // Edited on the target since: refused without --force, nothing written; --force replaces the edit.
  const edited = await b.api("PUT", `/agents/${lock.agent_id}/definition`, { definition: { instructions: "Edited in the cloud." } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  writeFileSync(join(pkg, "skills", "check", "SKILL.md"), SKILL("Say what changed, who changed it, and why."));
  proxy.seen.length = 0;
  const refused = await deploy(pkg, "--yes");
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, new RegExp(`was edited on ${proxy.base} since this lock was written; --force to replace`));
  assert.deepEqual(proxy.seen.filter((line) => WRITES.test(line)), [], proxy.seen.join("\n"));
  const forced = await deploy(pkg, "--yes", "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}/revisions`)).body.revisions.length, 4);
  const lock4 = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}`)).body.revision, lock4.revision_id);

  // Rollback: the previous revision current, and the next run runs it.
  const before = (await b.api("GET", `/agents/${lock.agent_id}/revisions`)).body.revisions;
  const previous = before.filter((one) => one.version < before.find((r) => r.revision === lock4.revision_id).version).sort((x, y) => y.version - x.version)[0];
  const back = await cli(env, ["deploy", "rollback", pkg], { AGENTRUN_API_KEY: b.token });
  assert.equal(back.code, 0, back.err);
  assert.equal(back.json().revision_id, previous.revision);
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}`)).body.revision, previous.revision);
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).revision_id, previous.revision);
  const run = await b.api("POST", `/agents/${lock.agent_id}/runs`, { input: { content: "What changed?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal(run.body.revision, previous.revision, "the next run reports the revision rolled back to");
  // The lock can't say which package the restored revision came from, so it names none: deploying the folder (still the
  // package rollback stepped away from) applies it again, never "up to date" with the old revision running.
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).package_sha256, null);
  const again = await deploy(pkg, "--yes");
  assert.equal(again.code, 0, again.err);
  assert.deepEqual([again.json().status, again.json().agent_change], ["deployed", "updated"]);
  assert.notEqual(again.json().revision_id, previous.revision);
  assert.equal((await b.api("GET", `/agents/${lock.agent_id}`)).body.revision, again.json().revision_id);

  // Delete: the agent gone from B, the lock gone from the folder.
  const gone = await cli(env, ["deploy", "delete", pkg, "--yes"], { AGENTRUN_API_KEY: b.token });
  assert.equal(gone.code, 0, gone.err);
  assert.ok([404, 410].includes((await b.api("GET", `/agents/${lock.agent_id}`)).status));
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual((await agents()).map((one) => one.id), []);
  // A's own agents were never touched.
  assert.deepEqual((await a.api("GET", "/agents")).body.agents, []);
});

test("agentrun deploy exits 3 when the target lacks a key the package needs, with nothing made and no lock", { timeout: 180_000 }, async (t) => {
  const { dir, env } = scratch();
  const b = await server(t, dir, env, "b");
  const pkg = folder(dir, { name: "keyed", extra: ["secrets: [PARALLEL_API_KEY]"] });
  const result = await cli(env, ["deploy", pkg, "--to", b.base, "--yes"], { AGENTRUN_API_KEY: b.token });
  assert.equal(result.code, 3, result.err);
  const answer = result.json();
  assert.deepEqual([answer.status, answer.plan.missing_secrets], ["not_runnable", ["PARALLEL_API_KEY"]]);
  assert.match(result.err, /! key\s+PARALLEL_API_KEY\s+missing/);
  assert.match(result.err, /Not runnable yet/);
  assert.deepEqual((await b.api("GET", "/agents")).body.agents, []);
  assert.deepEqual((await b.api("GET", "/triggers")).body.triggers, []);
  assert.equal(existsSync(join(pkg, ".agentrun", "deploy.json")), false);
});

test("agentrun deploy refuses a folder holding a link, a missing --to, and --pause-source on a folder, before it sends anything", { timeout: 60_000 }, async () => {
  const { dir, env } = scratch();
  const pkg = folder(dir);
  const extra = { AGENTRUN_API_KEY: "not-a-secret" };
  const none = await cli(env, ["deploy", pkg], extra);
  assert.equal(none.code, 2, none.err);
  assert.match(none.err, /--to URL/);
  const paused = await cli(env, ["deploy", pkg, "--to", "http://127.0.0.1:9/v2", "--pause-source"], extra);
  assert.equal(paused.code, 2, paused.err);
  assert.match(paused.err, /--pause-source is for an agent deployed from an install/);
  symlinkSync("/etc/hostname", join(pkg, "skills", "check", "host.md"));
  const linked = await cli(env, ["deploy", pkg, "--to", "http://127.0.0.1:9/v2", "--yes"], extra);
  assert.equal(linked.code, 2, linked.err);
  assert.match(linked.err, /skills\/check\/host\.md is a symbolic link: a package holds files and folders alone/);
});

test("agentrun deploy AGENT_ID: an agent of this install goes to another by its export, the export's sha256 is what the upload and the lock carry, and --pause-source turns its schedules off here", { timeout: 300_000 }, async (t) => {
  const { dir, env } = scratch();
  const a = await server(t, dir, env, "a");
  const b = await server(t, dir, env, "b");
  // The agent on A: a package applied there, its daily schedule on.
  const files = [["agent.md", AGENT({})], ["skills/check/SKILL.md", SKILL()]].map(([path, content]) => ({ path, encoding: "utf8", content }));
  const imported = await a.api("POST", "/templates/import", { files });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const made = await a.api("POST", `/templates/${encodeURIComponent(imported.body.template.id)}/apply`, { parameters: {} });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agentId = made.body.agent_id;
  const exported = await a.api("GET", `/agents/${agentId}/package`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const daily = async () => (await a.api("GET", "/triggers")).body.triggers.find((one) => one.name === "daily" && (one.agent_id ?? one.target?.agent_id) === agentId);
  assert.equal((await daily()).enabled, true);
  const deploy = (...args) => cli(env, ["deploy", agentId, "--to", b.base, ...args, "--data", a.data], { AGENTRUN_API_KEY: b.token });

  const first = await deploy("--yes");
  assert.equal(first.code, 0, first.err);
  const done = first.json();
  assert.equal(done.status, "deployed");
  assert.match(first.err, /still run on .*each fires in both places/);
  // One digest: the export's sha256 is the upload's sha on B and the lock's package_sha256.
  assert.equal(done.package_sha256, exported.body.sha256);
  const there = (await b.api("GET", `/agents/${done.agent_id}`)).body;
  assert.deepEqual([there.template.id, there.template.sha], ["upload:pr-alert", exported.body.sha256]);
  // The lock is the CLI's own file, one per install and agent.
  const config = join(dir, ".config", "agentrun");
  const locks = readdirSync(config).filter((name) => /^deploy\.[0-9a-f]{16}\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(config, name), "utf8")));
  assert.deepEqual(locks.map((lock) => [lock.target, lock.agent_id, lock.package_sha256]), [[b.base, done.agent_id, exported.body.sha256]]);
  assert.equal((await daily()).enabled, true, "without --pause-source the schedule stays on here");

  // Up to date, and --pause-source still turns the schedule off here.
  const paused = await deploy("--yes", "--pause-source");
  assert.equal(paused.code, 0, paused.err);
  assert.equal(paused.json().status, "up_to_date");
  assert.match(paused.err, /Paused daily/);
  assert.equal((await daily()).enabled, false);

  // An agent this install does not have is refused as given, nothing sent.
  const missing = await cli(env, ["deploy", "agent_nope", "--to", b.base, "--yes", "--data", a.data], { AGENTRUN_API_KEY: b.token });
  assert.equal(missing.code, 2, missing.err);
  assert.match(missing.err, /does not export agent_nope/);
});

/** An answer that sends a 200's headers and the first byte of a longer body, then closes the connection. */
const DROPPED = Symbol("dropped");

/** A target that answers each "METHOD path" (under /v2) with `answers[key]` ([status, body], or DROPPED), else 404; the
 *  requests it saw, and each one's body by its key (`bodies`). */
async function fakeTarget(t, answers) {
  const seen = [];
  const bodies = {};
  const fake = createServer((req, res) => {
    if (!ours(req)) return void res.writeHead(404).end();
    const key = `${req.method} ${req.url.replace(/^\/v2/, "")}`;
    seen.push(key);
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      if (text) bodies[key] = JSON.parse(text);
      // The request read whole first, so the close is the body's end (a FIN after the byte), never a reset.
      if (answers[key] === DROPPED) return void res.writeHead(200, { "content-type": "application/json", "content-length": "64" }).write("{", () => res.socket.destroy());
      const [status, body] = answers[key] ?? [404, { error: { code: "not_found", message: "Not found." } }];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (fake.closeAllConnections(), fake.close(resolve))));
  return { base: `http://127.0.0.1:${fake.address().port}/v2`, seen, bodies };
}

test("a folder's upload is its package alone: agent.md, skills/, rules/, evals/ and the answer's schema the manifest names at its root, never a .env, a key, a README or another folder beside them, nor a hidden file or folder inside them; no agent.md is refused with nothing sent; deploy delete removes the upload with its agent", { timeout: 180_000 }, async (t) => {
  const { dir, env } = scratch();
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  const fake = await fakeTarget(t, {});
  // A project folder with no agent.md: refused before anything is read or sent.
  const project = join(dir, "project");
  mkdirSync(join(project, "skills"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# project\n");
  const none = await cli(env, ["deploy", project, "--to", fake.base, "--yes"], key);
  assert.equal(none.code, 2, none.err);
  assert.match(none.err, /has no agent\.md: a package is a folder with agent\.md/);
  assert.deepEqual(fake.seen, [], "nothing sent");

  const pkg = folder(dir, { extra: ["output: { schema: answer.schema.json }"] });
  mkdirSync(join(pkg, "rules"));
  writeFileSync(join(pkg, "rules", "STYLE.md"), "Keep it short.\n");
  mkdirSync(join(pkg, "evals", "today", "graders"), { recursive: true });
  writeFileSync(join(pkg, "evals", "today", "prompt.md"), "What changed today?\n");
  writeFileSync(join(pkg, "evals", "today", "graders", "says.md"), "---\ntype: llm\n---\nPass if it says what changed.\n");
  writeFileSync(join(pkg, "answer.schema.json"), `${JSON.stringify({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] })}\n`);
  writeFileSync(join(pkg, ".env"), "PARALLEL_API_KEY=not-a-secret\n");
  // A hidden file or folder inside a tree stays here too: a skill folder's .env would become part of the agent.
  writeFileSync(join(pkg, "skills", "check", ".env"), "PARALLEL_API_KEY=not-a-secret\n");
  writeFileSync(join(pkg, "skills", "check", ".DS_Store"), "\0\0\0\x01Bud1");
  mkdirSync(join(pkg, "evals", "today", ".cache"));
  writeFileSync(join(pkg, "evals", "today", ".cache", "token"), "not-a-secret\n");
  writeFileSync(join(pkg, "key.pem"), "not-a-secret\n");
  writeFileSync(join(pkg, "README.md"), "# pr-alert\n");
  mkdirSync(join(pkg, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(pkg, "node_modules", "left-pad", "index.js"), "module.exports = {};\n");
  const first = await cli(env, ["deploy", pkg, "--to", fake.base, "--yes"], key);
  const sent = fake.bodies["POST /templates/import"]?.files?.map((file) => file.path);
  assert.deepEqual(sent, ["agent.md", "answer.schema.json", "evals/today/graders/says.md", "evals/today/prompt.md", "rules/STYLE.md", "skills/check/SKILL.md"], fake.seen.join("\n"));
  // Each hidden path left out is said by name, a hidden folder once, before anything is sent; never what one holds.
  assert.match(first.err, /Left out, hidden: \.env, evals\/today\/\.cache\/, skills\/check\/\.DS_Store, skills\/check\/\.env\n/, first.err);
  assert.ok(!first.err.includes("not-a-secret"), first.err);
  // agent.md naming a hidden file at the root as the answer's schema: said left out, and not sent (the target refuses
  // such a package in its own words).
  const dotted = folder(dir, { name: "dotted", extra: ["output: { schema: .answer.json }"] });
  writeFileSync(join(dotted, ".answer.json"), "{}\n");
  const hiddenSchema = await cli(env, ["deploy", dotted, "--to", fake.base, "--yes"], key);
  assert.match(hiddenSchema.err, /Left out, hidden: \.answer\.json\n/, hiddenSchema.err);
  assert.deepEqual(fake.bodies["POST /templates/import"]?.files?.map((file) => file.path), ["agent.md", "skills/check/SKILL.md"], "sent to the target without its hidden schema");
  // A schema named in another folder is not sent, nor anything of that folder: the target takes no folder but skills/,
  // rules/ and evals/, and refuses such a package in its own words.
  const nested = folder(dir, { name: "nested", extra: ["output: { schema: schemas/answer.schema.json }"] });
  mkdirSync(join(nested, "schemas"));
  writeFileSync(join(nested, "schemas", "answer.schema.json"), "{}\n");
  writeFileSync(join(nested, "schemas", "draft.schema.json"), "{}\n");
  await cli(env, ["deploy", nested, "--to", fake.base, "--yes"], key);
  assert.deepEqual(fake.bodies["POST /templates/import"]?.files?.map((file) => file.path), ["agent.md", "skills/check/SKILL.md"], "sent to the target without the other folder");

  // A real target takes it whole (its answer's schema read from the root), and deploy delete leaves no upload there.
  const b = await server(t, dir, env, "b");
  const uploads = async () => (await b.api("GET", "/templates")).body.templates.filter((one) => !one.bundled).map((one) => one.id);
  const done = await cli(env, ["deploy", pkg, "--to", b.base, "--yes"], { AGENTRUN_API_KEY: b.token });
  assert.equal(done.code, 0, done.err);
  const made = (await b.api("GET", `/agents/${done.json().agent_id}`)).body;
  assert.deepEqual(made.definition.output_schema?.required, ["summary"], JSON.stringify(made.definition));
  assert.deepEqual(await uploads(), ["upload:pr-alert"]);
  const gone = await cli(env, ["deploy", "delete", pkg, "--yes"], { AGENTRUN_API_KEY: b.token });
  assert.equal(gone.code, 0, gone.err);
  assert.deepEqual(await uploads(), [], "the upload went with the only agent applied from it");
});

test("deploy delete takes a 404 as gone only when the agent is not there: a target that did not archive or delete it keeps the lock and exits 2", { timeout: 60_000 }, async (t) => {
  const AGENT_ID = "agt_kept";
  const there = [200, { agent_id: AGENT_ID, name: "pr-alert", revision: "rev_1", archived: false }];
  const gone = [404, { error: { code: "not_found", message: "Not found." } }];
  const archived = [200, { agent_id: AGENT_ID, archived: true }];
  const cases = [
    { name: "archive 404, agent there", answers: { [`GET /agents/${AGENT_ID}`]: there }, code: 2, kept: true },
    { name: "archive 404, agent gone", answers: { [`GET /agents/${AGENT_ID}`]: gone }, code: 0, kept: false },
    { name: "delete 404, agent there", answers: { [`POST /agents/${AGENT_ID}/archive`]: archived, [`GET /agents/${AGENT_ID}`]: there }, code: 2, kept: true },
    { name: "delete 404, agent gone", answers: { [`POST /agents/${AGENT_ID}/archive`]: archived, [`GET /agents/${AGENT_ID}`]: gone }, code: 0, kept: false },
  ];
  for (const one of cases) {
    const { dir, env } = scratch();
    const pkg = folder(dir);
    const target = await fakeTarget(t, one.answers);
    const lockFile = join(pkg, ".agentrun", "deploy.json");
    mkdirSync(join(pkg, ".agentrun"), { recursive: true });
    writeFileSync(lockFile, `${JSON.stringify({ target: target.base, agent_id: AGENT_ID, revision_id: "rev_1", package_sha256: null, deployed_at: new Date().toISOString() })}\n`);
    const result = await cli(env, ["deploy", "delete", pkg, "--to", target.base, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
    assert.equal(result.code, one.code, `${one.name}: ${result.err}\n${target.seen.join("\n")}`);
    assert.equal(existsSync(lockFile), one.kept, `${one.name}: the lock ${one.kept ? "is kept" : "is removed"}`);
    if (one.kept) assert.match(result.err, new RegExp(`did not (archive|delete) ${AGENT_ID}; nothing was deleted`), one.name);
    else assert.match(result.err, /Deleted/, one.name);
  }
});

test("a target that does not offer an upload says so as every command's refusal does: its 501 printed as the unsupported error, exit 5", { timeout: 60_000 }, async (t) => {
  const { dir, env } = scratch();
  const pkg = folder(dir);
  const target = await fakeTarget(t, { "POST /templates/import": [501, { error: { message: "Uploads are off here.", capability: "template_uploads" } }] });
  const result = await cli(env, ["deploy", pkg, "--to", target.base, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
  assert.equal(result.code, 5, result.err);
  assert.deepEqual(JSON.parse(result.err.trim().split("\n").at(-1)), { error: { message: "Uploads are off here.", capability: "template_uploads", code: "unsupported_here", status: 501 } });
  assert.equal(existsSync(join(pkg, ".agentrun", "deploy.json")), false);
});

/** watch: a feed trigger whose feeds are a parameter left empty by default, so an apply skips it. */
const WATCH = `---
name: watch
version: 0.1.0
description: Watches vendors' status feeds.
budget: { per_run_usd: 0.25 }
tools: []
parameters:
  status_feeds: { type: array, items: { type: string }, required: false, default: [], description: "each vendor's status feed" }
triggers:
  - name: status
    source: { kind: feed, urls: "\${parameters.status_feeds}", every_s: 14400 }
    target: { kind: start_run, input: { content: "Say what changed." } }
---
Say what changed.
`;

test("a deploy whose apply skipped a trigger names no package in its lock: the same files are applied again, never up to date, so the trigger is made once it can be", { timeout: 180_000 }, async (t) => {
  const { dir, env } = scratch();
  const b = await server(t, dir, env, "b");
  const pkg = folder(dir, { name: "watch" });
  writeFileSync(join(pkg, "agent.md"), WATCH);
  const key = { AGENTRUN_API_KEY: b.token };
  const first = await cli(env, ["deploy", pkg, "--to", b.base, "--yes"], key);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /Not made on .* yet: status/);
  assert.equal(JSON.parse(readFileSync(join(pkg, ".agentrun", "deploy.json"), "utf8")).package_sha256, null, "the lock vouches for no package");
  const again = await cli(env, ["deploy", pkg, "--yes"], key);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual([again.json().status, again.json().agent_id], ["deployed", first.json().agent_id], "applied again to the same agent");
});

test("one command at a time per source: a deploy, rollback or delete of a folder another process holds exits 2 with nothing sent; a hold left by an ended process is taken", { timeout: 60_000 }, async (t) => {
  const target = await fakeTarget(t, {});
  const { dir, env } = scratch();
  const pkg = folder(dir);
  // A hold is a folder holding one file named for its process.
  const held = join(pkg, ".agentrun", "deploy.json.held");
  mkdirSync(held, { recursive: true });
  const live = `${hostname()}-${process.pid}`;
  writeFileSync(join(held, live), "");
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  for (const args of [["deploy", pkg, "--to", target.base, "--yes"], ["deploy", "rollback", pkg, "--to", target.base], ["deploy", "delete", pkg, "--to", target.base, "--yes"]]) {
    const refused = await cli(env, args, key);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.err}`);
    assert.match(refused.err, new RegExp(`Another agentrun deploy of this source is running \\(process ${process.pid}\\)`));
  }
  assert.deepEqual(target.seen, [], "nothing sent");
  assert.deepEqual(readdirSync(held), [live], "another's hold is kept");
  const ended = spawnSync(process.execPath, ["-e", ""]).pid;
  rmSync(join(held, live));
  writeFileSync(join(held, `${hostname()}-${ended}`), "");
  const taken = await cli(env, ["deploy", pkg, "--to", target.base, "--yes"], key);
  assert.ok(target.seen.includes("POST /templates/import"), `the deploy went on: ${taken.err}`);
  assert.equal(existsSync(join(pkg, ".agentrun")), false, "let go of when the command ended");
});

/** A target that holds each API request's 404 until `release()` (each one after that is answered at once), counting the
 *  ones in flight at once (`most`, `now`). `reached` settles at its first request; `changed` is called at each. */
async function slowTarget(t) {
  const waiting = [];
  let reach;
  let open = false;
  const answer = (res) => res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
  const state = { seen: [], most: 0, now: 0, reached: new Promise((resolve) => (reach = resolve)), changed: () => {} };
  const fake = createServer((req, res) => {
    if (!ours(req)) return void res.writeHead(404).end();
    state.seen.push(`${req.method} ${req.url.replace(/^\/v2/, "")}`);
    state.most = Math.max(state.most, ++state.now);
    req.resume();
    res.on("close", () => state.now--);
    if (open) return answer(res);
    waiting.push(res);
    reach();
    state.changed();
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (fake.closeAllConnections(), fake.close(resolve))));
  const release = () => {
    open = true;
    for (const res of waiting.splice(0)) answer(res);
  };
  return Object.assign(state, { release, base: `http://127.0.0.1:${fake.address().port}/v2` });
}

test("a hold is let go of only by its owner: a command that ends removes its own file, never a hold another process has made in its place", { timeout: 60_000 }, async (t) => {
  const slow = await slowTarget(t);
  const { dir, env } = scratch();
  const pkg = folder(dir);
  const held = join(pkg, ".agentrun", "deploy.json.held");
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  const running = cli(env, ["deploy", pkg, "--to", slow.base, "--yes"], key);
  // At the target, so holding: its file replaced by another live process's before it ends.
  await slow.reached;
  const [theirs] = readdirSync(held);
  assert.ok(theirs.startsWith(`${hostname()}-`), theirs);
  rmSync(join(held, theirs));
  const live = `${hostname()}-${process.pid}`;
  writeFileSync(join(held, live), "");
  slow.release();
  const ended = await running;
  assert.equal(ended.code, 1, ended.err);
  assert.deepEqual(readdirSync(held), [live], "the ended command removed only its own");
  const refused = await cli(env, ["deploy", pkg, "--to", slow.base, "--yes"], key);
  assert.equal(refused.code, 2, refused.err);
});

test("commands racing to take a hold left by an ended process never overlap: at most one is at the target at a time, and each lets go", { timeout: 120_000 }, async (t) => {
  const slow = await slowTarget(t);
  const { dir, env } = scratch();
  const pkg = folder(dir);
  const held = join(pkg, ".agentrun", "deploy.json.held");
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, `${hostname()}-${spawnSync(process.execPath, ["-e", ""]).pid}`), "");
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  const running = Array.from({ length: 8 }, () => cli(env, ["deploy", pkg, "--to", slow.base, "--yes"], key));
  // The target answers only once each command has ended or is there: the one holding waits at the target while every
  // other one ends, so two holding at once would both be there.
  let exited = 0;
  await new Promise((resolve) => {
    const settled = () => exited + slow.now === running.length && resolve();
    slow.changed = settled;
    for (const one of running) one.then(() => (exited++, settled()));
  });
  slow.release();
  const ended = await Promise.all(running);
  for (const one of ended) assert.ok(one.code === 1 || one.code === 2, `the target's 404, or refused: ${one.code} ${one.err}`);
  assert.ok(slow.seen.length >= 1, "the ended process's hold was taken");
  assert.equal(slow.most, 1, "never two at the target at once");
  assert.equal(ended.filter((one) => one.code === 2).length, running.length - 1, "every other one refused while it held");
  assert.equal(existsSync(join(pkg, ".agentrun")), false, "each let go");
});

test("a folder whose .agentrun, or its deploy.json, is a symbolic link is refused with nothing sent: deploy, rollback and delete never act on another folder's lock", { timeout: 60_000 }, async (t) => {
  const target = await fakeTarget(t, {});
  const { dir, env } = scratch();
  const other = folder(dir, { name: "other" });
  mkdirSync(join(other, ".agentrun"));
  const otherLock = `${JSON.stringify({ target: target.base, agent_id: "agt_other", revision_id: "rev_1", package_sha256: null, deployed_at: new Date().toISOString() })}\n`;
  writeFileSync(join(other, ".agentrun", "deploy.json"), otherLock);
  const pkg = folder(dir);
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  const each = async (linked) => {
    for (const args of [["deploy", pkg, "--to", target.base, "--yes"], ["deploy", "rollback", pkg, "--to", target.base], ["deploy", "delete", pkg, "--to", target.base, "--yes"]]) {
      const refused = await cli(env, args, key);
      assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.err}`);
      assert.match(refused.err, new RegExp(`${linked} is a symbolic link`));
    }
    assert.deepEqual(target.seen, [], "nothing sent");
    assert.equal(readFileSync(join(other, ".agentrun", "deploy.json"), "utf8"), otherLock, "the other folder's lock is as it was");
  };
  symlinkSync(join(other, ".agentrun"), join(pkg, ".agentrun"));
  await each("\\.agentrun");
  rmSync(join(pkg, ".agentrun"));
  mkdirSync(join(pkg, ".agentrun"));
  symlinkSync(join(other, ".agentrun", "deploy.json"), join(pkg, ".agentrun", "deploy.json"));
  await each("\\.agentrun/deploy\\.json");
});

test("a folder's lock that names an address this CLI never deployed to gets no key: deploy, rollback and delete exit 2 with nothing sent, until --to names it; AgentRun cloud is trusted", { timeout: 60_000 }, async (t) => {
  const AGENT_ID = "agt_planted";
  const target = await fakeTarget(t, { [`GET /agents/${AGENT_ID}`]: [404, { error: { code: "not_found", message: "Not found." } }] });
  const plant = (pkg) => {
    mkdirSync(join(pkg, ".agentrun"), { recursive: true });
    writeFileSync(join(pkg, ".agentrun", "deploy.json"), `${JSON.stringify({ target: target.base, agent_id: AGENT_ID, revision_id: "rev_1", package_sha256: null, deployed_at: new Date().toISOString() })}\n`);
  };
  const { dir, env } = scratch();
  const pkg = folder(dir);
  plant(pkg);
  const key = { AGENTRUN_API_KEY: "not-a-secret" };
  for (const args of [["deploy", pkg, "--yes"], ["deploy", "rollback", pkg], ["deploy", "delete", pkg, "--yes"]]) {
    const refused = await cli(env, args, key);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.err}`);
    assert.match(refused.err, new RegExp(`names ${target.base} as its target, an address this CLI has not deployed to: pass --to ${target.base}`));
    assert.deepEqual(target.seen, [], `${args.join(" ")} sent nothing`);
  }
  // Named by --to, it is sent to (the agent is gone there, so the delete removes the lock).
  const named = await cli(env, ["deploy", "delete", pkg, "--to", target.base, "--yes"], key);
  assert.equal(named.code, 0, named.err);
  assert.ok(target.seen.length > 0);
  // A lock naming AgentRun cloud (AGENTRUN_CLOUD_URL here) needs no --to.
  target.seen.length = 0;
  const other = scratch();
  const cloudy = folder(other.dir);
  plant(cloudy);
  const cloud = await cli(other.env, ["deploy", "delete", cloudy, "--yes"], { ...key, AGENTRUN_CLOUD_URL: target.base });
  assert.equal(cloud.code, 0, cloud.err);
  assert.ok(target.seen.length > 0);
});

test("--to names a target: cloud is api.agentrun.ai (AGENTRUN_CLOUD_URL overrides it), /v2 appended where the path lacks it; deploy refuses one that is no base URL before it sends anything", { timeout: 60_000 }, async () => {
  const { CLOUD_URL, toUrl } = await import("../lib/target.mjs");
  assert.equal(CLOUD_URL, "https://api.agentrun.ai");
  assert.equal(toUrl("cloud", {}), "https://api.agentrun.ai/v2");
  assert.equal(toUrl("cloud", { AGENTRUN_CLOUD_URL: "https://staging.example.test/v2/" }), "https://staging.example.test/v2");
  assert.equal(toUrl("http://127.0.0.1:7340", {}), "http://127.0.0.1:7340/v2");
  assert.equal(toUrl("https://agents.example.test/", {}), "https://agents.example.test/v2");
  assert.equal(toUrl("https://agents.example.test/v2/", {}), "https://agents.example.test/v2");
  assert.equal(toUrl("https://agents.example.test/api", {}), "https://agents.example.test/api/v2");
  const { dir, env } = scratch();
  const pkg = folder(dir);
  // A URL with a user and password, made here rather than written out.
  const withUser = Object.assign(new URL("https://example.test"), { username: "user", password: "pw" }).href;
  for (const bad of ["ftp://example.test", withUser, "https://example.test/v2?x=1", "nope"]) {
    const refused = await cli(env, ["deploy", pkg, "--to", bad, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
    assert.equal(refused.code, 2, `${bad}: ${refused.err}`);
    assert.match(refused.err, /--to must be an http or https URL/, bad);
    assert.doesNotMatch(refused.err, /pw/, "the URL is never echoed");
  }
});

/** An API-only AgentRun (AGENTRUN_API_ONLY=1, as a hosted install runs) in this process, no runner. */
const apiOnly = (t) => serve(t, { runner: false, apiOnly: true });

/** pr-alert with a webhook trigger beside its daily schedule. */
const HOOKED = AGENT({}).replace("---\nYou check", `  - name: inbound
    source: { kind: webhook }
    target: { kind: start_run, input: { content: "A push arrived." } }
---
You check`);

test("agentrun deploy DIR to an API-only install with its token: the upload, plan and apply make the agent, each trigger it can't make is printed as skipped with its reason, and rollback and delete work there", { timeout: 180_000 }, async (t) => {
  const { dir, env } = scratch();
  const hosted = await apiOnly(t);
  const pkg = folder(dir);
  writeFileSync(join(pkg, "agent.md"), HOOKED);
  const lockFile = join(pkg, ".agentrun", "deploy.json");
  const key = { AGENTRUN_API_KEY: hosted.token };

  const first = await cli(env, ["deploy", pkg, "--to", hosted.baseUrl, "--yes"], key);
  assert.equal(first.code, 0, first.err);
  const done = first.json();
  assert.equal(done.status, "deployed");
  const made = await hosted.api("GET", `/agents/${done.agent_id}`);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual([made.body.revision, made.body.template.id], [done.revision_id, "upload:pr-alert"]);
  // Neither trigger is made there, and the plan says each, with the server's reason.
  assert.match(first.err, /! trigger\s+daily\s+schedule skipped: The pr-alert template's trigger daily \(schedule\) was not made: this server serves the run API only \(AGENTRUN_API_ONLY=1\) and has no launch hook/);
  assert.match(first.err, /! trigger\s+inbound\s+webhook skipped: The pr-alert template's trigger inbound \(webhook\) was not made: this server serves the run API only \(AGENTRUN_API_ONLY=1\), which serves no route or setting a webhook trigger needs/);
  assert.deepEqual(await hosted.store.triggers.list(done.agent_id), [], "no trigger made there");
  // And stdout's answer says the same: each skipped trigger is a warning with its reason.
  const skipped = done.warnings.filter((one) => one.field.startsWith("triggers.")).map((one) => [one.field, one.reason, one.message.match(/trigger (\w+) \((\w+)\) was not made/)?.slice(1)]);
  assert.deepEqual(skipped, [["triggers.0", "not_set_up_here", ["daily", "schedule"]], ["triggers.1", "not_an_option", ["inbound", "webhook"]]]);
  // The plan names each skip's code: not_set_up_here for one this install makes once it is set up (a launch hook),
  // not_an_option for one it never makes.
  const planned = await hosted.api("POST", "/templates/upload%3Apr-alert/apply", { dry_run: true });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.action, one.code]), [["daily", "skip", "not_set_up_here"], ["inbound", "skip", "not_an_option"]]);

  // A changed skill is the agent's next revision there, and rollback makes the first current again.
  writeFileSync(join(pkg, "skills", "check", "SKILL.md"), SKILL("Say what changed, and who changed it."));
  const changed = await cli(env, ["deploy", pkg, "--yes"], key);
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual([changed.json().agent_id, changed.json().agent_change], [done.agent_id, "updated"]);
  const back = await cli(env, ["deploy", "rollback", pkg], key);
  assert.equal(back.code, 0, back.err);
  assert.equal(back.json().revision_id, done.revision_id);
  assert.equal((await hosted.api("GET", `/agents/${done.agent_id}`)).body.revision, done.revision_id);

  // Delete: archived, then deleted there, and the lock gone here.
  const gone = await cli(env, ["deploy", "delete", pkg, "--yes"], key);
  assert.equal(gone.code, 0, gone.err);
  assert.equal((await hosted.api("GET", `/agents/${done.agent_id}`)).status, 410);
  assert.equal(existsSync(lockFile), false);
});

/** pr-alert whose one trigger is a webhook, which an API-only install never makes. */
const WEBHOOK_ONLY = HOOKED.replace(`  - name: daily
    source: { kind: schedule, cron: "0 8 * * *" }
    target: { kind: start_run, input: { content: "Run the daily check." } }
`, "");

test("agentrun deploy DIR to an API-only install of a package whose one trigger is a webhook: the trigger is said skipped, never \"not made yet\", and the next deploy of the same package is up to date and sends nothing that writes", { timeout: 180_000 }, async (t) => {
  const { dir, env } = scratch();
  const hosted = await apiOnly(t);
  const proxy = await recorder(t, hosted.baseUrl);
  const pkg = folder(dir);
  writeFileSync(join(pkg, "agent.md"), WEBHOOK_ONLY);
  const key = { AGENTRUN_API_KEY: hosted.token };

  const first = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes"], key);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /! trigger\s+inbound\s+webhook skipped: .*serves no route or setting a webhook trigger needs/);
  assert.doesNotMatch(first.err, /Not made on/, "a trigger this install never makes is not one it makes later");
  assert.match(first.json().package_sha256 ?? "", /^[0-9a-f]{64}$/, "the lock names the package");

  const sent = proxy.seen.length;
  const again = await cli(env, ["deploy", pkg, "--yes"], key);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json().status, "up_to_date", again.err);
  assert.deepEqual(proxy.seen.slice(sent).filter((one) => WRITES.test(one)), [], "no upload, no apply");
  assert.doesNotMatch(again.err, /Not made on/);
});

test("agentrun deploy with no lock for a target that has an agent made from the package with these parameters: exit 2, nothing applied, naming it; --agent ID deploys onto it, --agent new makes another; with a lock, --agent naming another agent is refused", { timeout: 300_000 }, async (t) => {
  const { dir, env } = scratch();
  const target = await serve(t, { runner: false });
  const proxy = await recorder(t, target.baseUrl);
  const pkg = folder(dir);
  const lockFile = join(pkg, ".agentrun", "deploy.json");
  const key = { AGENTRUN_API_KEY: target.token };
  const applies = (from) => proxy.seen.slice(from).filter((one) => /^POST \/v2\/templates\/[^/]+\/apply$/.test(one)).length;
  const agents = async () => (await target.api("GET", "/agents")).body.agents.map((one) => one.agent_id).sort();
  const dailies = async () => (await target.api("GET", "/triggers")).body.triggers.filter((one) => one.name === "daily").length;
  const lockAgent = () => JSON.parse(readFileSync(lockFile, "utf8")).agent_id;

  // No such agent there: the first deploy makes one, as before.
  const first = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes"], key);
  assert.equal(first.code, 0, first.err);
  const made = first.json();
  assert.deepEqual([made.status, made.agent_change], ["deployed", "made"]);
  assert.deepEqual(await agents(), [made.agent_id]);

  // The lock gone (as one 0.1.0-beta.53 wrote for an install's agent is not read): the plan names that agent, and the
  // deploy stops before its apply, naming it and both ways on.
  rmSync(lockFile);
  let from = proxy.seen.length;
  const refused = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes"], key);
  assert.equal(refused.code, 2, refused.err);
  assert.equal(applies(from), 1, "the plan's dry run, and no apply");
  assert.match(refused.err, new RegExp(`The agent ${made.agent_id} on .* was made from this package with these parameters`));
  assert.match(refused.err, new RegExp(`--agent ${made.agent_id} deploys onto it, --agent new makes another`));
  assert.deepEqual([await agents(), existsSync(lockFile)], [[made.agent_id], false]);

  // --agent ID: that agent, with no second agent and no second trigger, and the lock names it.
  const onto = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes", "--agent", made.agent_id], key);
  assert.equal(onto.code, 0, onto.err);
  assert.equal(onto.json().agent_id, made.agent_id);
  assert.deepEqual([await agents(), await dailies(), lockAgent()], [[made.agent_id], 1, made.agent_id]);

  // With the lock's agent there, --agent naming another agent (or new) is refused with nothing written; naming the locked one is the
  // deploy it would be without it.
  from = proxy.seen.length;
  for (const other of ["agt_another", "new"]) {
    const wrong = await cli(env, ["deploy", pkg, "--yes", "--agent", other], key);
    assert.equal(wrong.code, 2, wrong.err);
    assert.match(wrong.err, new RegExp(`names the agent ${made.agent_id} on .*: --agent ${other} names another`));
  }
  assert.deepEqual(proxy.seen.slice(from).filter((one) => WRITES.test(one)), [], "nothing written: the lock's agent read, to know it is there");
  const same = await cli(env, ["deploy", pkg, "--yes", "--agent", made.agent_id], key);
  assert.equal(same.code, 0, same.err);
  assert.equal(same.json().status, "up_to_date");

  // --agent new, with no lock: another agent, on purpose, and the lock names it.
  rmSync(lockFile);
  const another = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes", "--agent", "new"], key);
  assert.equal(another.code, 0, another.err);
  assert.notEqual(another.json().agent_id, made.agent_id);
  assert.deepEqual([await agents(), lockAgent()], [[made.agent_id, another.json().agent_id].sort(), another.json().agent_id]);
});

/** A target that imports any package and plans and applies it: the answers a later AgentRun gives a package this CLI's
 *  own server would refuse. */
const ACCEPTS = {
  "POST /templates/import": [201, { template: { id: "pkg-1", name: "pr-alert", sha: "f".repeat(64), mcp: [] } }],
  "POST /templates/pkg-1/apply": [200, { plan: { action: "create", missing_secrets: [], unmatched_mcp: [], triggers: [], twins: [] }, agent_id: "agt_1", revision_id: "rev_1", revision_version: 1, agent_change: "made", triggers: [] }],
};

test("a deploy is checked by the target's import alone: a package the server beside this CLI would refuse goes to a target that takes it", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const fake = await fakeTarget(t, ACCEPTS);
  // A category this CLI's server does not list, as a later target's may.
  const pkg = folder(dir, { extra: ["category: productivity"] });
  const result = await cli(env, ["deploy", pkg, "--to", fake.base, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
  assert.equal(result.code, 0, `a package the target accepts is deployed, whatever this CLI's server would say of it: ${result.err}`);
  assert.deepEqual(fake.seen, ["POST /templates/import", "POST /templates/pkg-1/apply", "POST /templates/pkg-1/apply"]);
  assert.equal(JSON.parse(readFileSync(join(pkg, ".agentrun", "deploy.json"), "utf8")).agent_id, "agt_1");
});

test("a package the target's import refuses (422 input_invalid) exits 2 with the target's words, and nothing is applied", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const field = { field: "category", reason: "not_an_option", message: "category productivity is not one this server has" };
  const fake = await fakeTarget(t, { "POST /templates/import": [422, { error: { code: "input_invalid", message: field.message, fields: [field] } }] });
  const pkg = folder(dir, { extra: ["category: productivity"] });
  const refused = await cli(env, ["deploy", pkg, "--to", fake.base, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /category productivity is not one this server has/, refused.err);
  assert.deepEqual(fake.seen, ["POST /templates/import"], "nothing applied");
  assert.equal(existsSync(join(pkg, ".agentrun", "deploy.json")), false, "no lock written");
});

test("agentrun deploy of a package that names no tools and no computer, to a server with no Docker box whose runner has no shell, exits 2 in the server's words that name a box, nothing made and no lock; naming its tools, it deploys", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const target = await serve(t, { runner: false });
  const key = { AGENTRUN_API_KEY: target.token };
  const bare = folder(dir, { name: "bare", bare: true });
  const refused = await cli(env, ["deploy", bare, "--to", target.baseUrl, "--yes"], key);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /name a box: this server has no Docker box for a new agent\. Set place to /, refused.err);
  assert.deepEqual((await target.api("GET", "/agents")).body.agents, [], "nothing made");
  assert.equal(existsSync(join(bare, ".agentrun", "deploy.json")), false, "no lock written");
  const named = folder(dir, { name: "named" });
  const deployed = await cli(env, ["deploy", named, "--to", target.baseUrl, "--yes"], key);
  assert.equal(deployed.code, 0, deployed.err);
  assert.equal(deployed.json().agent_change, "made");
});

test("packageFiles reads a folder holding hidden files and leaves them out", async () => {
  const { dir } = scratch();
  const pkg = folder(dir);
  writeFileSync(join(pkg, ".DS_Store"), "\0\0\0\x01Bud1");
  writeFileSync(join(pkg, "skills", "check", ".env"), "KEY=not-a-secret\n");
  let files;
  await assert.doesNotReject(async () => {
    files = await packageFiles(pkg, (_code, message) => new Error(message));
  }, "packageFiles reads a folder holding a .DS_Store without throwing");
  assert.deepEqual(files.map((file) => file.path), ["agent.md", "skills/check/SKILL.md"], "its hidden files are left out");
});

test("agentrun deploy whose lock names an agent gone from the target: --agent ID deploys onto the agent the hint names, --agent new makes another, and a missing one is refused; while the locked agent is there, --agent naming another is refused with nothing written", { timeout: 300_000 }, async (t) => {
  const { dir, env } = scratch();
  const target = await serve(t, { runner: false });
  const proxy = await recorder(t, target.baseUrl);
  const pkg = folder(dir);
  const lockFile = join(pkg, ".agentrun", "deploy.json");
  const key = { AGENTRUN_API_KEY: target.token };
  const agents = async () => (await target.api("GET", "/agents")).body.agents.map((one) => one.agent_id).sort();
  const lockAgent = () => JSON.parse(readFileSync(lockFile, "utf8")).agent_id;
  const gone = async (id) => {
    assert.equal((await target.api("POST", `/agents/${id}/archive`)).status, 200);
    assert.equal((await target.api("DELETE", `/agents/${id}`)).status, 204);
  };

  // A: this folder's agent, the lock naming it. B: the same package's other agent, made from a copy on purpose.
  const first = await cli(env, ["deploy", pkg, "--to", proxy.base, "--yes"], key);
  assert.equal(first.code, 0, first.err);
  const a = first.json().agent_id;
  const copy = await cli(env, ["deploy", folder(join(dir, "copy")), "--to", proxy.base, "--yes", "--agent", "new"], key);
  assert.equal(copy.code, 0, copy.err);
  const b = copy.json().agent_id;

  // While A is there, --agent naming B or new is refused: the lock's agent is only read, nothing written.
  let from = proxy.seen.length;
  for (const other of [b, "new"]) {
    const wrong = await cli(env, ["deploy", pkg, "--yes", "--agent", other], key);
    assert.equal(wrong.code, 2, wrong.err);
    assert.match(wrong.err, new RegExp(`names the agent ${a} on .*: --agent ${other} names another`));
  }
  assert.deepEqual(proxy.seen.slice(from).filter((one) => WRITES.test(one)), [], "nothing written");

  // A gone: the deploy stops on B, the plan's twin, and its hint names --agent B, which now deploys onto B.
  await gone(a);
  const stopped = await cli(env, ["deploy", pkg, "--yes"], key);
  assert.equal(stopped.code, 2, stopped.err);
  assert.match(stopped.err, new RegExp(`--agent ${b} deploys onto it, --agent new makes another`));
  const missing = await cli(env, ["deploy", pkg, "--yes", "--agent", "agt_missing"], key);
  assert.equal(missing.code, 2, missing.err);
  assert.match(missing.err, /--agent agt_missing: .* has no such agent/);
  const onto = await cli(env, ["deploy", pkg, "--yes", "--agent", b], key);
  assert.equal(onto.code, 0, onto.err);
  assert.deepEqual([onto.json().agent_id, await agents(), lockAgent()], [b, [b], b]);

  // B gone too: --agent new makes another, and the lock names it.
  await gone(b);
  const another = await cli(env, ["deploy", pkg, "--yes", "--agent", "new"], key);
  assert.equal(another.code, 0, another.err);
  const c = another.json().agent_id;
  assert.ok(![a, b].includes(c), c);
  assert.deepEqual([await agents(), lockAgent()], [[c], c]);
});

/** The CLI signed in to `base` with `token` (its config file, 0600): how it reaches an install it does not run. */
/** --pause-source's last word when a schedule there was left running: after the deploy's own line, naming the install. */
function unpausedSaid(err, base) {
  const deployed = err.indexOf("Deployed ");
  const said = err.indexOf(`--pause-source did not pause every schedule of the agent on ${base}`);
  assert.ok(deployed >= 0 && said > deployed, err);
}

function signedIn(dir, base, token) {
  mkdirSync(join(dir, ".config", "agentrun"), { recursive: true });
  writeFileSync(join(dir, ".config", "agentrun", "config.json"), `${JSON.stringify({ base_url: base, api_key: token })}\n`, { mode: 0o600 });
}

/** An install's export of pr-alert (GET /agents/{id}/package): its files, their sha256, nothing blocked or remade. */
function exportOf() {
  const files = new Map([["agent.md", Buffer.from(AGENT({}))], ["skills/check/SKILL.md", Buffer.from(SKILL())]]);
  return { name: "pr-alert", files: [...files].map(([path, data]) => ({ path, encoding: "utf8", content: data.toString("utf8") })), sha256: packageSha256(files), report: { blocked: [], remade: [] } };
}

test("agentrun deploy AGENT_ID from an install that refuses its trigger routes: the deploy is done and exits 0 (1 under --pause-source, which paused nothing), the agent's schedules there are said unread (or unpaused), never paused; an API-only install exports nothing, so a deploy from it stops before it sends anything", { timeout: 180_000 }, async (t) => {
  const hosted = await apiOnly(t);

  // An API-only source: its agent's export is not served there, so the deploy stops at it, nothing sent to the target.
  const imported = await hosted.api("POST", "/templates/import", { files: exportOf().files });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const applied = await hosted.api("POST", `/templates/${encodeURIComponent(imported.body.template.id)}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const elsewhere = await fakeTarget(t, {});
  const fromHosted = scratch();
  signedIn(fromHosted.dir, hosted.baseUrl, hosted.token);
  const refused = await cli(fromHosted.env, ["deploy", applied.body.agent_id, "--base-url", hosted.baseUrl, "--to", elsewhere.base, "--yes"], { AGENTRUN_API_KEY: "not-a-secret" });
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /does not export .*this server serves the run API only \(AGENTRUN_API_ONLY=1\).*Nothing was sent/);
  assert.deepEqual(elsewhere.seen, [], "nothing sent to the target");

  // A source that exports the agent and refuses its trigger routes (the fake's 404), deployed to another API-only install
  // (the first holds an agent of the same package, which a deploy with no lock stops at).
  const target = await apiOnly(t);
  const AGENT_ID = "agt_source";
  const answers = { [`GET /agents/${AGENT_ID}/package`]: [200, exportOf()] };
  const source = await fakeTarget(t, answers);
  const { dir, env } = scratch();
  signedIn(dir, source.base, "not-a-secret");
  const deploy = (...args) => cli(env, ["deploy", AGENT_ID, "--base-url", source.base, "--to", target.baseUrl, "--yes", ...args], { AGENTRUN_API_KEY: target.token });
  for (const pause of [[], ["--pause-source"]]) {
    const result = await deploy(...pause);
    // The deploy is done either way; --pause-source that paused nothing it was asked to exits 1, after saying so.
    assert.equal(result.code, pause.length ? 1 : 0, `${pause}: ${result.err}`);
    assert.equal(result.json().status, "deployed");
    assert.equal((await target.api("GET", `/agents/${result.json().agent_id}`)).status, 200);
    assert.match(result.err, new RegExp(`the agent's schedules on ${source.base} could not be read ${pause.length ? "or paused " : ""}\\(404: Not found\\.\\)`), `${pause}`);
    assert.doesNotMatch(result.err, /Paused/, `${pause}`);
    if (pause.length) unpausedSaid(result.err, source.base);
  }
  // It lists a live schedule of the agent's and refuses to change it: said unpaused, the deploy done all the same.
  answers["GET /triggers"] = [200, { triggers: [{ id: "trg_daily", name: "daily", agent_id: AGENT_ID, enabled: true, source: { kind: "schedule", cron: "0 8 * * *" } }] }];
  const unpaused = await deploy("--pause-source");
  assert.equal(unpaused.code, 1, unpaused.err);
  unpausedSaid(unpaused.err, source.base);
  assert.equal(unpaused.json().status, "deployed");
  assert.ok(source.seen.includes("PATCH /triggers/trg_daily"), source.seen.join("\n"));
  assert.match(unpaused.err, new RegExp(`daily could not be paused on ${source.base} \\(404: Not found\\.\\): it still runs there`));
  assert.doesNotMatch(unpaused.err, /Paused/);
});

test("agentrun deploy AGENT_ID from an install whose trigger answer stops after its headers: the deploy is done and exits 0 with its answer (1 under --pause-source, which paused nothing), the schedules there said unread (or unpaused) as for an install not reached, never paused", { timeout: 180_000 }, async (t) => {
  const target = await apiOnly(t);
  const AGENT_ID = "agt_source";
  const answers = { [`GET /agents/${AGENT_ID}/package`]: [200, exportOf()], "GET /triggers": DROPPED };
  const source = await fakeTarget(t, answers);
  const { dir, env } = scratch();
  signedIn(dir, source.base, "not-a-secret");
  const deploy = (...args) => cli(env, ["deploy", AGENT_ID, "--base-url", source.base, "--to", target.baseUrl, "--yes", ...args], { AGENTRUN_API_KEY: target.token });
  for (const pause of [[], ["--pause-source"]]) {
    const result = await deploy(...pause);
    assert.equal(result.code, pause.length ? 1 : 0, `${pause}: ${result.err}`);
    assert.equal(result.json().status, "deployed");
    assert.equal((await target.api("GET", `/agents/${result.json().agent_id}`)).status, 200);
    assert.match(result.err, new RegExp(`the agent's schedules on ${source.base} could not be read ${pause.length ? "or paused " : ""}\\(not reached: [^)]+\\): any it has still run there`), `${pause}`);
    assert.doesNotMatch(result.err, /Paused/, `${pause}`);
    if (pause.length) unpausedSaid(result.err, source.base);
  }
  // It lists a live schedule of the agent's, and its answer to the change stops after its headers: said unpaused.
  answers["GET /triggers"] = [200, { triggers: [{ id: "trg_daily", name: "daily", agent_id: AGENT_ID, enabled: true, source: { kind: "schedule", cron: "0 8 * * *" } }] }];
  answers["PATCH /triggers/trg_daily"] = DROPPED;
  const unpaused = await deploy("--pause-source");
  assert.equal(unpaused.code, 1, unpaused.err);
  unpausedSaid(unpaused.err, source.base);
  assert.equal(unpaused.json().status, "deployed");
  assert.ok(source.seen.includes("PATCH /triggers/trg_daily"), source.seen.join("\n"));
  assert.match(unpaused.err, new RegExp(`daily could not be paused on ${source.base} \\(not reached: [^)]+\\): it still runs there`));
  assert.doesNotMatch(unpaused.err, /Paused/);
});

test("agentrun deploy AGENT_ID from an install whose trigger list answers 200 with no JSON, or with no list of triggers: never read as no schedules; said unread, and with --pause-source the command exits 1 after the deploy is done", { timeout: 180_000 }, async (t) => {
  const target = await apiOnly(t);
  const AGENT_ID = "agt_source";
  const answers = { [`GET /agents/${AGENT_ID}/package`]: [200, exportOf()] };
  const source = await fakeTarget(t, answers);
  const { dir, env } = scratch();
  signedIn(dir, source.base, "not-a-secret");
  const deploy = (...args) => cli(env, ["deploy", AGENT_ID, "--base-url", source.base, "--to", target.baseUrl, "--yes", ...args], { AGENTRUN_API_KEY: target.token });
  for (const [answer, why] of [[[200, undefined], "200 with no JSON"], [[200, { triggers: { daily: true } }], "200 with no list of triggers"]]) {
    answers["GET /triggers"] = answer;
    for (const pause of [[], ["--pause-source"]]) {
      const result = await deploy(...pause);
      assert.equal(result.code, pause.length ? 1 : 0, `${why} ${pause}: ${result.err}`);
      assert.equal(result.json().status, "deployed");
      assert.ok(result.err.includes(`the agent's schedules on ${source.base} could not be read ${pause.length ? "or paused " : ""}(${why})`), `${why} ${pause}: ${result.err}`);
      assert.ok(!source.seen.some((one) => one.startsWith("PATCH ")), "nothing changed there");
      if (pause.length) unpausedSaid(result.err, source.base);
    }
  }
});
