// What a run's own process (run-child.ts) is answered by its runner (run-child-host.ts): each answer bound on the runner
// to the claim it holds, whatever the process names. A GitHub token of the run's own pull request's repository alone,
// contents read; decision and tier keys of the claim's learned workflows alone, as the runner chose them; the settings of
// the server's shared configuration and the claim's own rows, never another run's; its viewers' address under its own
// run's proof key, never the runners' shared one; no channel post; the computer it made let go by the runner at the
// claim's release; the install it asks for, readable by its user. Which runs stay in the runner; where runs have users of
// their own, a run on AgentRun's own Claude Code login folder claimed as a process of its own, one on the machine's own
// login, or beside a runner whose login runs stay in its process, refused at its claim. And the channel lets go of a function it handed once the other side's
// stand-in for it is gone. No key, no network: a fake GitHub on loopback, dummy keys.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { seal } from "../dist/sealing.js";
import { storeOn } from "./store-helpers.mjs";
import { stranger } from "./fixtures/stranger.mjs";
import { landWorkflows, promoteChecked, startAt } from "./learned-workflow-seed-support.mjs";

// Namespaces: a name the runner does not export reads as undefined, and its assertion says what is missing.
const host = await import("../dist/runner/run-child-host.js");
const live = await import("../dist/live-reach.js");
const { sealRunLaunch } = await import("../dist/store/index.js");
const { Channel } = await import("../dist/runner/run-channel.js");

const KEY = randomBytes(32);
const { privateKey: PEM } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
// Dummy key values, built so the source scan reads no literal credential.
const PARALLEL_DUMMY = `not-a-secret-${"parallel-key"}`;
const ANTHROPIC_DUMMY = `not-a-secret-${"anthropic-key"}`;
const OPENAI_DUMMY = `not-a-secret-${"openai-key"}`;
const HEAD = "a".repeat(40);
const PULL = `Review it.\n\n<trigger-payload source="github" installation="777" repo="acme/widgets" number="7" head_sha="${HEAD}">{}</trigger-payload>`;

/** Every folder under `dir` its owner's to write again, so the test's own cleanup removes it. */
function chmodTree(dir) {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) chmodTree(join(dir, name));
}

