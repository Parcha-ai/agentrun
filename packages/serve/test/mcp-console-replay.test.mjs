// The console's MCP servers page and agent editor, their requests replayed: apps/console/src/fixtures/mcp.requests.json
// holds what those pages send (their tests assert it), and here each goes to a real server with the fake MCP servers
// on loopback, so a body the console builds is one this server takes, and an answer has what the console reads.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

const recorded = JSON.parse(readFileSync(new URL("../../../apps/console/src/fixtures/mcp.requests.json", import.meta.url), "utf8"));

test("the console's MCP requests, replayed on a real server, are taken and answered as the console reads them", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t);
  const token = `not-a-secret-${randomBytes(8).toString("hex")}`;
  const mcp = await startFakeMcp({ token });
  const as = await startFakeOAuth();
  const docs = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
  t.after(() => Promise.all([mcp.close(), as.close(), docs.close()]));
  const vars = { url: mcp.url, token, wrong_token: `not-the-token-${randomBytes(8).toString("hex")}`, oauth_url: docs.url };
  const fill = (value) => JSON.parse(Object.entries(vars).reduce((text, [key, to]) => text.split(`{${key}}`).join(to), JSON.stringify(value)));
  // The agent the editor's test edits, as it reads it.
  const grant = recorded.requests.find((r) => r.step === "grant fake/add");
  assert.equal((await api("POST", "/agents", agent("calc", { name: "Calc", harness: "pi", tools: ["read"] }))).status, 201);

  const answers = {};
  for (const request of recorded.requests.map(fill)) {
    const headers = request.path.startsWith("/v2/agents/") ? { "if-match": (await api("GET", "/agents/calc")).headers.get("etag") } : {};
    answers[request.step] = await api(request.method, request.path.slice("/v2".length), request.body, headers);
  }
  const said = (step) => JSON.stringify(answers[step].body);

  assert.equal(answers["preview, a wrong token"].status, 422, said("preview, a wrong token"));
  assert.equal(answers["preview, a wrong token"].body.error.code, "auth_required");
  assert.equal(answers["preview, a wrong token"].body.error.details.auth, "bearer");

  const preview = answers.preview.body;
  assert.equal(answers.preview.status, 200, said("preview"));
  assert.equal(preview.protocol, "2026-07-28");
  assert.deepEqual(preview.server_info, { name: "fake-mcp", version: "1.0.0" });
  const add = preview.tools.find((x) => x.name === "add");
  assert.deepEqual([add.title, add.description], ["Add", "Add two numbers."]);

  for (const step of ["save", "save again, the token kept"]) {
    assert.equal(answers[step].status, 200, said(step));
    assert.deepEqual([answers[step].body.name, answers[step].body.credential, answers[step].body.tools.length], ["fake", "sealed", 4], step);
  }
  assert.deepEqual(answers["the list"].body.servers.map((s) => [s.name, s.url, s.credential]), [["fake", mcp.url, "sealed"]]);
  for (const step of Object.keys(answers)) assert.ok(!said(step).includes(token), `${step}: no answer holds the token`);

  assert.equal(answers.refresh.status, 200, said("refresh"));
  assert.deepEqual([answers.refresh.body.added, answers.refresh.body.removed, answers.refresh.body.changed, answers.refresh.body.server.name], [[], [], [], "fake"]);

  assert.equal(answers["grant fake/add"].status, 200, said("grant fake/add"));
  assert.deepEqual(answers["grant fake/add"].body.definition.tools, grant.body.definition.tools);

  assert.equal(answers["preview, a server behind OAuth"].status, 422, said("preview, a server behind OAuth"));
  assert.equal(answers["preview, a server behind OAuth"].body.error.details.auth, "oauth");
  assert.equal(answers["sign in"].status, 200, said("sign in"));
  // The browser opens the page, the fake approves, and its redirect brings the browser, with the cookie the start set
  // (as the console's same-origin request keeps it), back to the console's page.
  const asked = await fetch(answers["sign in"].body.authorization_url, { redirect: "manual" });
  const cookie = answers["sign in"].headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "the start sets the sign-in's cookie");
  const back = await fetch(asked.headers.get("location"), { redirect: "manual", headers: { cookie } });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("location"), recorded.sign_in_return);

  assert.equal(answers.delete.status, 204);
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body.servers.map((s) => s.name), ["docs"]);
});
