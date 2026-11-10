// --faux-github (with --faux only): a fake GitHub App, connected at the start, its API answered in the server's process
// (github-faux.ts), so the console's GitHub flows run with nothing sent to GitHub. Its webhook secret is kept beside the
// data for a test's signed delivery. A data directory another GitHub App is connected in is refused, never taken over.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect, connectable, deliver } from "./github-support.mjs";
import { agent, serve } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const pr = (repo) => ({ action: "opened", number: 3, pull_request: { number: 3, draft: false, title: "A change" }, repository: { full_name: repo }, installation: { id: 1 }, sender: { login: "dev" } });

test("a --faux-github server reads connected, makes a github trigger, and a delivery signed with its kept webhook secret fires it; started again, it connects afresh", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { fauxGitHub: true });
  const view = await server.api("GET", "/integrations/github");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual([view.body.connected, view.body.slug, view.body.installations], [true, "agentrun-faux", [{ id: 1, account: "faux-org" }]], JSON.stringify(view.body));
  const kept = JSON.parse(readFileSync(join(server.data, "faux-github.json"), "utf8"));
  assert.deepEqual([kept.installation, kept.account, kept.repositories], [1, "faux-org", ["faux-org/demo"]]);
  assert.equal((await server.api("POST", "/agents", agent("reviewer"))).status, 201);
  const made = await server.api("POST", "/triggers", { name: "prs", source: { kind: "github", accept: [{ event: "pull_request", where: [{ pointer: "/repository/full_name", in: ["faux-org/demo"] }] }] }, target: { kind: "start_run", agent_id: "reviewer", input: { content: "Review it." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const fired = await deliver(server.baseUrl, kept.webhook_secret, "pull_request", pr("faux-org/demo"));
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const [firing] = await firings(server.api, made.body.id, 1);
  assert.ok(firing.run_id, JSON.stringify(firing));
  assert.equal((await deliver(server.baseUrl, "not-a-secret", "pull_request", pr("faux-org/demo"))).status, 401, "a delivery signed otherwise is refused");
  await server.close();
  const again = await serve(t, { data: server.data, fauxGitHub: true });
  const fresh = JSON.parse(readFileSync(join(server.data, "faux-github.json"), "utf8"));
  assert.notEqual(fresh.webhook_secret, kept.webhook_secret, "a fresh App at each start");
  assert.equal((await again.api("GET", "/integrations/github")).body.connected, true);
});

test("--faux-github on a data directory another GitHub App is connected in refuses to start, and that App stays", { timeout: 120_000 }, async (t) => {
  const server = await connectable(t);
  await connect(server);
  await server.close();
  await assert.rejects(serve(t, { data: server.data, fauxGitHub: true }), /--faux-github connects a fake GitHub App, and this data directory has the GitHub App agentrun-test-app connected/);
  const again = await serve(t, { data: server.data, githubApi: server.github.url });
  assert.equal((await again.api("GET", "/integrations/github")).body.slug, "agentrun-test-app");
});
