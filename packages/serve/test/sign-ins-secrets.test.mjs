// Browser sign-ins under the secrets plan (SECRETS-PLAN.md, tl-browser's row: rules 1, 3 and 5).
// Rule 1: no browser route takes a credential in its body; a sign-in is saved inside a run (the vendor profile with
//   save:true), never by an API write, so the browser plane registers no secret-field predicate and no write route.
// Rule 3: every view of a saved sign-in gives the shared metadata shape { name, set, source, changed_at } beside its
//   state, changed_at being the sign-in's own saved_at; never the pointer, a prefix, a length or a hash.
// Rule 5 (the server half): a planted pointer reaches no GET answer in the whole document, no store row in the clear (the
//   journal's among them), no file under the data directory and no server log line.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { BROWSER_CREDENTIAL_FIELD, browserBodyCredentials, SIGN_IN_SECRET_FIELDS, SIGN_IN_SOURCE, SIGN_IN_WRITE_ROUTES } from "../dist/sign-ins-secrets.js";
import { pointerHash, saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { openSqliteStore, STORE_FILE } from "../dist/store/sqlite/store.js";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { plantedSignIn } from "./sign-ins-planted.mjs";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

const KEY = randomBytes(32);
/** The contract's SignIn fields (vendored, required by it) and the shared secret metadata shape, and no other. */
const SIGN_IN_KEYS = ["changed_at", "held_by", "key", "name", "provider", "set", "source", "state", "verified_at"];
const vendors = { remove: async () => undefined };

// ---- Rule 1: the writes ---------------------------------------------------------------------------------------------

test("rule 1: no browser route takes a credential in its body, so the plane registers no secret field and no write route", () => {
  const doc = openapiDocument(() => undefined);
  const found = browserBodyCredentials(doc);
  // The browser plane's operations, by path: the sign-in forget, the run's browser read and its hand-back; and the browser
  // pick (a provider name, no credential) in the server's tool settings and in an agent's definition (tool_settings).
  assert.deepEqual(found.operations.sort(), ["createAgent#browser", "forgetSignIn", "getRunBrowser", "handBackRunBrowser", "importHome#browser", "putToolSettings#browser", "updateDefinition#browser"].sort(), "the browser plane's operations, all of them looked at");
  assert.deepEqual(found.credentials, [], "no browser operation's body has a credential field");
  assert.deepEqual(found.anywhere, [], "no request body anywhere names a browser credential (a context, a profile, a sign-in ref)");
  // No secret body field, so nothing to register with secret-writes.ts, and no write route for the planted harness.
  assert.deepEqual(Object.keys(SIGN_IN_SECRET_FIELDS), []);
  assert.deepEqual(SIGN_IN_WRITE_ROUTES, []);
  // Nothing in the document marked a secret on a browser operation either (x-agentrun-secret).
  const marked = JSON.stringify(found.bodies).includes("x-agentrun-secret");
  assert.equal(marked, false);
});

test("rule 1: the check catches a browser route that takes a credential (a forged operation in a copy of the document)", () => {
  const doc = structuredClone(openapiDocument(() => undefined));
  doc.paths["/agents/{agent_id}/sign-ins"] = {
    put: { operationId: "saveSignIn", tags: ["agents"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { provider: { type: "string" }, context_id: { type: "string" } } } } } }, responses: {} },
  };
  doc.paths["/settings/elsewhere"] = {
    post: { operationId: "elsewhere", requestBody: { content: { "application/json": { schema: { type: "object", properties: { nested: { type: "object", properties: { profile_name: { type: "string" } } } } } } } }, responses: {} },
  };
  const found = browserBodyCredentials(doc);
  assert.ok(found.operations.includes("saveSignIn"));
  assert.deepEqual(found.credentials, ["saveSignIn.context_id"]);
  assert.deepEqual(found.anywhere.sort(), ["elsewhere.nested.profile_name", "saveSignIn.context_id"]);
  for (const name of ["context_id", "contextId", "profile", "profile_id", "profile_name", "ref", "sign_in_ref", "pointer_sealed", "browserbase_api_key", "KERNEL_API_KEY"]) assert.match(name, BROWSER_CREDENTIAL_FIELD, name);
  for (const name of ["provider", "outcome", "key", "browser", "pointer"]) assert.doesNotMatch(name, BROWSER_CREDENTIAL_FIELD, name);
});

