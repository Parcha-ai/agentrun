// The planted-secret harness: every registered plant (fixtures/planted-secrets.mjs) puts a distinct value through a
// secret write route as the owner's session; then everything that could be read is read (every GET operation of the
// served API document, as the token and as the owner's session; the store's bytes on disk, its DB and WAL, which hold
// every row, the journal's and trigger firings' among them; the server's log and its stderr; an agent's export), and no
// planted value may show in any of its forms (as is, base64, hex, URL-encoded, JSON-escaped, or a 16-character piece).
// The plants' own answers are read too, all but a minting answer to the owner's session (a plant's `mints`): a value shown
// once there is allowed, and anywhere else is a hit. A GET whose path needs an id no plant made is skipped and named.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agent, call, cookieOf, follow, serve, storeBytes, withEnv } from "./support.mjs";
import { answerSources, filledPaths, findPlanted, formsOf, mergedIds, operationOf, plantedOf, plantedValue, registeredPlants } from "./fixtures/planted-secrets.mjs";

const json = { "content-type": "application/json" };
const FAUX_CALL = new URL("./fixtures/faux-call.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;

test("the harness finds a planted value in every form it looks for (a leak it is shown, in the test alone)", () => {
  const value = plantedValue("leak");
  const forms = formsOf(value);
  for (const [form, text] of Object.entries(forms)) {
    const hits = findPlanted([{ where: `a leaky source (${form})`, text: `before ${text} after` }], [value]);
    assert.ok(hits.some((hit) => hit.form === form), `${form} is found: ${JSON.stringify(hits)}`);
  }
  assert.deepEqual(findPlanted([{ where: "clean", text: "nothing here" }], [value]), []);
});

test("a value shown once is allowed in its minting answer to the owner's session alone: a token's answer, another operation's, a later one are hits", () => {
  const value = plantedValue("whsec");
  const shown = { method: "POST", path: "/v2/triggers", operation: "createTrigger", status: 201, text: JSON.stringify({ signing_secret: value }) };
  const answers = [
    { ...shown, by: "session" },
    { ...shown, by: "token" },
    { ...shown, by: "session", method: "GET", path: "/v2/triggers/t1", operation: "getTrigger", status: 200 },
  ];
  const hits = findPlanted(answerSources(answers, ["createTrigger"]), [value]).map((hit) => hit.where);
  assert.ok(!hits.some((where) => where.startsWith("POST /v2/triggers (session")), `the owner's minting answer is allowed: ${hits}`);
  assert.ok(hits.some((where) => where.startsWith("POST /v2/triggers (token")), "a token caller's answer is a hit");
  assert.ok(hits.some((where) => where.startsWith("GET /v2/triggers/t1")), "a later answer is a hit");
  assert.equal(findPlanted(answerSources(answers, []), [value]).length >= 3, true, "with no mints declared, every answer is a hit");
});

test("no planted secret shows in any GET (by every id a plant made), a plant's answer but its minting one to the owner, the store's bytes, the log or an export", { timeout: 240_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const logs = [];
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (stderr.push(String(chunk)), write(chunk, ...rest));
  t.after(() => (process.stderr.write = write));
  const server = await serve(t, { runner: false, accounts: true, openSetup: true, log: (line) => logs.push(line) });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: `owner-${randomBytes(12).toString("hex")}` } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const doc = (await server.api("GET", "/openapi.json")).body;
  // Every answer a plant gets, as the owner's session or as the token, is read too (answerSources).
  const answers = [];
  const as = (by, headers) => async (method, path, body) => {
    const res = await call(server.port, { method, path, headers: { ...json, ...headers }, body: body ?? (method === "GET" ? undefined : {}) });
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {}
    answers.push({ by, method, path, operation: operationOf(doc, method, path), status: res.status, text: `${JSON.stringify(res.headers)}\n${res.text}` });
    return { status: res.status, text: res.text, json: parsed };
  };
  const ctx = { owner: as("session", { cookie, origin }), token: as("token", { authorization: `Bearer ${server.token}` }), api: server.api, server };
  // An agent, so the routes under /agents/{id} (its export among them) have one to read.
  const agentId = "harness-agent";
  assert.equal((await server.api("POST", "/agents", agent(agentId))).status, 201);

  const planteds = [];
  const ran = [];
  for (const plant of registeredPlants()) {
    planteds.push(plantedOf(plant, await plant.write(ctx)));
    ran.push(plant.name);
  }
  const values = planteds.flatMap((planted) => planted.values);
  assert.ok(values.length >= 2, `the plants ran: ${ran.join(", ")}`);

  // Every GET of the served document, by every id the plants made, as the token and as the owner's session.
  const ids = mergedIds(planteds, { agent_id: agentId, key_id: ["monid", "openrouter"] });
  const sources = answerSources(answers, planteds.flatMap((planted) => planted.mints));
  const skipped = [];
  let read = 0;
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item.get) continue;
    const filled = filledPaths(path, ids);
    if (!filled.length) {
      skipped.push(`GET ${path}`);
      continue;
    }
    for (const one of filled) {
      const byToken = await call(server.port, { path: `/v2${one}`, headers: { authorization: `Bearer ${server.token}` } });
      sources.push({ where: `GET ${one} (token, ${byToken.status})`, text: `${JSON.stringify(byToken.headers)}\n${byToken.text}` });
      const bySession = await call(server.port, { path: `/v2${one}`, headers: { cookie, origin } });
      sources.push({ where: `GET ${one} (session, ${bySession.status})`, text: `${JSON.stringify(bySession.headers)}\n${bySession.text}` });
      read += 2;
    }
  }
  const account = await call(server.port, { path: "/v2/auth/session", headers: { cookie, origin } });
  sources.push({ where: "GET /v2/auth/session", text: account.text });
  // The store's bytes on disk: the DB and its WAL hold every row (journal, trigger firings, settings), sealed or not.
  const bytes = storeBytes(server.data);
  sources.push({ where: "store.sqlite (+wal, shm), utf8", text: bytes.toString("utf8") }, { where: "store.sqlite (+wal, shm), latin1", text: bytes.toString("latin1") });
  sources.push({ where: "the server's log", text: logs.join("\n") }, { where: "the server's stderr", text: stderr.join("") });

  const hits = findPlanted(sources, values);
  assert.deepEqual(hits, [], `a planted secret showed (skipped: ${skipped.join(", ") || "none"})`);
  for (const planted of planteds) if (planted.cleanup) await planted.cleanup(ctx, ids);
  t.diagnostic(`plants: ${ran.join(", ")}; GETs read: ${read}; answers read: ${answers.length}; skipped: ${skipped.length ? skipped.join(", ") : "none"}`);
});

