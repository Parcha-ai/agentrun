// Suggested agents for a request's workspace (workspace-scope.ts): an API-only server's backend serves each tenant its
// own scans and suggestions, and none of them ever reaches the server's GitHub App. The App is the operator's: its
// installations cover the operator's repositories, so a workspace sees GitHub as not connected, its scans and runs fetch
// anonymously (a public repository), and its repository list and creates are 409 github_not_connected. Another
// workspace's suggestion answers the same 404 as a missing one, and each workspace scans with its own scout agent.
// Connecting or disconnecting GitHub stays the operator's: a scoped request for it is 403 not_scoped.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "./support.mjs";

const { servedScoped } = await import("../dist/api-only.js");
const { ROUTES } = await import("../dist/server.js");

const SCOUT = new URL("./fixtures/faux-scout.mjs", import.meta.url).pathname;
const REPO = "faux-org/demo";
const SCOPED = randomBytes(24).toString("hex");
const OPERATOR = randomBytes(24).toString("hex");
const W1 = "org:acme.one_1";
const W2 = "org:other-2";

/** An API-only server with the scout, a fake GitHub whose App is connected, and two tokens: `v2` (scoped) and `ops`. */
const scopedServer = (t) =>
  serve(t, { faux: SCOUT, fauxGitHub: true, publicUrl: "https://agents.example.test", apiOnly: true, tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"] });

async function send(server, method, path, { workspace, token = SCOPED, body } = {}) {
  const res = await fetch(`${server.url}/v2${path}`, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: json };
}
const inW1 = (server, method, path, options = {}) => send(server, method, path, { workspace: W1, ...options });
const inW2 = (server, method, path, options = {}) => send(server, method, path, { workspace: W2, ...options });

/** An id of the same shape as `id` that names nothing. */
const missingLike = (id) => `${id.slice(0, -6)}ffffff`;

/** An answer's text with its request id and `id` in placeholders: two answers that differ only in those are equal. */
const shape = (answer, id) => `${answer.status} ${answer.text.replaceAll(/req_[0-9a-f]{16}/g, "<request>").replaceAll(id, "<id>")}`;

/** The fake GitHub's state (github-faux.ts /_faux/state): what was written, and how many tokens its App minted. */
const fauxState = async (server) => {
  const { api_url: url } = JSON.parse(readFileSync(join(server.data, "faux-github.json"), "utf8"));
  return (await fetch(`${url}/_faux/state`)).json();
};

/** GET /suggestions in `workspace` until the repository's scan has ended. */
async function scanned(server, workspace, { deadlineMs = 60_000 } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const listed = await send(server, "GET", `/suggestions?repo=${encodeURIComponent(REPO)}`, { workspace });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const scan = listed.body.repositories.find((r) => r.repo === REPO)?.scan;
    if (scan && scan.status !== "running") return listed.body;
    if (Date.now() > until) throw new Error(`the scan of ${REPO} in ${workspace} did not end: ${JSON.stringify(listed.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** GET /runs/{id} in `workspace` (with `token`) until the run has ended. */
async function ended(server, workspace, runId, { deadlineMs = 60_000, token = SCOPED } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const run = await send(server, "GET", `/runs/${runId}`, { workspace, token });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    if (["completed", "failed", "cancelled"].includes(run.body.status)) return run.body;
    if (Date.now() > until) throw new Error(`run ${runId} did not end: ${JSON.stringify(run.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a scoped request is served the suggestions and the GitHub reads, never Connect GitHub or its browser legs", () => {
  const at = (method, path) => servedScoped(ROUTES, method, `/v2${path}`);
  for (const [method, path] of [
    ["GET", "/suggestions"],
    ["POST", "/suggestions/scans"],
    ["GET", "/suggestions/sg_00000000000000000000"],
    ["POST", "/suggestions/sg_00000000000000000000/discard"],
    ["POST", "/suggestions/sg_00000000000000000000/restore"],
    ["POST", "/suggestions/sg_00000000000000000000/create"],
    ["GET", "/integrations/github"],
    ["GET", "/integrations/github/repositories"],
  ]) {
    assert.equal(at(method, path), "served", `${method} ${path}`);
  }
  for (const [method, path] of [
    ["POST", "/integrations/github/connect"],
    ["DELETE", "/integrations/github"],
    ["GET", "/integrations/github/callback"],
    ["GET", "/integrations/github/installed"],
  ]) {
    assert.equal(at(method, path), "not_scoped", `${method} ${path}`);
  }
});

test("a workspace sees GitHub as not connected, its repository list is 409, and the server's App mints nothing for it", { timeout: 60_000 }, async (t) => {
  const server = await scopedServer(t);
  const connection = await inW1(server, "GET", "/integrations/github");
  assert.equal(connection.status, 200, connection.text);
  assert.deepEqual(connection.body, { connected: false });
  const repos = await inW1(server, "GET", "/integrations/github/repositories");
  assert.equal(repos.status, 409, repos.text);
  assert.equal(repos.body.error.code, "github_not_connected");
  const listed = await inW1(server, "GET", "/suggestions");
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body, { github: { connected: false, app: null, installations: [], install_url: null }, repositories: [], suggestions: [] });
  assert.equal((await fauxState(server)).minted, 0, "no token of the operator's App");
});

test("each workspace scans with its own scout, sees its own suggestions alone, and fetches the repository anonymously", { timeout: 180_000 }, async (t) => {
  const server = await scopedServer(t);
  // Both at once: neither takes the other's scout agent.
  const [one, two] = await Promise.all([inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO } }), inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO } })]);
  assert.equal(one.status, 202, one.text);
  assert.equal(two.status, 202, two.text);
  assert.notEqual(one.body.agent_id, two.body.agent_id, "a scout agent per workspace");
  assert.notEqual(one.body.run_id, two.body.run_id);
  // Each scout and its run are its workspace's: the other's read is the unknown id's 404.
  const unknownAgent = missingLike(one.body.agent_id);
  assert.equal(shape(await inW2(server, "GET", `/agents/${one.body.agent_id}`), one.body.agent_id), shape(await inW2(server, "GET", `/agents/${unknownAgent}`), unknownAgent));
  assert.equal((await inW2(server, "GET", `/runs/${one.body.run_id}`)).status, 404);

  const w1 = await scanned(server, W1);
  const w2 = await scanned(server, W2);
  assert.equal(w1.repositories[0].scan.status, "completed", JSON.stringify(w1.repositories[0].scan));
  assert.equal(w1.repositories[0].scan.run_id, one.body.run_id, "W1 lists its own scan");
  assert.equal(w2.repositories[0].scan.run_id, two.body.run_id, "W2 lists its own scan");
  assert.match(w1.repositories[0].scan.commit ?? "", /^[0-9a-f]{40}$/, "the anonymous fetch checked the repository out");
  assert.equal(w1.github.connected, false);
  assert.equal((await fauxState(server)).minted, 0, "neither scan's checkout used the operator's App");

  // W1 discards one: W2's suggestion of the same repository and key stays open.
  const [triage] = w1.suggestions;
  assert.equal((await inW1(server, "POST", `/suggestions/${triage.id}/discard`)).body.status, "discarded");
  assert.ok((await inW2(server, "GET", "/suggestions")).body.suggestions.some((s) => s.key === triage.key && s.status === "open"), "W2's own stays open");
  assert.ok(!(await inW1(server, "GET", "/suggestions")).body.suggestions.some((s) => s.key === triage.key), "W1's is gone from its list");
});

