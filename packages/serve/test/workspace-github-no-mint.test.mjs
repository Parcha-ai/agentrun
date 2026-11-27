// A run in a workspace (workspace-scope.ts) never gets a token of this server's GitHub App (runner/github-app.ts): its
// `checkout: repository` fetches the repository anonymously, as a public one is read, while a run in no workspace on the
// same server still has the App's token minted for it. A server's App is its operator's, never a workspace's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { gitHttp, pullRepo } from "./fixtures/git-http.mjs";
import { connect, connectable, connectedApiOnly, mintsAsked } from "./github-support.mjs";
import { follow, scratch } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const SCANNER = { version: 1, name: "Scanner", instructions: "Answer.", skills: [], tools: ["read"], checkout: "repository" };
const READ = 'Call read with {"path":"repo/main.txt"}\n\nThe repository is https://github.com/acme/widgets.';

test("a run in a workspace on a server with a connected GitHub App checks out its repository with no token minted, anonymously; a run in no workspace still gets the App's token", { timeout: 180_000 }, async (t) => {
  const gh = join(await scratch(t), "gh");
  pullRepo(gh, "acme/widgets");
  const site = await gitHttp(t, gh);
  const server = await connectedApiOnly(t, { faux: FAUX_MCP, harnesses: true, githubWeb: site.url });

  const made = await server.scoped("POST", "/agents", { definition: SCANNER });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const before = server.github.requests.length;
  const scoped = await server.scoped("POST", `/agents/${made.body.agent_id}/runs`, { input: { content: READ }, max_cost_usd: 1 });
  assert.equal(scoped.status, 202, JSON.stringify(scoped.body));
  const { last } = await follow(server.api, scoped.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.match(String((await server.api("GET", `/runs/${scoped.body.run_id}`)).body.result?.final_answer), /base 1/, "the run read its checkout");
  assert.deepEqual(mintsAsked(server.github, before), [], "no installation token was minted for the run in a workspace");
  assert.ok(site.seen.length > 0 && site.seen.every((request) => request.authorization === null), "every fetch was anonymous");

  // A self-hosted install (no workspaces) with the App connected: its run's checkout still has the App's token.
  const fetched = site.seen.length;
  const own = await connectable(t, { faux: FAUX_MCP, harnesses: true, githubWeb: site.url });
  await connect(own);
  const ownAgent = await own.api("POST", "/agents", { definition: SCANNER });
  assert.equal(ownAgent.status, 201, JSON.stringify(ownAgent.body));
  const asked = own.github.requests.length;
  const unscoped = await own.api("POST", `/agents/${ownAgent.body.agent_id}/runs`, { input: { content: READ }, max_cost_usd: 1 });
  assert.ok([201, 202].includes(unscoped.status), JSON.stringify(unscoped.body));
  assert.equal((await follow(own.api, unscoped.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 })).last.status, "completed");
  assert.equal(mintsAsked(own.github, asked).length, 1, "the run in no workspace had the App's token minted");
  assert.ok(site.seen.length > fetched && site.seen.slice(fetched).every((request) => request.authorization !== null), "and fetched with it");
});