// A key saved on the server reaches a run as the claim opens it: when its vendor answers an error that echoes it, the
// run's records hold none of it, as for a key the server was started with. The runner's redactor must hold the claim's
// opened keys as well as its own environment's.
test("a stored tool key a vendor echoes back in an error shows in none of the run's records: its timeline, its view and answer, the store's bytes (the journal's rows) and the server's log", { timeout: 120_000, skip: "waits on the runner adding a claim's opened keys to its redactor (runnerSecrets extra)" }, async (t) => {
  const planted = plantedValue("sk-planted-monid");
  const calls = join(mkdtempSync(join(tmpdir(), "planted-monid-")), "calls.jsonl");
  t.after(() => rmSync(dirname(calls), { recursive: true, force: true }));
  withEnv(t, {
    AGENTRUN_TEST_FAUX_MONID_CALLS: calls,
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    // Faux monid takes the planted key at its save's check (a discover), and answers a run's inspect with an error that
    // holds the key it was sent.
    AGENTRUN_TEST_FAUX_MONID_ACCEPTS: createHash("sha256").update(planted).digest("hex"),
    AGENTRUN_TEST_FAUX_MONID_ECHO: "/v1/inspect",
  }, ["MONID_API_KEY", "AGENTRUN_TEST_FAUX_MONID_ACCEPTS", "AGENTRUN_TEST_FAUX_MONID_ECHO", "AGENTRUN_TEST_FAUX_MONID_CALLS"]);
  const logs = [];
  const { api, data } = await serve(t, { faux: FAUX_CALL, fauxMonid: FAUX_MONID, log: (line) => logs.push(line) });
  // Saved from the owner's session (support.mjs sends a secret write so).
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: planted } })).status, 204);
  assert.equal((await api("POST", "/agents", agent("echoed", { tools: ["monid.inspect"], tool_settings: { "monid.inspect": { permission: "allow" } } }))).status, 201);
  const run = await api("POST", "/agents/echoed/runs", { input: { content: 'Call monid_inspect with {"provider":"faux","endpoint":"/person/enrich"}.' } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  // The call reached faux monid on the stored key (its log keeps a digest of the key it was sent, never the key), so its
  // error, which echoes that key, came back to the run: never a run with no such tool.
  const sent = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const digest = createHash("sha256").update(planted).digest("hex").slice(0, 16);
  assert.ok(sent.some((call) => call.path === "/v1/inspect" && call.key === digest), `the run's inspect reached monid on the stored key: ${JSON.stringify(rows.map((row) => `${row.kind}: ${row.summary}`))}`);
  const sources = [
    { where: "the run's timeline", text: JSON.stringify(rows) },
    { where: "the run's view and answer", text: JSON.stringify(view) },
    { where: "store.sqlite (+wal, shm), utf8", text: storeBytes(data).toString("utf8") },
    { where: "the server's log", text: logs.join("\n") },
  ];
  assert.deepEqual(findPlanted(sources, [planted]), [], "the stored key showed in the run's records");
});