// ---- Rule 3: the views ----------------------------------------------------------------------------------------------

test("rule 3: each sign-in reads the shared metadata shape beside its state; changed_at is its saved_at, not a run's verify", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "bb-ctx-view-1" });
  const savedAt = (await store.signIns.get("alpha", "browserbase")).savedAt;
  assert.equal(savedAt, T0);
  // A run verifies it later: its own time moves verified_at, never changed_at (the pointer is the same).
  clock.now += 60_000;
  await store.signIns.verify("alpha", "browserbase", clock.now);
  const [view] = await signInsOverStore(store, KEY, vendors).view("alpha");
  assert.deepEqual(Object.keys(view).sort(), SIGN_IN_KEYS);
  assert.deepEqual(
    { name: view.name, set: view.set, source: view.source, changed_at: view.changed_at, state: view.state },
    { name: "browserbase", set: true, source: "sign-in", changed_at: new Date(savedAt).toISOString(), state: "ready" },
  );
  assert.equal(SIGN_IN_SOURCE, "sign-in");
  assert.equal(view.verified_at, new Date(clock.now).toISOString());
  // Saved again (a new pointer): changed_at is the new save's.
  clock.now += 1_000;
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "bb-ctx-view-2" });
  const [again] = await signInsOverStore(store, KEY, vendors).view("alpha");
  assert.equal(again.changed_at, new Date(clock.now).toISOString());
  // Nothing of the pointer: not it, a prefix, its length or its hash.
  for (const shown of [view, again]) {
    const text = JSON.stringify(shown);
    for (const pointer of ["bb-ctx-view-1", "bb-ctx-view-2"]) {
      assert.ok(!text.includes(pointer) && !text.includes(pointer.slice(0, 8)), "no pointer or prefix");
      assert.ok(!text.includes(pointerHash(pointer)) && !text.includes(pointerHash(pointer).slice(0, 12)), "no hash");
      assert.ok(!Object.values(shown).includes(pointer.length), "no length");
    }
  }
});

test("rule 3: a sign-in that does not open here is still set, from a sign-in, at its saved_at; one per provider, each named by it", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "bb-ctx-1" });
  clock.now += 5_000;
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "kernel", pointer: "agentrun-kernel-1" });
  const other = await signInsOverStore(store, randomBytes(32), vendors).view("alpha");
  assert.deepEqual(other.map((v) => [v.name, v.set, v.source, v.changed_at, v.state]), [
    ["browserbase", true, "sign-in", new Date(T0).toISOString(), "unreadable"],
    ["kernel", true, "sign-in", new Date(T0 + 5_000).toISOString(), "unreadable"],
  ]);
  for (const view of other) assert.deepEqual(Object.keys(view).sort(), SIGN_IN_KEYS);
});

test("rule 3: the served SignIn schema carries the shared shape, marked as this server's, and required", () => {
  const doc = openapiDocument(() => undefined);
  const signIn = doc.components.schemas.SignIn;
  assert.deepEqual(Object.keys(signIn.properties).sort(), SIGN_IN_KEYS);
  for (const field of ["name", "set", "source", "changed_at"]) {
    assert.equal(signIn.properties[field]["x-agentrun-serve"], "secrets/1", field);
    assert.ok(signIn.required.includes(field), `${field} is always sent`);
  }
  assert.deepEqual(signIn.properties.source.enum, ["env", "console", "sign-in", null]);
  assert.equal(signIn.additionalProperties, false);
});

// ---- Rule 3 and 5 over the server: a planted pointer is found nowhere -----------------------------------------------

/** Every file under `dir`, links not followed. */
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