test("another workspace's suggestion is the unknown id's 404, and a workspace's create is 409 github_not_connected with nothing written", { timeout: 180_000 }, async (t) => {
  const server = await scopedServer(t);
  const started = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO } });
  assert.equal(started.status, 202, started.text);
  const [triage] = (await scanned(server, W1)).suggestions;
  const unknown = missingLike(triage.id);

  for (const [method, path] of [
    ["GET", ""],
    ["POST", "/discard"],
    ["POST", "/restore"],
    ["POST", "/create"],
  ]) {
    const theirs = await inW2(server, method, `/suggestions/${triage.id}${path}`, method === "POST" && path === "/create" ? { body: {} } : {});
    const none = await inW2(server, method, `/suggestions/${unknown}${path}`, method === "POST" && path === "/create" ? { body: {} } : {});
    assert.equal(theirs.status, 404, `${method} ${path}: ${theirs.text}`);
    assert.equal(shape(theirs, triage.id), shape(none, unknown), `${method} ${path}`);
  }

  const whole = await inW1(server, "GET", `/suggestions/${triage.id}`);
  assert.equal(whole.status, 200, whole.text);
  assert.equal(whole.body.github.ready, false, JSON.stringify(whole.body.github));
  const created = await inW1(server, "POST", `/suggestions/${triage.id}/create`, { body: {} });
  assert.equal(created.status, 409, created.text);
  assert.equal(created.body.error.code, "github_not_connected");
  const after = await fauxState(server);
  assert.deepEqual([Object.keys(after.branches), after.pulls, after.minted], [["main"], [], 0], "no branch, no pull request, no token");
});

