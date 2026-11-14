// A per_run MCP server through the v2 API: saved with no credential kept (its headers only list its tools), and each run's
// own credential handed as mcp_auth on its start and on a message. The credential is sealed into the run's launch record,
// bound to the run, and never reaches the launch body, the run's view or timeline, or an Idempotency-Key's fingerprint; a
// name that is not a saved per_run server is refused before any run is made. (The runner's use of it: runner-mcp.test.mjs
// R16-R18.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openRunMcpAuth } from "../dist/store/index.js";
import { serve, storeBytes } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const LIST = `not-a-secret-${"per-run-list-token"}`;
const FIRST = `not-a-secret-${"per-run-first-token"}`;
const SECOND = `not-a-secret-${"per-run-second-token"}`;
const inline = (extra = {}) => ({ external: { source: "grep", kind: "expert", id: "7", version: 1 }, definition: { name: "Expert 7", instructions: "Answer.", skills: [], tools: ["mcp:gw/add"] }, input: { content: "Hi" }, ...extra });
const bearer = (token) => ({ gw: { headers: { authorization: `Bearer ${token}` } } });

test("mcp_auth: a per_run server saved with the API token; sealed into the run's launch bound to the run, kept out of its body, view, timeline and the idempotency fingerprint; a message's replaces it; a name that is no per_run server is 422", async (t) => {
  // Lists its tools only to a caller it knows, as a gateway that scopes a token to one run does.
  const fake = await startFakeMcp({ token: (authorization) => [LIST, FIRST, SECOND].some((token) => authorization === `Bearer ${token}`) });
  t.after(() => fake.close());
  const server = await serve(t, { runner: false });
  const { api, store, data } = server;
  // Saved with the API token, as a host's backend saves it: a per_run save keeps no secret, so it is no secret write.
  const saved = await api("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } }, { authorization: `Bearer ${server.token}` });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.auth.type, saved.body.credential, saved.body.tools.some((tool) => tool.name === "add")], ["per_run", null, true], "listed with the headers sent, and nothing kept");
  assert.equal((await store.mcp.server("gw")).sealed, null, "no credential in its row");
  await api("PUT", "/settings/mcp-servers/plain", { url: fake.url, auth: { type: "bearer", token: LIST } });

  // Refused before any run is made: a server that keeps its own credential, one not saved, and a malformed entry.
  for (const [mcp_auth, field] of [[{ plain: { headers: { authorization: "Bearer x" } } }, "mcp_auth.plain"], [{ nope: { headers: { authorization: "Bearer x" } } }, "mcp_auth.nope"], [{ gw: { headers: {} } }, "mcp_auth.gw.headers"], [{ gw: "Bearer x" }, "mcp_auth.gw"]]) {
    const refused = await api("POST", "/runs", inline({ mcp_auth }));
    assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field], [422, field], JSON.stringify(refused.body));
  }
  assert.equal((await store.runs.list({})).length, 0, "no run made");

  const started = await api("POST", "/runs", inline({ mcp_auth: bearer(FIRST) }), { "idempotency-key": "launch-1" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The server's seal key, as it keeps it in its data directory (seal-key.ts).
  const key = Buffer.from(readFileSync(join(data, "seal", "seal.key"), "utf8").split("\n")[0].trim(), "base64");
  const launch = await store.runs.launch(runId);
  assert.deepEqual(openRunMcpAuth(key, runId, launch.sealed), { gw: { headers: { authorization: `Bearer ${FIRST}` }, origin: new URL(fake.url).origin } }, "sealed for this run, bound to the server's origin");
  assert.equal(openRunMcpAuth(key, "another-run", launch.sealed), undefined, "and for no other run");
  assert.equal(JSON.stringify(launch.body).includes("mcp_auth"), false, "not in the launch body");
  // A retry under the same key with a credential minted again is the same request: its first answer, not a mismatch.
  const retried = await api("POST", "/runs", inline({ mcp_auth: bearer(SECOND) }), { "idempotency-key": "launch-1" });
  assert.deepEqual([retried.status, retried.body.run_id, retried.headers.get("idempotent-replayed")], [202, runId, "true"], JSON.stringify(retried.body));

  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", mcp_auth: bearer(SECOND) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.deepEqual(openRunMcpAuth(key, runId, (await store.runs.launch(runId)).sealed).gw.headers, { authorization: `Bearer ${SECOND}` }, "the message's credential replaced the run's");
  const refusedMessage = await api("POST", `/runs/${runId}/messages`, { content: "Again", mcp_auth: { plain: { headers: { authorization: "Bearer x" } } } });
  assert.deepEqual([refusedMessage.status, refusedMessage.body.error?.fields?.[0]?.field], [422, "mcp_auth.plain"]);

  const shown = JSON.stringify([(await api("GET", `/runs/${runId}`)).body, (await api("GET", `/runs/${runId}/timeline`)).body, (await store.commands(runId, 0)).map((command) => command.body)]);
  await store.flush();
  for (const token of [FIRST, SECOND]) {
    assert.equal(shown.includes(token), false, "no credential in the run's view, timeline or command rows");
    assert.equal(storeBytes(data).includes(Buffer.from(token)), false, "nor in the store's bytes in the clear");
  }
});

test("mcp_auth on a retry: a request its Idempotency-Key already answered replays that answer after its per_run server is changed or deleted; new work still checks the server", async (t) => {
  const fake = await startFakeMcp({ token: (authorization) => [LIST, FIRST, SECOND].some((token) => authorization === `Bearer ${token}`) });
  t.after(() => fake.close());
  const server = await serve(t, { runner: false });
  const { api } = server;
  const saved = await api("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } }, { authorization: `Bearer ${server.token}` });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const started = await api("POST", "/runs", inline({ mcp_auth: bearer(FIRST) }), { "idempotency-key": "launch-2" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", mcp_auth: bearer(SECOND) }, { "idempotency-key": "message-2" });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));

  // The server no longer takes a run's credential: the requests already answered are not new work, so they replay.
  const changed = await api("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "bearer", token: LIST } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const retried = await api("POST", "/runs", inline({ mcp_auth: bearer(SECOND) }), { "idempotency-key": "launch-2" });
  assert.deepEqual([retried.status, retried.body.run_id, retried.headers.get("idempotent-replayed")], [202, runId, "true"], JSON.stringify(retried.body));
  const resent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", mcp_auth: bearer(FIRST) }, { "idempotency-key": "message-2" });
  assert.deepEqual([resent.status, resent.body.message_id, resent.headers.get("idempotent-replayed")], [202, sent.body.message_id, "true"], JSON.stringify(resent.body));

  // New work under a new key is checked against the server as it is now.
  const refused = await api("POST", `/runs/${runId}/messages`, { content: "Again", mcp_auth: bearer(FIRST) }, { "idempotency-key": "message-3" });
  assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field], [422, "mcp_auth.gw"], JSON.stringify(refused.body));
  // Deleted: a message its key answered still replays; a new one naming the server is refused.
  assert.equal((await api("DELETE", "/settings/mcp-servers/gw")).status, 204);
  const afterDelete = await api("POST", `/runs/${runId}/messages`, { content: "And then?", mcp_auth: bearer(SECOND) }, { "idempotency-key": "message-2" });
  assert.deepEqual([afterDelete.status, afterDelete.body.message_id, afterDelete.headers.get("idempotent-replayed")], [202, sent.body.message_id, "true"], JSON.stringify(afterDelete.body));
  const gone = await api("POST", `/runs/${runId}/messages`, { content: "Once more", mcp_auth: bearer(FIRST) }, { "idempotency-key": "message-4" });
  assert.deepEqual([gone.status, gone.body.error?.fields?.[0]?.field], [422, "mcp_auth.gw"], JSON.stringify(gone.body));
});