/** Each table and column of the store (the journal's tables among them) whose value holds `needle` in the clear. */
function storeHits(file, needle) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const hits = [];
    let cells = 0;
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          cells++;
          const text = value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : String(value);
          if (text.includes(needle)) hits.push(`${table}.${column}`);
        }
      }
    }
    return { tables, hits, cells };
  } finally {
    db.close();
  }
}

/** The path of a document operation with each path parameter filled: the planted agent, the run, else a name of none. */
const filled = (path, ids) => path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(ids[name] ?? "none-such"));

test("rule 3 and 5: a planted pointer reaches no GET answer in the document, no store row or journal row, no data file and no log line; the agent's view gives the shape", async (t) => {
  const sealText = randomBytes(32).toString("base64");
  withEnv(t, { AGENTRUN_SEAL_KEY: sealText }, ["AGENTRUN_SEAL_KEY"]);
  // Every line the server and its runner print, from before the start to the end.
  const log = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function (chunk, ...rest) {
      log.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return write.call(this, chunk, ...rest);
    };
    t.after(() => { stream.write = write; });
  }
  const { api, data, baseUrl } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("planted"))).status, 201);
  // Planted as a run's save keeps it: through the store, under the server's seal key.
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  const plant = await plantedSignIn(store, Buffer.from(sealText, "base64"), { agentId: "planted" });
  const savedAt = (await store.signIns.get("planted", "browserbase")).savedAt;
  await store.close();
  assert.match(plant.pointer, /^bb-ctx-PLANTED-[0-9a-f]{24}$/);
  // A run of the agent, so the run reads answer as a run's.
  const run = await api("POST", "/agents/planted/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"]);

  // The agent's view: the shape, its state beside it, changed_at its saved_at.
  const got = await api("GET", "/agents/planted");
  assert.equal(got.status, 200);
  assert.equal(got.body.sign_ins.length, 1);
  const [view] = got.body.sign_ins;
  assert.deepEqual(Object.keys(view).sort(), SIGN_IN_KEYS);
  assert.deepEqual([view.name, view.set, view.source, view.changed_at, view.state], ["browserbase", true, "sign-in", new Date(savedAt).toISOString(), "ready"]);

  // Every GET the owner can call, from the document the server serves.
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const ids = { agent_id: "planted", run_id: run.body.run_id, key: "default", path: "README.md" };
  const walked = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item.get) continue;
    const answer = await api("GET", filled(path, ids));
    const text = `${[...answer.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)}`;
    assert.ok(!text.includes(plant.pointer), `GET ${path} holds the planted pointer`);
    assert.ok(!text.includes(pointerHash(plant.pointer)), `GET ${path} holds the planted pointer's hash`);
    walked.push(`${answer.status} ${path}`);
  }
  assert.equal(walked.length, Object.values(doc.paths).filter((item) => item.get).length);
  assert.ok(walked.includes("200 /agents/{agent_id}") && walked.includes("200 /runs/{run_id}"), walked.join("\n"));
  // The list holds it too, the same shape.
  const listed = (await api("GET", "/agents")).body.agents.find((a) => a.agent_id === "planted");
  assert.deepEqual(listed.sign_ins, got.body.sign_ins);

  // Every store row, unsealed columns and the journal's tables among them: nowhere in the clear.
  const { tables, hits, cells } = storeHits(join(data, STORE_FILE), plant.pointer);
  assert.ok(tables.includes("sign_ins") && tables.some((name) => /entries/.test(name)), tables.join(","));
  assert.ok(cells > 0);
  assert.deepEqual(hits, []);
  // Nor any file under the data directory, the store's own (its WAL) among them.
  const files = filesUnder(data);
  assert.ok(files.some((file) => file.endsWith(STORE_FILE)));
  for (const file of files) assert.ok(!readFileSync(file).includes(plant.pointer), `${file} holds the planted pointer`);
  // Nor any line the server or its runner printed.
  assert.deepEqual(log.filter((line) => line.includes(plant.pointer)), []);
});