test("a run of a workspace's agent with checkout: repository fetches anonymously, whoever starts it", { timeout: 180_000 }, async (t) => {
  const server = await scopedServer(t);
  const made = await inW1(server, "POST", "/agents", { body: { definition: { version: 1, name: "Reader", instructions: "Read the repository.", skills: [], tools: [], checkout: "repository" } } });
  assert.equal(made.status, 201, made.text);
  const agentId = made.body.agent_id;
  const content = `Read https://github.com/${REPO} and say what it does.`;
  // The same agent on a server with no workspaces does use the App: the fake counts its mint, so a count of 0 below means
  // something.
  const plain = await serve(t, { faux: SCOUT, fauxGitHub: true });
  const own = await plain.api("POST", "/agents", { definition: { version: 1, name: "Reader", instructions: "Read the repository.", skills: [], tools: [], checkout: "repository" } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const plainRun = await plain.api("POST", `/agents/${own.body.agent_id}/runs`, { input: { content } });
  assert.equal(plainRun.status, 202, JSON.stringify(plainRun.body));
  for (const until = Date.now() + 60_000; !["completed", "failed", "cancelled"].includes((await plain.api("GET", `/runs/${plainRun.body.run_id}`)).body.status); ) {
    if (Date.now() > until) throw new Error("the plain server's run did not end");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok((await fauxState(plain)).minted > 0, "an unscoped run's checkout mints with the App");
  const before = (await fauxState(server)).minted;

  // Started by the workspace, through createRun.
  const mine = await inW1(server, "POST", `/agents/${agentId}/runs`, { body: { input: { content } } });
  assert.equal(mine.status, 202, mine.text);
  await ended(server, W1, mine.body.run_id);
  // Started unscoped by the operator: the run is its agent's workspace's all the same.
  const operators = await send(server, "POST", `/agents/${agentId}/runs`, { token: OPERATOR, body: { input: { content } } });
  assert.equal(operators.status, 202, operators.text);
  await ended(server, W1, operators.body.run_id);
  assert.equal((await fauxState(server)).minted, before, "no checkout of a workspace's run used the operator's App");
});

/** An API-only server whose host starts a workspace's runs (a launch hook), and the hook's receiver. */
async function hostedServer(t) {
  const { hookServer } = await import("./trigger-support.mjs");
  const { mintSecret } = await import("../dist/standard-webhooks.js");
  const hook = await hookServer(t);
  const server = await serve(t, { faux: SCOUT, fauxGitHub: true, publicUrl: "https://agents.example.test", apiOnly: true, launchHook: { url: hook.url, secret: mintSecret() }, tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"] });
  return { server, hook };
}

test("on an API-only server with a launch hook, a workspace's scan without start: host is 409 agent_not_runnable, with nothing started or applied", { timeout: 120_000 }, async (t) => {
  const { server, hook } = await hostedServer(t);
  const refused = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.deepEqual((await inW1(server, "GET", "/runs")).body.runs, [], "no run was started");
  assert.deepEqual((await inW1(server, "GET", "/agents")).body.agents, [], "no scout was applied");
  assert.equal(hook.got.length, 0, "nothing was handed to the hook");
  // Nothing was reserved either: the host's own reserve goes through at once.
  assert.equal((await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } })).status, 200);
});

test("there, a workspace's scan is reserved with start: host, the run its host starts is bound once, and another workspace's bind is the unknown run's 404", { timeout: 180_000 }, async (t) => {
  const { server } = await hostedServer(t);
  const reserved = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } });
  assert.equal(reserved.status, 200, reserved.text);
  assert.equal(reserved.body.status, "starting");
  assert.deepEqual((await inW1(server, "GET", "/runs")).body.runs, [], "the reserve starts nothing");
  // The host starts the scout's run with the input it was answered.
  const run = await inW1(server, "POST", `/agents/${reserved.body.agent_id}/runs`, { body: { input: reserved.body.input } });
  assert.equal(run.status, 202, run.text);
  const runId = run.body.run_id;
  // Another workspace binding it, with the reservation's own token, is the unknown run's 404 there.
  const foreign = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: runId, scan: reserved.body.scan } });
  const unknown = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: missingLike(runId), scan: reserved.body.scan } });
  assert.equal(foreign.status, 404, foreign.text);
  assert.equal(shape(foreign, runId), shape(unknown, missingLike(runId)));
  // So is binding it under another workspace's own reservation.
  const theirs = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } });
  assert.equal(theirs.status, 200, theirs.text);
  const crossed = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: runId, scan: theirs.body.scan } });
  const none = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: missingLike(runId), scan: theirs.body.scan } });
  assert.equal(crossed.status, 404, crossed.text);
  assert.equal(shape(crossed, runId), shape(none, missingLike(runId)));
  const bound = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: runId, scan: reserved.body.scan } });
  assert.equal(bound.status, 202, bound.text);
  assert.deepEqual(bound.body, { repo: REPO, run_id: runId, agent_id: reserved.body.agent_id, status: "running", already_running: false });
  const again = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, run_id: runId, scan: reserved.body.scan } });
  assert.deepEqual([again.status, again.body], [202, bound.body], "the same bind answers the same");
  // The bound scan is read as any other: its suggestions are W1's.
  const listed = await scanned(server, W1);
  assert.equal(listed.repositories.find((r) => r.repo === REPO).scan.run_id, runId);
  assert.ok(listed.suggestions.length > 0, JSON.stringify(listed));
  assert.deepEqual((await inW2(server, "GET", "/suggestions")).body.suggestions, []);
});

test("there, a reservation released with its token frees the repository at once, and another workspace's release is the one 404", { timeout: 180_000 }, async (t) => {
  const { server } = await hostedServer(t);
  const reserved = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } });
  assert.equal(reserved.status, 200, reserved.text);
  const foreign = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, scan: reserved.body.scan } });
  const unknown = await inW2(server, "POST", "/suggestions/scans", { body: { repo: REPO, scan: "00000000-0000-4000-8000-000000000000" } });
  assert.equal(foreign.status, 404, foreign.text);
  assert.equal(shape(foreign, reserved.body.scan), shape(unknown, "00000000-0000-4000-8000-000000000000"));
  // W1's reservation still holds.
  assert.equal((await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } })).status, 409);
  const released = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, scan: reserved.body.scan } });
  assert.deepEqual([released.status, released.body], [200, { repo: REPO, status: "released" }], released.text);
  const again = await inW1(server, "POST", "/suggestions/scans", { body: { repo: REPO, start: "host" } });
  assert.equal(again.status, 200, again.text);
  assert.notEqual(again.body.scan, reserved.body.scan);
  assert.deepEqual((await inW1(server, "GET", "/runs")).body.runs, [], "nothing started");
});
