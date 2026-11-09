// Every body field that holds a secret is marked `x-agentrun-secret: true` in the served API document, and every
// operation with a marked field has a predicate registered in secret-writes.ts, so a new route can't take a secret past
// the one check in the server's dispatch. Every registered operation exists in the document. The one metadata shape a
// secret's view answers (name, set, source, changed_at) is a component of the document.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";

async function secretWrites() {
  try {
    return await import("../dist/secret-writes.js");
  } catch {
    return undefined;
  }
}

const doc = openapiDocument(() => undefined);

test("every operation with a field marked x-agentrun-secret has a predicate registered, and the tool-key fields are marked", async () => {
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const marked = mod.markedOperations(doc);
  assert.ok(marked.includes("saveToolKey"), `saveToolKey's values are marked: ${JSON.stringify(marked)}`);
  assert.deepEqual(mod.unguardedOperations(doc, mod.registeredOperations()), [], "no marked operation lacks a predicate");
  // The check catches one: a marked operation no plane registered.
  const extra = structuredClone(doc);
  extra.paths["/test-only"] = { put: { operationId: "testOnlyUnguarded", requestBody: { content: { "application/json": { schema: { type: "object", properties: { token: { type: "string", "x-agentrun-secret": true } } } } } } } };
  assert.deepEqual(mod.unguardedOperations(extra, mod.registeredOperations()), ["testOnlyUnguarded"], "an unregistered marked operation is named");
});

test("every registered secret write is an operation of the document", async () => {
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const ops = new Set(Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)));
  for (const name of mod.registeredOperations()) assert.ok(ops.has(name), `${name} is an operation`);
});

test("the one secret metadata shape is a component: name, set, source (env, console, sign-in, or null), changed_at; never a value", async () => {
  const shape = doc.components.schemas.SecretMeta;
  assert.ok(shape, "components.schemas.SecretMeta");
  assert.deepEqual(Object.keys(shape.properties).sort(), ["changed_at", "name", "set", "source"]);
  assert.deepEqual([...shape.required].sort(), ["changed_at", "name", "set", "source"]);
  assert.equal(shape.additionalProperties, false, "nothing else: never a value, a prefix, a length or a hash");
  assert.deepEqual(shape.properties.source.enum, ["env", "console", "sign-in", null]);
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const meta = mod.secretMeta("tool:MONID_API_KEY", { set: true, source: "console", changedAt: "2026-11-09T00:00:00.000Z" });
  assert.deepEqual(meta, { name: "tool:MONID_API_KEY", set: true, source: "console", changed_at: "2026-11-09T00:00:00.000Z" });
  assert.deepEqual(mod.secretMeta("tool:X_KEY", { set: false }), { name: "tool:X_KEY", set: false, source: null, changed_at: null }, "unset: no source, no time");
});

test("secretName(plane, ...id) builds a secret's name, <plane>:<id>, and every settled form meets SecretMeta's name pattern", async () => {
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  assert.equal(mod.secretName("computer", "e2b", "E2B_API_KEY"), "computer:e2b:E2B_API_KEY");
  assert.equal(mod.secretName("workspace", "archil"), "workspace:archil");
  assert.equal(mod.secretName("tool", "PARALLEL_API_KEY"), "tool:PARALLEL_API_KEY");
  assert.equal(mod.secretName("mcp", "linear", "authorization"), "mcp:linear:authorization");
  const pattern = new RegExp(doc.components.schemas.SecretMeta.properties.name.pattern);
  const names = [
    mod.secretName("tool", "MONID_API_KEY"), mod.secretName("model", "OPENROUTER_API_KEY"), mod.secretName("mcp", "linear"), mod.secretName("mcp", "linear", "client_secret"),
    mod.secretName("computer", "e2b", "E2B_API_KEY"), mod.secretName("workspace", "archil"), mod.secretName("trigger", "trg_1"), mod.secretName("webhook", "outbound"),
    mod.secretName("github", "app"), mod.secretName("source", "slack", "signing_secret"),
  ];
  for (const name of names) assert.match(name, pattern, `${name} meets the pattern`);
  for (const bad of ["MONID_API_KEY", "Tool:X", "tool:", ":x"]) assert.doesNotMatch(bad, pattern, `${bad} does not`);
});

test("GET /settings/tool-keys's rows carry secrets: SecretMeta[] by the component", () => {
  const row = doc.paths["/settings/tool-keys"].get.responses["200"].content["application/json"].schema.properties.keys.items;
  assert.ok(row, "the tool-key row schema");
  assert.deepEqual(row.properties.secrets, { ...row.properties.secrets, type: "array", items: { $ref: "#/components/schemas/SecretMeta" } });
  assert.ok(row.required.includes("secrets"));
});
