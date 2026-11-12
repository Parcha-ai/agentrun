// The computer and Archil keys' secret writes (secret-writes.ts, rule 1): saving or removing a provider's key, and the
// Archil account key, are secret writes the server's one dispatch check keeps to the owner's session; the API token is
// 403, a removal (a null) included. Any PUT of the Archil settings is the owner's too, whatever its body: the disk, region
// and S3 URL say where every run's files go, so a token never re-points them. Their body fields are marked x-agentrun-secret in the served document, and each marked operation has its
// predicate, registered by the module that owns it when it loads.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { isSecretWriteOperation, markedOperations, registeredOperations, SECRET_WRITE_REFUSAL, unguardedOperations, writesSecret } from "../dist/secret-writes.js";
import { call, cookieOf, serve, withEnv } from "./support.mjs";
import { plantedValue } from "./fixtures/planted-secrets.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const json = { "content-type": "application/json" };
/** A value shaped like a vendor's key, from the planted-secret harness: never a real one. */
const planted = () => plantedValue("computer-key");
const SETTINGS = { region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const doc = openapiDocument(() => undefined);

test("the computer and Archil key fields are marked in the document, and each marked operation has its predicate", () => {
  const marked = markedOperations(doc);
  for (const name of ["saveComputerKeys", "putWorkspaceArchil"]) assert.ok(marked.includes(name), `${name} marks its secret fields`);
  assert.deepEqual(unguardedOperations(doc, registeredOperations()), []);
  assert.equal(doc.paths["/computers/{provider}/keys"].put.requestBody.content["application/json"].schema.additionalProperties["x-agentrun-secret"], true);
  const archilBody = doc.paths["/workspace/archil"].put.requestBody.content["application/json"].schema;
  assert.equal(archilBody.properties.keys.properties.ARCHIL_API_KEY["x-agentrun-secret"], true);
  for (const field of ["region", "s3Url", "image"]) assert.equal(archilBody.properties[field]?.["x-agentrun-secret"], undefined, `${field} is no secret`);
});

test("saveComputerKeys: every request to a computer's keys is a secret write, whatever its body: a value, a null (a removal), an empty body or none", () => {
  assert.equal(writesSecret("saveComputerKeys", { E2B_API_KEY: "fake" }), true);
  assert.equal(writesSecret("saveComputerKeys", { E2B_API_KEY: null }), true);
  assert.equal(writesSecret("saveComputerKeys", {}), true);
  assert.equal(writesSecret("saveComputerKeys", undefined), true);
});

test("on the server: the token's PUT to a computer's keys with an empty body or none is 403 in the one text, before any provider is looked up (an unknown one included); the owner's session gets 404 for an unknown provider", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: `owner-${randomBytes(12).toString("hex")}` } });
  assert.equal(setup.status, 201, setup.text);
  const owner = { cookie: cookieOf(setup), origin };
  const bearer = { authorization: `Bearer ${server.token}` };
  const provider = (await call(server.port, { path: "/v2/computers", headers: bearer })).json.kinds.flatMap((kind) => kind.providers)[0].id;
  // A token learns nothing of which providers exist: a known and an unknown one answer alike.
  for (const id of [provider, "x"]) {
    for (const [what, sent] of [["an empty body", { headers: { ...json, ...bearer }, body: {} }], ["no body", { headers: bearer }]]) {
      const res = await call(server.port, { method: "PUT", path: `/v2/computers/${id}/keys`, ...sent });
      assert.equal(res.status, 403, `${id}, ${what}, by the token: ${res.text}`);
      assert.equal(res.json?.error?.message, SECRET_WRITE_REFUSAL);
    }
  }
  const unknown = await call(server.port, { method: "PUT", path: "/v2/computers/x/keys", headers: { ...json, ...owner }, body: {} });
  assert.equal(unknown.status, 404, `the owner's session reaches the provider lookup: ${unknown.text}`);
});

