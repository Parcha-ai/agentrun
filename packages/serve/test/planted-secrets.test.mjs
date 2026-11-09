// The planted-secret harness: every registered plant (fixtures/planted-secrets.mjs) puts a distinct value through a
// secret write route as the owner's session; then everything that could be read is read (every GET operation of the
// served API document, as the token and as the owner's session; the store's bytes on disk, its DB and WAL, which hold
// every row, the journal's and trigger firings' among them; the server's log and its stderr; an agent's export), and no
// planted value may show in any of its forms (as is, base64, hex, URL-encoded, JSON-escaped, or a 16-character piece).
// A GET whose path needs an id the harness can't make is skipped and named.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, call, cookieOf, serve, storeBytes, withEnv } from "./support.mjs";
import { findPlanted, formsOf, plantedValue, registeredPlants } from "./fixtures/planted-secrets.mjs";

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

test("no planted secret shows in any GET, the store's bytes, the log or an export", { timeout: 240_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const logs = [];
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (stderr.push(String(chunk)), write(chunk, ...rest));
  t.after(() => (process.stderr.write = write));
  const server = await serve(t, { runner: false, log: (line) => logs.push(line) });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: `owner-${randomBytes(12).toString("hex")}` } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const owner = async (method, path, body) => {
    const res = await call(server.port, { method, path, headers: { ...json, cookie, origin }, body: body ?? (method === "GET" ? undefined : {}) });
    return { status: res.status, text: res.text };
  };
  // An agent, so the routes under /agents/{id} (its export among them) have one to read.
  const agentId = "harness-agent";
  assert.equal((await server.api("POST", "/agents", agent(agentId))).status, 201);

  const values = [];
  const ran = [];
  for (const plant of registeredPlants()) {
    values.push(...(await plant.write({ owner, api: server.api, server })));
    ran.push(plant.name);
  }
  assert.ok(values.length >= 2, `the plants ran: ${ran.join(", ")}`);

  // Every GET of the served document, as the token and as the owner's session.
  const doc = (await server.api("GET", "/openapi.json")).body;
  const ids = { agent_id: agentId, id: agentId, key_id: "monid" };
  const sources = [];
  const skipped = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item.get) continue;
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (params.some((name) => !(name in ids))) {
      skipped.push(`GET ${path}`);
      continue;
    }
    const filled = path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(ids[name]));
    const byToken = await call(server.port, { path: `/v2${filled}`, headers: { authorization: `Bearer ${server.token}` } });
    sources.push({ where: `GET ${filled} (token, ${byToken.status})`, text: `${JSON.stringify(byToken.headers)}\n${byToken.text}` });
    const bySession = await call(server.port, { path: `/v2${filled}`, headers: { cookie, origin } });
    sources.push({ where: `GET ${filled} (session, ${bySession.status})`, text: `${JSON.stringify(bySession.headers)}\n${bySession.text}` });
  }
  const account = await call(server.port, { path: "/v2/auth/session", headers: { cookie, origin } });
  sources.push({ where: "GET /v2/auth/session", text: account.text });
  // The store's bytes on disk: the DB and its WAL hold every row (journal, trigger firings, settings), sealed or not.
  const bytes = storeBytes(server.data);
  sources.push({ where: "store.sqlite (+wal, shm), utf8", text: bytes.toString("utf8") }, { where: "store.sqlite (+wal, shm), latin1", text: bytes.toString("latin1") });
  sources.push({ where: "the server's log", text: logs.join("\n") }, { where: "the server's stderr", text: stderr.join("") });

  const hits = findPlanted(sources, values);
  assert.deepEqual(hits, [], `a planted secret showed (skipped: ${skipped.join(", ") || "none"})`);
  t.diagnostic(`plants: ${ran.join(", ")}; GETs read: ${sources.length - 5}; skipped: ${skipped.length ? skipped.join(", ") : "none"}`);
});