/** The GitHub App's rows, sealed under KEY as the server's sealed settings write them. */
async function connected(store) {
  for (const [field, value] of [["app_id", "4242"], ["private_key", PEM], ["slug", "agentrun-test-app"]]) {
    await store.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(KEY, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  }
}

/** A fake GitHub that makes installation 777's tokens; every request it is asked, kept. */
async function fakeGitHub(t) {
  const asked = [];
  const server = createServer((req, res) => {
    if (stranger(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      asked.push({ method: req.method, url: req.url, body });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) return answer(201, { token: "not-a-secret-ghs-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      return answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}`, asked };
}

/** The runner's answers for claim run-own (agent-own, rev-own) of `revision` and `launch`, over `store`. */
function heldOf(store, { env = {}, githubApi, data = "/nonexistent-data", revision = { kind: "agentic", body: {} }, launch = { input: { content: "Hello." } } } = {}, lines = []) {
  const deps = { store, sealKey: KEY, env, data, ...(githubApi ? { githubApi } : {}) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch, revision, claimed: {} };
  return host.heldFor(deps, reads, (text) => text, (line) => void lines.push(line)).held;
}

test("a run's process mints a GitHub token for its own pull request's repository alone, contents read, whatever repository or permissions it names; a run with no pull-request checkout gets no access", async (t) => {
  const { store } = await storeOn(t);
  await connected(store);
  const github = await fakeGitHub(t);
  const lines = [];
  const launch = { input: { content: PULL }, inputOrigin: { kind: "trigger", source: "github" } };
  const held = heldOf(store, { githubApi: github.api, revision: { kind: "agentic", body: { checkout: "pull_request" } }, launch }, lines);
  const access = await held.githubAppAccess();
  assert.deepEqual(access.target, { repo: "acme/widgets", installation: 777 });
  await assert.rejects(access.mint({ repo: "acme/other", installation: 777 }), /only for its own pull request's repository/);
  await assert.rejects(access.mint({ repo: "acme/widgets", installation: 778 }), /only for its own pull request's repository/);
  await assert.rejects(access.mint(undefined), /only for its own pull request's repository/);
  assert.deepEqual(github.asked, [], "a refused mint asked GitHub nothing");
  assert.ok(lines.some((line) => /asked for a GitHub token of another repository/.test(line)), lines.join("\n"));
  // Asked with no permissions, or with the App's write ones: contents read, of the one repository.
  for (const permissions of [undefined, { contents: "write", pull_requests: "write" }]) {
    const minted = await access.mint({ repo: "acme/widgets", installation: 777 }, permissions);
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.deepEqual(JSON.parse(github.asked.at(-1).body), { repositories: ["widgets"], permissions: { contents: "read" } }, JSON.stringify(permissions));
  }
  // The same launch on a revision that checks out no pull request: nothing to mint for.
  assert.equal(await heldOf(store, { githubApi: github.api, launch }).githubAppAccess(), undefined);
});

const judgeFlow = (name, provider) => ({
  v: 2, name,
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Coi", path: "coi" },
  root: { node: "chain", steps: [{ node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi", provider }] },
});

test("a run's process gets no decision or tier key its claim's learned workflows do not name: none before the runner chose them, and of those only the named", async (t) => {
  const { store } = await storeOn(t);
  const env = { AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_STRONG: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: OPENAI_DUMMY, ANTHROPIC_API_KEY: ANTHROPIC_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY };
  // A run with no learned workflow, asking for Parallel's key and the strong tier's.
  const plain = heldOf(store, { env });
  assert.deepEqual(await plain.decisionKeys(["parallel"]), {}, "a run with no learned workflow naming parallel");
  assert.deepEqual((await plain.tierModelKeys(["strong"])).keys, {}, "a run with no learned workflow naming the strong tier");
  // A run whose seed lays a checked workflow asking Parallel: its key once the runner chose it, and no other provider's.
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-child-held-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const flow = judgeFlow("on-parallel", "parallel");
  const sha = await landWorkflows(data, "agent-own", [{ name: "on-parallel", description: "Checks a certificate", workflow: flow }]);
  await promoteChecked(store.settings, "agent-own", [{ name: "on-parallel", workflow: flow }]);
  const learning = heldOf(store, { env, data, launch: { input: { content: "Hello." }, learning: startAt(sha) } });
  assert.deepEqual(await learning.decisionKeys(["parallel"]), {}, "none before the runner chose the claim's workflows");
  const first = await learning.learnedFirst({ laid: true });
  assert.deepEqual(first.workflows.map(({ name }) => name), ["on-parallel"]);
  assert.deepEqual(await learning.decisionKeys(["parallel", "jev"]), { PARALLEL_API_KEY: PARALLEL_DUMMY });
  assert.deepEqual((await learning.tierModelKeys(["strong"])).keys, {}, "its workflow names no strong tier");
});

test("the settings a run's process reads are the server's shared configuration and its own run's and agent's rows: another run's SDK record is refused unread, and a listing holds only the readable rows", async () => {
  const rows = [
    { key: "tool-settings", value: "{}" },
    { key: "sdk-run:run-own", value: "own" },
    { key: "sdk-run:run-other", value: "another run's messages" },
    { key: "archil.agent.agent-other", value: "{}" },
    { key: "learning.promotions.agent-own", value: "[]" },
  ];
  const asked = [];
  const store = { settings: { get: async (key) => (asked.push(key), rows.find((row) => row.key === key)?.value), all: async () => rows } };
  const bound = { claim: { runId: "run-own", epoch: 1 }, agentId: "agent-own", revisionId: "rev-own" };
  const lines = [];
  const call = (method, args) => host.storeCall(store, method, args, bound, (line) => void lines.push(line));
  await assert.rejects(call("settings.get", ["sdk-run:run-other"]), /of another run or agent/);
  await assert.rejects(call("settings.get", ["archil.agent.agent-other"]), /of another run or agent/);
  assert.deepEqual(asked, [], "a refused read reached the store");
  assert.equal(await call("settings.get", ["sdk-run:run-own"]), "own");
  assert.equal(await call("settings.get", ["tool-settings"]), "{}");
  assert.deepEqual((await call("settings.all", [])).map(({ key }) => key), ["tool-settings", "sdk-run:run-own", "learning.promotions.agent-own"]);
  assert.ok(lines.some((line) => /asked the store for settings\.get, which a run's process may not/.test(line)), lines.join("\n"));
});

test("a run's process reads no channel post: a webhook post, its own run's or another's, is refused unread", async () => {
  const asked = [];
  const store = { channels: { get: async (id) => (asked.push(id), { id, runId: "run-other", body: { title: "another run's" } }) } };
  const bound = { claim: { runId: "run-own", epoch: 1 }, agentId: "agent-own", revisionId: "rev-own" };
  const lines = [];
  await assert.rejects(host.storeCall(store, "channels.get", ["post-1"], bound, (line) => void lines.push(line)), /may not call the store's channels\.get/);
  assert.deepEqual(asked, [], "a refused read reached the store");
  assert.ok(lines.some((line) => /asked the store for channels\.get, which a run's process may not/.test(line)), lines.join("\n"));
});

test("a run that runs no agent's code here stays in its runner: a learning run, an SDK backend run, a CLI capture and a native run; any other run is a process of its own", () => {
  assert.equal(typeof host.runsInRunner, "function", "the runner says which runs stay in it");
  assert.equal(host.runsInRunner("learning", {}), true, "a learning run");
  assert.equal(host.runsInRunner("claude-agent", { sdk: { runtime: "claude-agent-sdk", instructions: "Policy." } }), true, "an SDK backend run");
  assert.equal(host.runsInRunner("pi", { native: { runtime: "claude-code", remote: { connector_id: "c-1" } } }), true, "a native run");
  assert.equal(host.runsInRunner("cli", { cli_learning: { runtime: "codex-cli", connection_id: "connection", session_id: "session", turn_id: "turn" } }), true, "a source CLI capture runs no agent code here");
  for (const harness of ["pi", "claude-agent", "codex", "cli"]) assert.equal(host.runsInRunner(harness, {}), false, harness);
});

/** staysInRunner's deps for a run of a revision of `kind`, with Claude Code's login on this machine turned on when
 *  `login` (true: AgentRun's own folder; else the place named); run "run-keyed" holds a model key of its own
 *  (model_key), sealed on its launch as the server seals it. `live`: the runner rows the store says are fresh. */
function staysDeps(data, kind, login, live = []) {
  const sealKey = randomBytes(32);
  const modelKeyed = sealRunLaunch(sealKey, "run-keyed", { model: { key: "sk-fake-run-own", origin: "https://gateway.invalid" } });
  return {
    data,
    env: {},
    sealKey,
    store: {
      runs: { get: async (id) => ({ id, agentId: "agent-own", revisionId: "rev-own" }), launch: async (id) => ({ sealed: id === "run-keyed" ? modelKeyed : null }) },
      agents: { revision: async () => ({ id: "rev-own", kind, body: {} }) },
      settings: { get: async (key) => (key === "claude_login" && login ? { v: 1, place: login === true ? "agentrun" : login, host: hostname(), only_me: true } : null) },
      runners: { live: async () => live },
    },
  };
}
// Where each run is a user of its own (the image's helper), and where every run is the runner's own user: by
// AGENTRUN_RUN_USER=same, or a local install with no helper.
const PER_RUN_USERS = { kind: "uid", helper: "/nonexistent/agentrun-runas", first: 0, slots: 1 };
const SAME_USER = { kind: "process", why: "AGENTRUN_RUN_USER=same" };
const NO_HELPER = { kind: "process", why: "no helper on this host" };

test("a workflow run on a server's documents directory stays in its runner, where runs have users of their own too; a run on the model keys, or on its caller's own model key under Claude Code's login, is a process of its own", async (t) => {
  assert.equal(typeof host.staysInRunner, "function", "the runner says, per run, which runs stay in it");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-stays-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const runner = { mode: "runner" };
  for (const isolation of [PER_RUN_USERS, SAME_USER, NO_HELPER]) {
    const on = (words) => `${words} (${isolation.kind}: ${isolation.why ?? "a user of its own"})`;
    assert.equal(await host.staysInRunner(staysDeps(data, "workflow"), "pi", { input: {}, place: runner, documents: data }, "run-own", isolation), true, on("a workflow run rooted at the server's documents directory"));
    assert.equal(await host.staysInRunner(staysDeps(data, "workflow"), "pi", { input: {}, place: runner }, "run-own", isolation), false, on("a workflow run with no documents directory (rooted at /tmp) is a process of its own"));
    assert.equal(await host.staysInRunner(staysDeps(data, "agentic"), "pi", { input: {}, place: runner, documents: data }, "run-own", isolation), false, on("an agentic run, which never reads the documents directory"));
    assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "claude-agent", { input: {}, place: runner }, "run-keyed", isolation), false, on("a claude-agent run on its caller's own model key, which its CLI runs on instead of the login (cli-run-spec.ts)"));
    assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "codex", { input: {}, place: runner }, "run-own", isolation), false, on("a harness the login is not for"));
    assert.equal(await host.staysInRunner(staysDeps(data, "agentic"), "claude-agent", { input: {}, place: runner }, "run-own", isolation), false, on("a claude-agent run on model keys, the login off"));
    assert.equal(await host.staysInRunner(staysDeps(data, "agentic"), "learning", { input: {}, place: runner }, "run-own", isolation), true, on("runsInRunner's runs too"));
  }
});

test("where runs have users of their own, a claude-agent run on AgentRun's own login folder, with no model_key of its own, is a process of its own (handed the login's access token alone), never refused; where runs are the server's own user it stays in the runner", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "claimed as a process of its own user, on the login's token");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", SAME_USER), true, "AGENTRUN_RUN_USER=same: the run stays in the runner, as the server's user, and runs on the login");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "claude-agent", launch, "run-own", NO_HELPER), true, "a local install with no helper: the same");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "a run on its caller's own model key is a process of its own, never refused");
});

test("where runs have users of their own, a claude-agent run on this machine's own Claude Code login (~/.claude) is refused at its claim, in words naming that login, AgentRun's own folder, AGENTRUN_RUN_USER=same and model_key", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-machine-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  await assert.rejects(host.staysInRunner(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-own", PER_RUN_USERS), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /this machine's own Claude Code login \(~\/\.claude\)/);
    assert.match(error.message, /AgentRun's own login folder/);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    assert.match(error.message, /model_key/);
    return true;
  });
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-own", SAME_USER), true, "AGENTRUN_RUN_USER=same: it stays in the runner, on the machine's login");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", "machine"), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "its caller's own model key: never refused");
});

// The runners on a data folder say at their start whether their runs on the login stay in their own process
// (claude-login-token.ts sayLoginRunner); a name the module does not export reads as undefined below.
const loginToken = await import("../dist/claude-login-token.js").catch(() => ({}));

test("where runs have users of their own, a claude-agent run on the login is refused at its claim while a runner on the same data folder whose login runs stay in its own process is live, in words naming that runner; not once it is stale or starts with users of its own", async (t) => {
  assert.equal(typeof loginToken.sayLoginRunner, "function", "a runner says on the data folder how its runs on the login run");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-login-q5-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const launch = { input: {}, place: { mode: "runner" } };
  const fresh = [{ runner: "runner-own" }, { runner: "runner-beside" }];
  loginToken.sayLoginRunner(data, "runner-beside", "process");
  loginToken.sayLoginRunner(data, "runner-own", "uid");
  await assert.rejects(host.staysInRunner(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", PER_RUN_USERS), (error) => {
    assert.equal(error.name, "ClaimRefused", `refused for good, the run failed in its words: ${error.stack}`);
    assert.match(error.message, /runner runner-beside on the same data folder/);
    assert.match(error.message, /stop runner-beside/);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    assert.match(error.message, /model_key/);
    return true;
  });
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true, [{ runner: "runner-own" }]), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "the in-process runner's row is stale: claimed");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-keyed", PER_RUN_USERS), false, "its caller's own model key: never refused");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", SAME_USER), true, "this runner's own login runs stay in it too: never refused");
  loginToken.sayLoginRunner(data, "runner-beside", "uid");
  assert.equal(await host.staysInRunner(staysDeps(data, "agentic", true, fresh), "claude-agent", launch, "run-own", PER_RUN_USERS), false, "runner-beside started again with users of its own: claimed");
});

test("the install a run's process asks for is readable by every user and writable by none, an install from before installs were shared too", { skip: process.getuid?.() === 0 && "root reads every folder" }, async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-install-"));
  t.after(() => (chmodTree(data), rmSync(data, { recursive: true, force: true })));
  // An install as one before installs were shared left it: its top folder its owner's alone, as its staging was made.
  const dir = join(data, "harnesses", "claude-agent");
  mkdirSync(join(dir, "node_modules", "sdk"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "sdk", "index.js"), "export {};\n", { mode: 0o644 });
  writeFileSync(join(dir, "node_modules", "sdk", "cli"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(dir, "node_modules", "sdk", "index.js"), 0o400);
  chmodSync(join(dir, "node_modules", "sdk", "cli"), 0o500);
  chmodSync(join(dir, "node_modules", "sdk"), 0o500);
  chmodSync(join(dir, "node_modules"), 0o500);
  chmodSync(dir, 0o500);
  const asked = [];
  const deps = { store, sealKey: KEY, env: {}, data, installForClaim: async (entry, at) => void asked.push([entry.id, at]) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." }, harness: "claude-agent" }, revision: { kind: "agentic", body: {} }, claimed: {} };
  const held = host.heldFor(deps, reads, (text) => text, () => {}).held;
  await held.install("claude-agent");
  assert.deepEqual(asked, [["claude-agent", dir]], "the runner installed (or found) the harness");
  const mode = (path) => statSync(path).mode & 0o777;
  assert.equal(mode(dir), 0o555, "its top folder is entered and listed by every user");
  assert.equal(mode(join(dir, "node_modules", "sdk")), 0o555, "and every folder under it");
  assert.equal(mode(join(dir, "node_modules", "sdk", "index.js")), 0o444, "a file is read by every user, written by none");
  assert.equal(mode(join(dir, "node_modules", "sdk", "cli")), 0o555, "a program its owner may run, run by every user");
});

test("the computer the runner made for a run is released by the runner at the claim's release, whatever its process did: once, as the run's end", async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-computer-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const released = [];
  const deps = { store, sealKey: KEY, env: {}, data, computerForClaim: async () => ({ release: async (why) => void released.push(why ?? "released") }) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision: { kind: "agentic", body: {} }, claimed: {} };
  const side = host.heldFor(deps, reads, (text) => text, () => {});
  const got = await side.held.computer({ hadComputer: async () => false });
  assert.equal(typeof got.release, "function");
  // The run's process ends (a crash, a broken channel) without calling the computer's release.
  await side.release();
  assert.deepEqual(released, ["ended"], "the runner let the computer go at the claim's release");
});

test("a run's process is handed its runner's live address with its own run's proof key: a proof for its run's viewers holds, one for another run's or under the runners' shared key does not", async (t) => {
  const { store } = await storeOn(t);
  const held = heldOf(store, { env: { AGENTRUN_RUNNER_LIVE_HOST: "127.0.0.2" } });
  assert.equal(typeof held.liveAt, "function", "the runner hands the run's process no address its viewers answer at");
  const given = await held.liveAt();
  assert.equal(given.host, "127.0.0.2");
  const key = Buffer.from(given.key);
  const reach = live.liveReachOf({ AGENTRUN_RUNNER_HOSTS: "127.0.0.2" }, KEY);
  const req = (proof) => ({ headers: { [live.LIVE_PROOF_HEADER]: proof } });
  assert.equal(live.provenFor(req(live.liveProof(live.reachForRun(reach, "run-own"), "viewer-1")), { key }, "viewer-1"), true, "the server's proof for this run's viewer");
  assert.equal(live.provenFor(req(live.liveProof(live.reachForRun(reach, "run-other"), "viewer-1")), { key }, "viewer-1"), false, "another run's proof");
  assert.equal(live.provenFor(req(live.liveProof(reach, "viewer-1")), { key }, "viewer-1"), false, "a proof under the runners' shared key");
  assert.notDeepEqual(key, reach.key, "the run's process never holds the runners' shared key");
  assert.equal(await heldOf(store).liveAt(), undefined, "a runner on its server's machine: none");
});

test("a function handed across the channel is let go by its sender once the receiver's stand-in for it is gone", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const [a, b] = duplexPair();
  const runner = new Channel(a);
  const child = new Channel(b);
  const handed = [];
  // As a hold's enter answers a fresh release function each time (computer-for-claim.ts).
  runner.expose("hold", () => {
    const release = () => "released";
    handed.push(new WeakRef(release));
    return release;
  });
  for (let i = 0; i < 20; i++) {
    const release = await child.call("hold", "enter", []);
    assert.equal(await release(), "released");
  }
  // A deref keeps its target alive to the end of the job it ran in: each gc runs in a job of its own, after the reads.
  const kept = () => handed.filter((ref) => ref.deref() !== undefined).length;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 100 && kept() > 1; i++) {
    await tick();
    gc();
    await tick();
  }
  // The last stand-in may still be the loop's own; every earlier one is gone.
  const left = kept();
  assert.ok(left <= 1, `the runner still holds ${left} of the ${handed.length} release functions it handed, each released and its stand-in gone`);
  assert.equal(runner.handed, left, "what the runner counts as handed is what it holds");
  runner.close();
  child.close();
});

// A Mode 2 run's folder is its runner's Workspace on the run's disk, which its process holds by handle (held.ts archil,
// archil-claim.ts archilWhereHeld): a write through it is a call of the run's channel, one frame. A write bigger than a
// frame crosses in pieces the runner pulls, and the runner writes the file once, on that Workspace (runner/big-writes.ts).
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { saveSlots } = await import("../dist/web-save.js");
const { setHeld } = await import("../dist/runner/held.js");
const { archilWhereHeld } = await import("../dist/workspace/archil-claim.js");
const { openRunWorkspace } = await import("../dist/workspace/run-workspace.js");
const bigWrites = await import("../dist/runner/big-writes.js").catch(() => ({}));

test("a Mode 2 run's process writes a file bigger than its channel's frame through its held Workspace: its runner pulls the pieces and writes it once, byte for byte", async (t) => {
  const { store } = await storeOn(t);
  const DISK = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
  await saveArchilSettings(store, DISK);
  await storeAgentDisk(store, "agent-own", { diskId: DISK.diskId });
  await store.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  const disk = new FakeArchilDisk();
  const control = archilControlFetch();
  const deps = { store, sealKey: KEY, env: {}, data: "/nonexistent-data", makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision: { kind: "agentic", body: {} }, claimed: {} };
  // A channel of 1 MiB frames, its runner's side as the runner wires it (runChannel, heldFor's answers as "held"), the
  // pieces a quarter of a frame.
  const FRAME = 1024 * 1024;
  const bigs = bigWrites.runBigWrites?.({ gate: saveSlots(4), piece: FRAME / 4 });
  const side = bigs ? host.heldFor(deps, reads, (text) => text, () => {}, bigs) : host.heldFor(deps, reads, (text) => text, () => {});
  const [runnerEnd, childEnd] = duplexPair();
  const runner = host.runChannel(runnerEnd, () => {}, saveSlots(4), { ...(bigs ? { bigs } : {}), maxFrame: FRAME });
  runner.expose("held", (method, args) => side.held[method](...args));
  const child = new Channel(childEnd, { maxFrame: FRAME });
  t.after(async () => { setHeld(undefined); child.close(); runner.close(); await side.release(); });
  // The run's process opens its folder as a Mode 2 claim's does: the Workspace its runner opened on the disk.
  setHeld(child.remote("held"));
  const claim = await archilWhereHeld({ signal: new AbortController().signal });
  const ws = (await openRunWorkspace({ mode: 2, agentId: "agent-own", runId: "run-own", archil: claim, log: () => {} })).workspace;
  const bytes = randomBytes(3 * FRAME + 123);
  await ws.write("media/big.bin", bytes);
  // Read back on the runner's side of the disk (a read of it would not fit the channel's frame either).
  const there = await (await side.held.archil()).workspace.read("media/big.bin");
  assert.equal(Buffer.compare(Buffer.from(there), bytes), 0, "the file on the disk is the bytes written");
  const puts = disk.calls.filter((call) => call.key?.endsWith("/media/big.bin") && call.op !== "getRange" && call.op !== "head");
  assert.deepEqual(puts.map((call) => [call.op, call.size]), [["putObject", bytes.length]], "the runner wrote it once, whole");
  // A write of one piece or less is one call, as before.
  await ws.write("media/small.txt", "small");
  assert.equal(Buffer.from(await (await side.held.archil()).workspace.read("media/small.txt")).toString(), "small");
});
