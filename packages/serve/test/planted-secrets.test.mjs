// The planted-secret harness: every registered plant (fixtures/planted-secrets.mjs) puts a distinct value through a
// secret write route as the owner's session; then everything that could be read is read (every GET operation of the
// served API document, as the token and as the owner's session; the store's bytes on disk, its DB and WAL, which hold
// every row, the journal's and trigger firings' among them; the server's log and its stderr; an agent's export), and no
// planted value may show in any of its forms (as is, base64, hex, URL-encoded, JSON-escaped, or a 16-character piece).
// The plants' own answers are read too, all but a minting answer to the owner's session (a plant's `mints`): a value shown
// once there is allowed, and anywhere else is a hit. A GET whose path needs an id no plant made is skipped and named.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, call, cookieOf, serve, storeBytes, withEnv } from "./support.mjs";
import { answerSources, filledPaths, findPlanted, formsOf, mergedIds, operationOf, plantedOf, plantedValue, registeredPlants } from "./fixtures/planted-secrets.mjs";

const json = { "content-type": "application/json" };

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