test("putWorkspaceArchil: every PUT of the Archil settings is a secret write, whatever its body: the account key, the disk and region alone, an empty body or none", () => {
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: "fake" } }), true);
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: null } }), true);
  assert.equal(writesSecret("putWorkspaceArchil", SETTINGS), true);
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: {} }), true);
  assert.equal(writesSecret("putWorkspaceArchil", {}), true);
  assert.equal(writesSecret("putWorkspaceArchil", undefined), true);
});

test("the reads, the tests and turning Archil off are no secret writes: deleteWorkspaceArchil keeps the key", () => {
  for (const name of ["listComputers", "testComputer", "getWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil"]) assert.equal(isSecretWriteOperation(name), false, name);
  assert.ok(isSecretWriteOperation("saveComputerKeys") && isSecretWriteOperation("putWorkspaceArchil"));
});

test("on the server: the token is 403 for a computer key's save or removal and for any PUT of the Archil settings, in the one text; the owner's session saves, and gets 422 for an empty Archil body", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: `owner-${randomBytes(12).toString("hex")}` } });
  assert.equal(setup.status, 201, setup.text);
  const owner = { cookie: cookieOf(setup), origin };
  const bearer = { authorization: `Bearer ${server.token}` };
  // A provider that declares a key, as GET /v2/computers names it.
  const listed = await call(server.port, { path: "/v2/computers", headers: bearer });
  assert.equal(listed.status, 200, listed.text);
  const provider = listed.json.kinds.flatMap((kind) => kind.providers).find((p) => (p.secrets ?? []).length > 0);
  assert.ok(provider, `a provider with a key: ${listed.text}`);
  // Its SecretMeta's name is "computer:<provider>:<KEY>": KEY is the name the PUT takes.
  const key = provider.secrets[0].name.split(":").at(-1);
  const keysPath = `/v2/computers/${provider.id}/keys`;

  for (const [what, body] of [["a save", { [key]: planted() }], ["a removal", { [key]: null }]]) {
    const byToken = await call(server.port, { method: "PUT", path: keysPath, headers: { ...json, ...bearer }, body });
    assert.equal(byToken.status, 403, `${what} of ${key} by the token: ${byToken.text}`);
    assert.equal(byToken.json?.error?.message, SECRET_WRITE_REFUSAL);
  }
  const byOwner = await call(server.port, { method: "PUT", path: keysPath, headers: { ...json, ...owner }, body: { [key]: planted() } });
  assert.equal(byOwner.status, 200, `the owner's session saves it: ${byOwner.text}`);

  for (const [what, sent] of [
    ["the account key", { headers: { ...json, ...bearer }, body: { ...SETTINGS, keys: { ARCHIL_API_KEY: planted() } } }],
    ["an all-null removal", { headers: { ...json, ...bearer }, body: { ...SETTINGS, keys: { ARCHIL_API_KEY: null } } }],
    ["the region and S3 URL alone", { headers: { ...json, ...bearer }, body: SETTINGS }],
    ["an empty body", { headers: { ...json, ...bearer }, body: {} }],
    ["no body", { headers: bearer }],
  ]) {
    const byToken = await call(server.port, { method: "PUT", path: "/v2/workspace/archil", ...sent });
    assert.equal(byToken.status, 403, `${what} by the token: ${byToken.text}`);
    assert.equal(byToken.json?.error?.message, SECRET_WRITE_REFUSAL);
  }
  const ownerEmpty = await call(server.port, { method: "PUT", path: "/v2/workspace/archil", headers: { ...json, ...owner }, body: {} });
  assert.equal(ownerEmpty.status, 422, `the owner's session reaches the settings' own check: ${ownerEmpty.text}`);
  const ownerSettings = await call(server.port, { method: "PUT", path: "/v2/workspace/archil", headers: { ...json, ...owner }, body: SETTINGS });
  assert.equal(ownerSettings.status, 200, `the owner's session saves the settings alone: ${ownerSettings.text}`);
});
