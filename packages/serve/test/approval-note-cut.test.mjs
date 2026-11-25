// An approval's note (POST /runs/{id}/approvals/{id}), which the server writes into the run's deny command, is cut of
// what the run holds, read in the turn that writes it (server.ts cutHeld), as a message is: the run's end erases those
// values, and a read after it could no longer cut them. A run whose launch's sealed part doesn't open here takes no
// note: 409 not_continuable, reason withheld, and nothing is written. The run holds a key through its launch's sealed
// part, written here as a launch that was handed one seals it (store/seal.ts sealRunLaunch). No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import * as handedValues from "../dist/handed-values.js";
import { sealRunLaunch } from "../dist/store/seal.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { raw } from "./store-target.mjs";
import { agent, call, clientOwnerSession, follow, serve, whenFree, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"held-text-cut-tool-key"}-7c41e2`;
const TOKEN = `not-a-secret-${"held-text-cut-bearer-0456"}`;
const json = { "content-type": "application/json" };
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;

/** A server whose seal key the test holds, so it can seal a launch as a handed one is sealed. */
async function sealed(t, options) {
  const text = randomBytes(32).toString("base64");
  withEnv(t, { AGENTRUN_SEAL_KEY: text });
  const server = await serve(t, options);
  return { ...server, sealKey: Buffer.from(text, "base64") };
}

/** One raw write to the server's store under `data`. */
async function write(data, sql, ...params) {
  const db = await raw(join(data, "store.sqlite"), { timeout: 30_000 });
  try {
    await db.run(sql, ...params);
  } finally {
    await db.close();
  }
}

/** Run `runId`'s launch made to hold KEY, as a launch handed it as a tool key is sealed. */
const holdKey = (server, runId) => write(server.data, "UPDATE run_launch SET sealed = ? WHERE run_id = ?", sealRunLaunch(server.sealKey, runId, { keys: { HELD_TOOL_KEY: KEY } }), runId);
/** Run `runId`'s launch's sealed part damaged: it no longer opens. */
const damageSeal = (server, runId) => write(server.data, "UPDATE run_launch SET sealed = ? WHERE run_id = ?", new Uint8Array(64).fill(9), runId);
/** Every command row of run `runId`, as text. */
const commandsOf = async (server, runId) => JSON.stringify((await server.store.commands(runId, 0)).map((command) => ({ kind: command.kind, body: command.body })));
const withheld = (res) => [res.status, res.json?.error?.code ?? res.body?.error?.code, (res.json ?? res.body)?.error?.details?.reason];

/** A run of a fresh agent parked on an MCP call that waits for its owner's approval, and how the owner answers it. */
async function parkedRun(t, id) {
  const server = await sealed(t, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const { api } = server;
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await whenFree(() => api("POST", "/agents", agent(id, { tools: ["mcp:fake/add"] })))).status, 201);
  const started = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: 'Call mcp__fake__add with {"a":2,"b":3}' } }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  const pending = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.equal(pending?.kind, "approval", JSON.stringify(pending));
  const { cookie, origin } = await clientOwnerSession(server);
  const answer = async (body) => {
    const res = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${pending.id}`, headers: { ...json, cookie, origin }, body });
    return { status: res.status, json: res.json };
  };
  return { server, runId, answer };
}

test("an approval's deny note that repeats a key the run holds is cut of it in the deny's command row", { timeout: 120_000 }, async (t) => {
  const { server, runId, answer } = await parkedRun(t, "note-cut");
  await holdKey(server, runId);
  assert.equal((await answer({ decision: "deny", note: `Not with ${KEY}.` })).status, 204);
  const commands = await commandsOf(server, runId);
  assert.equal(commands.includes(KEY), false, `in no command row: ${commands}`);
  assert.match(commands, /Not with \[redacted\]\./, `the note is kept, cut in place: ${commands}`);
});

test("a deny note to a run whose launch's sealed part doesn't open here is refused (409 not_continuable, reason withheld) and nothing is written; an answer with no note is taken", { timeout: 120_000 }, async (t) => {
  const { server, runId, answer } = await parkedRun(t, "note-withheld");
  await damageSeal(server, runId);
  const before = await commandsOf(server, runId);
  const refused = await answer({ decision: "deny", note: `Not with ${KEY}.` });
  assert.deepEqual(withheld(refused), [409, "not_continuable", "withheld"], JSON.stringify(refused.json));
  assert.equal(refused.json.error.message, handedValues.WITHHELD_MESSAGE);
  assert.equal(await commandsOf(server, runId), before, "no command row written");
  assert.equal((await answer({ decision: "deny" })).status, 204, "a deny with no note hands no words to cut: taken");
});
