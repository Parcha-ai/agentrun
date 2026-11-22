// `agentrun deploy [AGENT|DIR] --to URL`: a package folder uploaded to another AgentRun (POST /v2/templates/import
// {files}), its plan read (apply with dry_run) and printed, applied once confirmed (--yes off a terminal), and a lock
// written beside it (DIR/.agentrun/deploy.json). The next deploy of the same package is "up to date" and sends nothing
// that writes; a changed one writes revision n+1; a target edited since the lock is refused without --force. A package
// whose keys the target lacks exits 3 with nothing made. `deploy rollback` makes the previous revision current, and
// `deploy delete` removes the agent and the lock. Two real servers on loopback with a faux model: A, where the command
// runs, and B, where it deploys.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./support.mjs";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_CLOUD_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-deploy-"));
  removeAtEnd(dir);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), AGENTRUN_BOXES: "none", HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
  return { dir, env };
}

/** A server on its own data directory with a faux model: its base URL, its token, and a client for its API. */
async function server(t, dir, env, name) {
  const data = join(dir, name);
  mkdirSync(data, { recursive: true });
  const faux = join(dir, `${name}-faux.mjs`);
  writeFileSync(faux, 'export default (context, faux) => faux.message("Nothing changed today.");\n');
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `server ${name} started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = JSON.parse(readFileSync(join(data, ".server.json"), "utf8")).base_url;
  const token = readFileSync(join(data, ".token"), "utf8").trim();
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json ?? text };
  };
  return { data, base, token, api };
}

/** A loopback proxy in front of `to` that records each request's method and path: what a deploy sent. */
async function recorder(t, to) {
  const seen = [];
  const target = new URL(to);
  const proxy = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
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

/** The CLI in a child process; stdin closed (no terminal). */
function cli(env, args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err, json: () => JSON.parse(out) }));
  });
}

const SKILL = (line = "Say what changed.") => `---
name: check
description: Check what changed and say it in one line.
---
# Check

${line}
`;
const AGENT = ({ name = "pr-alert", extra = [] } = {}) => `---
name: ${name}
version: 0.1.0
description: Says what changed in the repository today.
budget: { per_run_usd: 1.00 }
${extra.join("\n")}
triggers:
  - name: daily
    source: { kind: schedule, cron: "0 8 * * *" }
    target: { kind: start_run, input: { content: "Run the daily check." } }
---
You check what changed. Use your check skill.
`;

/** A package folder named as its manifest. */
function folder(dir, { name = "pr-alert", extra = [], skill } = {}) {
  const at = join(dir, name);
  mkdirSync(join(at, "skills", "check"), { recursive: true });
  writeFileSync(join(at, "agent.md"), AGENT({ name, extra }));
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
  assert.deepEqual(Object.keys(lock).sort(), ["agent_id", "deployed_at", "package_sha256", "revision_id", "target", "workspace"]);
  assert.deepEqual([lock.target, lock.workspace, lock.agent_id, lock.revision_id, lock.package_sha256], [proxy.base, null, done.agent_id, done.revision_id, done.package_sha256]);
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
  assert.match(refused.err, /edited in the cloud; --force to replace/);
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

test("--to names a target: cloud is api.agentrun.ai (AGENTRUN_CLOUD_URL overrides it), a URL with no path gets /v2", async () => {
  const { CLOUD_URL, toBase } = await import("../lib/target.mjs");
  assert.equal(CLOUD_URL, "https://api.agentrun.ai/v2");
  assert.equal(toBase("cloud", {}), "https://api.agentrun.ai/v2");
  assert.equal(toBase("cloud", { AGENTRUN_CLOUD_URL: "https://staging.example.test/v2/" }), "https://staging.example.test/v2");
  assert.equal(toBase("http://127.0.0.1:7340", {}), "http://127.0.0.1:7340/v2");
  assert.equal(toBase("https://agents.example.test/", {}), "https://agents.example.test/v2");
  assert.equal(toBase("https://agents.example.test/v2/", {}), "https://agents.example.test/v2");
  // A URL with a user and password, made here rather than written out.
  const withUser = Object.assign(new URL("https://example.test"), { username: "user", password: "pw" }).href;
  for (const bad of ["ftp://example.test", withUser, "https://example.test/v2?x=1", "nope"]) assert.throws(() => toBase(bad, {}), /--to/, bad);
});
