// The computer and Archil keys' secret writes (secret-writes.ts, rule 1): saving or removing a provider's key, and the
// Archil account key, are secret writes the server's one dispatch check keeps to the owner's session; the API token is
// 403, a removal (a null) included. The Archil settings that are no key (disk, region, S3 URL, image) stay editable with
// the token. Their body fields are marked x-agentrun-secret in the served document, and each marked operation has its
// predicate, registered by the module that owns it when it loads.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { isSecretWriteOperation, markedOperations, registeredOperations, SECRET_WRITE_REFUSAL, unguardedOperations, writesSecret } from "../dist/secret-writes.js";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const json = { "content-type": "application/json" };
const planted = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const doc = openapiDocument(() => undefined);

test("the computer and Archil key fields are marked in the document, and each marked operation has its predicate", () => {
  const marked = markedOperations(doc);
  for (const name of ["saveComputerKeys", "putWorkspaceArchil"]) assert.ok(marked.includes(name), `${name} marks its secret fields`);
  assert.deepEqual(unguardedOperations(doc, registeredOperations()), []);
  assert.equal(doc.paths["/computers/{provider}/keys"].put.requestBody.content["application/json"].schema.additionalProperties["x-agentrun-secret"], true);
  const archilBody = doc.paths["/workspace/archil"].put.requestBody.content["application/json"].schema;
  assert.equal(archilBody.properties.keys.properties.ARCHIL_API_KEY["x-agentrun-secret"], true);
  for (const field of ["diskId", "region", "s3Url", "image"]) assert.equal(archilBody.properties[field]?.["x-agentrun-secret"], undefined, `${field} is no secret`);
});

test("saveComputerKeys: any named key, a value or a null (a removal is a secret write too), writes a secret", () => {
  assert.equal(writesSecret("saveComputerKeys", { E2B_API_KEY: "e2b-value" }), true);
  assert.equal(writesSecret("saveComputerKeys", { E2B_API_KEY: null }), true);
  assert.equal(writesSecret("saveComputerKeys", {}), false);
  assert.equal(writesSecret("saveComputerKeys", undefined), false);
});

test("putWorkspaceArchil: only the account key, a value or a null, writes a secret; the settings alone stay token-editable", () => {
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: "archil-value" } }), true);
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: { ARCHIL_API_KEY: null } }), true);
  assert.equal(writesSecret("putWorkspaceArchil", SETTINGS), false);
  assert.equal(writesSecret("putWorkspaceArchil", { ...SETTINGS, keys: {} }), false);
  assert.equal(writesSecret("putWorkspaceArchil", undefined), false);
});

test("the reads, the tests and turning Archil off are no secret writes: deleteWorkspaceArchil keeps the key", () => {
  for (const name of ["listComputers", "testComputer", "getWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil"]) assert.equal(isSecretWriteOperation(name), false, name);
  assert.ok(isSecretWriteOperation("saveComputerKeys") && isSecretWriteOperation("putWorkspaceArchil"));
});

test("on the server: the token is 403 for a computer key's save or removal and for the Archil key, in the one text; it still edits the Archil settings alone; the owner's session saves", async (t) => {
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

  for (const [what, keys] of [["the account key", { ARCHIL_API_KEY: planted() }], ["an all-null removal", { ARCHIL_API_KEY: null }]]) {
    const byToken = await call(server.port, { method: "PUT", path: "/v2/workspace/archil", headers: { ...json, ...bearer }, body: { ...SETTINGS, keys } });
    assert.equal(byToken.status, 403, `${what} by the token: ${byToken.text}`);
    assert.equal(byToken.json?.error?.message, SECRET_WRITE_REFUSAL);
  }
  const settingsOnly = await call(server.port, { method: "PUT", path: "/v2/workspace/archil", headers: { ...json, ...bearer }, body: SETTINGS });
  assert.notEqual(settingsOnly.status, 403, `the disk and region alone stay token-editable: ${settingsOnly.text}`);
});
