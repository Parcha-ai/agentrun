// A run a person starts by hand (the console's RUN button, POST /agents/{id}/runs) has no GitHub event to name its
// repository, so its github_app MCP calls had none to mint a token for. The start now carries one (the body's `repo`, or the
// agent's one bound repository, run-repo.ts), kept in the run's launch for the runner's mint; a repository the agent is not
// bound to is refused in words, never reached.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { readLaunchBody } from "../dist/run-launch.js";
import { seal } from "../dist/sealing.js";
import { githubAppAccess } from "../dist/runner/github-app.js";
import { GITHUB_UNUSABLE } from "../dist/runner/mcp-github.js";
import { bindingOf, repoOf } from "../dist/run-repo.js";
import { agent, serve } from "./support.mjs";
import { storeOn } from "./store-helpers.mjs";

const trigger = (agentId, repos) => ({ name: `prs-${agentId}`, source: { kind: "github", accept: [{ event: "pull_request", ...(repos ? { where: [{ pointer: "/repository/full_name", in: repos }] } : {}) }] }, target: { kind: "start_run", agent_id: agentId, input: { content: "Review it." }, max_cost_usd: 0.5 } });
const start = (server, agentId, body) => server.api("POST", `/agents/${agentId}/runs`, { input: { content: "Write the notes for the latest release." }, ...body });
const launchOf = async (server, runId) => readLaunchBody((await server.store.runs.launch(runId)).body);

test("a manual start of an agent bound to one repository runs against that repository", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { fauxGitHub: true, runner: false });
  assert.equal((await server.api("POST", "/agents", agent("notes"))).status, 201);
  assert.equal((await server.api("POST", "/triggers", trigger("notes", ["faux-org/demo"]))).status, 201);
  const taken = await start(server, "notes", {});
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  assert.equal((await launchOf(server, taken.body.run_id)).repo, "faux-org/demo", "the agent's one repository is the default");
  const named = await start(server, "notes", { repo: "Faux-Org/Demo" });
  assert.equal(named.status, 202, JSON.stringify(named.body));
  assert.equal((await launchOf(server, named.body.run_id)).repo, "faux-org/demo", "a named one is the bound one, as the agent's trigger spells it");
  const worded = await start(server, "notes", { input: { content: "Notes for https://github.com/faux-org/other please." } });
  assert.equal(worded.status, 202, JSON.stringify(worded.body));
  assert.equal((await launchOf(server, worded.body.run_id)).repo, undefined, "a first message that names its own repository keeps it");
});

test("a start naming a repository the agent is not bound to is refused in words, and no run is made", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { fauxGitHub: true, runner: false });
  assert.equal((await server.api("POST", "/agents", agent("notes"))).status, 201);
  assert.equal((await server.api("POST", "/agents", agent("loose"))).status, 201);
  assert.equal((await server.api("POST", "/triggers", trigger("notes", ["faux-org/demo"]))).status, 201);
  const foreign = await start(server, "notes", { repo: "someone/else" });
  assert.equal(foreign.status, 422, JSON.stringify(foreign.body));
  assert.match(JSON.stringify(foreign.body), /bound to faux-org\/demo, not someone\/else/);
  const unbound = await start(server, "loose", { repo: "faux-org/demo" });
  assert.equal(unbound.status, 422, JSON.stringify(unbound.body));
  assert.match(JSON.stringify(unbound.body), /bound to no GitHub repository/);
  const wrong = await start(server, "notes", { repo: "not a repo" });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.deepEqual((await server.api("GET", "/runs")).body.runs ?? (await server.api("GET", "/runs")).body.data ?? [], [], "no run was made");
});

test("an agent whose trigger takes every repository, or two, is bound to no default", () => {
  const some = (source) => bindingOf([{ source, target: { kind: "start_run", agent_id: "a" } }], "a");
  assert.deepEqual(repoOf(some({ kind: "github", accept: [{ event: "release" }] }), undefined, false), {}, "open: no default");
  assert.deepEqual(repoOf(some({ kind: "github", accept: [{ event: "release", where: [{ pointer: "/repository/full_name", in: ["a/b", "c/d"] }] }] }), undefined, false), {}, "two: no default");
  assert.deepEqual(repoOf(some({ kind: "github", accept: [{ event: "release", where: [{ pointer: "/repository/full_name", in: ["a/b"] }] }] }), undefined, false), { repo: "a/b" });
  assert.equal(repoOf(bindingOf([], "a"), "a/b", false).refused?.includes("bound to no GitHub repository"), true);
});

test("the runner's access takes the launch's repository, and a run with none says what to do, never to reconnect", async (t) => {
  const { store } = await storeOn(t);
  const key = randomBytes(32);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  for (const [field, value] of [["app_id", "4242"], ["private_key", privateKey]]) await store.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(key, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  const input = { content: "Write the notes." };
  assert.deepEqual((await githubAppAccess(store, key, input, { repo: "acme/widgets" })).target, { repo: "acme/widgets" });
  assert.equal((await githubAppAccess(store, key, input)).target, undefined);
  assert.match(GITHUB_UNUSABLE.noRepo, /start the run with a repository/);
  assert.match(GITHUB_UNUSABLE.noRepo, /bind the agent to one repository/);
  assert.doesNotMatch(GITHUB_UNUSABLE.noRepo, /reconnect/i);
});
