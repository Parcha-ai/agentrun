// GET /v2/openapi.json: the agentrun.v2/0 contract as vendored, with this server's marks. It holds every route the
// server serves and nothing it does not, the contract's operations unchanged, and its references whole.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { decisionRows } from "../dist/decision-rows.js";
import { ROUTES } from "../dist/server.js";
import { DEFINITION_FIELDS } from "../dist/validate.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, flowAgent, serve } from "./support.mjs";

const VENDORED = JSON.parse(await readFile(new URL("../src/openapi/agentrun-v2.openapi.json", import.meta.url), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];
const operations = (doc) => Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method], item })));
/** A path of the document with each parameter filled, as a client would send it. */
const sample = (path) => path.replace(/\{(\w+)\}/g, (_, name) => (name === "path" ? "notes/a.txt" : `x-${name}`));

async function served(t) {
  const { baseUrl } = await serve(t);
  const res = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(res.status, 200, "no credential needed");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  return { baseUrl, doc: await res.json() };
}

test("GET /v2/openapi.json without a credential: the contract it vendors, named in info, and capabilities link it", async (t) => {
  const { baseUrl, doc } = await served(t);
  assert.equal(doc.info.version, "agentrun.v2/0");
  assert.deepEqual(doc.info["x-agentrun-source"], VENDORED.info["x-agentrun-source"]);
  assert.equal(doc.info["x-agentrun-source"].contract, "agentrun.v2/0");
  assert.match(doc.info["x-agentrun-source"].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(doc.info["x-agentrun-source"]).sort(), ["contract", "converted", "file", "sha256"], "the source names the contract and its hash, nothing else");
  const caps = await (await fetch(`${baseUrl}/capabilities`)).json();
  assert.equal(caps.links.openapi, "/v2/openapi.json");
  assert.equal(caps.contract, doc.info.version, "the contract capabilities name is the document's");
  assert.deepEqual(doc.servers, [{ url: "/v2", description: "This server." }], "a client generated from it calls this server");
  assert.deepEqual(doc.info["x-agentrun-serve"].contract_servers, VENDORED.servers);
});

test("every route the server serves is in the document, and every operation in it is a route here: served, or marked unsupported with why", async (t) => {
  const { doc } = await served(t);
  const ops = operations(doc);
  for (const route of ROUTES) {
    const found = ops.filter(({ op, method }) => op.operationId === route.name && method === route.method.toLowerCase());
    assert.equal(found.length, 1, `${route.method} ${route.name} is one operation of the document`);
    assert.match(sample(found[0].path), route.pattern, `${route.name}: the document's path ${found[0].path} is the route's`);
  }
  for (const { path, method, op } of ops) {
    const route = ROUTES.find((r) => r.name === op.operationId && r.method.toLowerCase() === method);
    assert.ok(route, `${method.toUpperCase()} ${path} (${op.operationId}) is a route of this server`);
    if (route.capability) assert.deepEqual(Object.keys(op["x-agentrun-serve-unsupported"] ?? {}).sort(), ["capability", "reason"], `${op.operationId} is marked unsupported`);
    else assert.equal(op["x-agentrun-serve-unsupported"], undefined, `${op.operationId} is served`);
    if (route.capability) assert.equal(op["x-agentrun-serve-unsupported"].capability, route.capability);
  }
  assert.equal(ops.filter(({ op }) => op["x-agentrun-serve-unsupported"]).length, 6, "the six this server answers 501");
  assert.deepEqual(doc.info["x-agentrun-serve"].unsupported.length, 6);
});

test("the contract's operations are as vendored; this server's own are added and marked x-agentrun-serve", async (t) => {
  const { doc } = await served(t);
  const vendored = new Map(operations(VENDORED).map(({ path, method, op }) => [`${method} ${path}`, op]));
  const own = [];
  for (const { path, method, op } of operations(doc)) {
    const original = vendored.get(`${method} ${path}`);
    if (!original) {
      assert.ok(op["x-agentrun-serve"] === true || /^[a-z]+\/\d+$/.test(op["x-agentrun-serve"]), `${method.toUpperCase()} ${path} is this server's own, and marked`);
      own.push(`${method.toUpperCase()} ${path}`);
      continue;
    }
    const { "x-agentrun-serve-unsupported": _, "x-agentrun-serve-changed": changes, ...rest } = op;
    assert.equal(op["x-agentrun-serve"], undefined);
    if (!changes) {
      assert.ok(isDeepStrictEqual(rest, original), `${op.operationId} is the contract's, unchanged`);
      continue;
    }
    // A changed operation: each change named, the contract's own body kept as the first choice, If-Match unchanged but
    // for whether it is required and what it says, and the rest as vendored.
    assert.ok(doc.info["x-agentrun-serve"].changed.includes(`${method.toUpperCase()} ${path}`), `${op.operationId} is listed as changed`);
    for (const mark of Object.values(changes)) assert.match(mark, /^[a-z]+\/\d+$/);
    assert.deepEqual(Object.keys(changes).sort(), ["If-Match", "requestBody"]);
    const schema = (o) => o.requestBody.content["application/json"].schema;
    assert.deepEqual(schema(op).oneOf[0], schema(original), "the contract's body is one of the two");
    const plain = (params) => params.map(({ required, description, ...p }) => (p.name === "If-Match" ? p : { required, description, ...p }));
    assert.deepEqual(plain(op.parameters), plain(original.parameters));
    const { requestBody: _a, parameters: _b, ...same } = rest;
    const { requestBody: _c, parameters: _d, ...vendoredSame } = original;
    assert.ok(isDeepStrictEqual(same, vendoredSame), `${op.operationId} is the contract's but for its named changes`);
  }
  assert.equal(vendored.size + own.length, operations(doc).length, "no contract operation is gone");
  assert.deepEqual(own.sort(), [...doc.info["x-agentrun-serve"].extensions].sort(), "info lists the server's own");
  // Every property this server adds is marked with the addition that made it, and listed; without them, the
  // contract's components are as vendored.
  const components = structuredClone(doc.components);
  const marked = [];
  const notes = [];
  const strip = (schema, at) => {
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      for (const mark of ["x-agentrun-serve-unsupported", "x-agentrun-serve-details"]) {
        if (property[mark] === undefined) continue;
        delete property[mark];
        notes.push(`${at}.${field}`);
      }
      if (property["x-agentrun-serve"] === undefined) {
        strip(property, `${at}.${field}`);
        continue;
      }
      assert.match(property["x-agentrun-serve"], /^[a-z]+\/\d+$/, `${at}.${field} names its addition`);
      // An addition inside one (a later mark on a property of this server's own) is listed too.
      const inner = (object, where) => {
        for (const [name, nested] of Object.entries(object.properties ?? {})) {
          if (nested["x-agentrun-serve"] !== undefined) marked.push(`${where}.${name}`);
          inner(nested, `${where}.${name}`);
        }
      };
      inner(property, `${at}.${field}`);
      delete schema.properties[field];
      marked.push(`${at}.${field}`);
    }
  };
  for (const [name, schema] of Object.entries(components.schemas)) {
    // A contract enum this server widens (RunStatus's `paused`) is marked on the schema, each value it adds listed.
    if (schema["x-agentrun-serve"] !== undefined && Array.isArray(schema.enum)) {
      const original = VENDORED.components.schemas[name].enum;
      for (const value of schema.enum.filter((v) => !original.includes(v))) marked.push(`${name}.${value}`);
      schema.enum = schema.enum.filter((v) => original.includes(v));
      delete schema["x-agentrun-serve"];
    }
    strip(schema, name);
  }
  assert.ok(isDeepStrictEqual(components, VENDORED.components), "the contract's components are unchanged but for the marked properties");
  assert.deepEqual(marked.sort(), [...doc.info["x-agentrun-serve"].fields].sort(), "info lists the marked properties");
  assert.deepEqual(notes.sort(), [...doc.info["x-agentrun-serve"].unsupported_fields, ...doc.info["x-agentrun-serve"].details].sort(), "info lists the contract properties it notes");
});

test("the served definition takes exactly the fields this server takes: a contract field it refuses is marked with the reason its 422 gives, and a run it refuses has the details the document says", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const fields = doc.components.schemas.DefinitionInput.properties;
  const refused = Object.keys(fields).filter((field) => fields[field]["x-agentrun-serve-unsupported"]);
  assert.deepEqual(Object.keys(fields).filter((field) => !refused.includes(field)).sort(), [...DEFINITION_FIELDS].sort(), "every field validate.ts takes, and no other, unmarked");
  assert.deepEqual(doc.info["x-agentrun-serve"].unsupported_fields, refused.map((field) => `DefinitionInput.${field}`));
  const values = { input_schema: { type: "object" }, output_schema: { type: "object" }, max_cost_usd: 1 };
  for (const field of refused) {
    const answer = await api("POST", "/agents", agent(`with-${field.replaceAll("_", "-")}`, { [field]: values[field] ?? "x" }));
    assert.equal(answer.status, 422, field);
    const issue = answer.body.error.fields.find((f) => f.field === `definition.${field}`);
    assert.equal(issue?.reason, "not_allowed", field);
    assert.equal(fields[field]["x-agentrun-serve-unsupported"].reason, issue.message, `${field}: the document says why, as the refusal does`);
  }
  // A harness this server does not run: the revision saves with a warning, and its run is refused with the details
  // the document gives agent_not_runnable.
  assert.equal((await api("POST", "/agents", agent("elsewhere", { harness: "claude-agent" }))).status, 201);
  const run = await api("POST", "/agents/elsewhere/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code], [409, "agent_not_runnable"]);
  const shape = doc.components.schemas.ErrorBody.properties.details["x-agentrun-serve-details"]?.agent_not_runnable;
  assert.ok(shape, "the document gives agent_not_runnable's details");
  assert.deepEqual(schemaProblems(doc, shape, run.body.error.details), [], JSON.stringify(run.body.error.details));
  assert.equal(run.body.error.details.harness, "claude-agent");
  // An archived agent is refused the same way, with when it was archived.
  assert.equal((await api("POST", "/agents", agent("put-away"))).status, 201);
  assert.equal((await api("POST", "/agents/put-away/archive")).status, 200);
  const archived = await api("POST", "/agents/put-away/runs", { input: { content: "hi" } });
  assert.deepEqual([archived.status, archived.body.error.code], [409, "agent_not_runnable"]);
  assert.deepEqual(schemaProblems(doc, shape, archived.body.error.details), [], JSON.stringify(archived.body.error.details));
  assert.equal(typeof archived.body.error.details.archived_at, "string");
});

test("the document is OpenAPI 3.1 in shape: operations with responses, ids unique, path parameters declared, every reference whole", async (t) => {
  const { doc } = await served(t);
  assert.match(doc.openapi, /^3\.1\.\d+$/);
  assert.equal(typeof doc.info.title, "string");
  assert.equal(typeof doc.info.version, "string");
  const ids = new Set();
  const resolve = (value) => {
    if (!value?.$ref) return value;
    assert.match(value.$ref, /^#\//, `a local reference: ${value.$ref}`);
    const target = value.$ref.slice(2).split("/").reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
    assert.ok(target !== undefined, `${value.$ref} resolves`);
    return target;
  };
  for (const { path, method, op, item } of operations(doc)) {
    assert.ok(path.startsWith("/"), path);
    assert.equal(typeof op.operationId, "string", `${method} ${path} has an operationId`);
    assert.ok(!ids.has(op.operationId), `${op.operationId} is unique`);
    ids.add(op.operationId);
    assert.ok(op.responses && Object.keys(op.responses).length > 0, `${op.operationId} answers something`);
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve);
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) assert.ok(params.some((p) => p.in === "path" && p.name === name && p.required === true), `${op.operationId} declares its path parameter ${name}`);
  }
  // Every reference anywhere in the document resolves.
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string") resolve(node);
    Object.values(node).forEach(walk);
  };
  walk(doc);
});

test("live answers meet the served document: capabilities, and an agent made, read and edited on each harness, against the contract plus exactly its marked properties", async (t) => {
  const { baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const { api } = await serve(t);
  const check = (name, value) => assert.deepEqual(schemaProblems(doc, { $ref: `#/components/schemas/${name}` }, value), [], `${name}: ${JSON.stringify(value)}`);
  check("Capabilities", (await api("GET", "/capabilities")).body);
  for (const [id, body] of [["on-pi", agent("on-pi", { model: "faux/faux-1", thinking: "high" })], ["on-claude", agent("on-claude", { harness: "claude-agent" })], ["on-codex", flowAgent("on-codex", undefined, { harness: "codex" })]]) {
    const { warnings: _, ...made } = (await api("POST", "/agents", body)).body;
    const read = (await api("GET", `/agents/${id}`)).body;
    if (id !== "on-codex") {
      check("Agent", made);
      check("Agent", read);
      continue;
    }
    // A workflow definition keeps no instructions, which v2/0 requires of every definition: the one gap left, for v2/1.
    for (const answer of [made, read]) assert.deepEqual([...new Set(schemaProblems(doc, { $ref: "#/components/schemas/Agent" }, answer))], ["$.definition.instructions: is required"]);
  }
  // The same check sees a field the document does not hold: the positive control.
  assert.notDeepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, { ...(await api("GET", "/capabilities")).body, unheard_of: 1 }), []);
});

test("the decision providers' widening to parallel is its own addition, decisions/2, and info lists it", async (t) => {
  const { doc } = await served(t);
  const decisions = doc.components.schemas.Capabilities.properties.workflows.properties.decisions;
  assert.equal(decisions["x-agentrun-serve"], "decisions/2", "a client that validates against decisions/1 refuses parallel, so the widening is a new mark");
  assert.deepEqual(decisions.properties.providers.items.properties.id.enum, ["jev", "parallel", "openrouter"]);
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("Capabilities.workflows.decisions"), "info names it among the marked properties");
});

test("the served TimelineKind holds every kind pi-durable-agent's timeline declares, decision among them as decision-rows/1, and a decision row meets TimelineRow", async (t) => {
  const { doc } = await served(t);
  // The kinds as the timeline's built declaration has them, comments dropped: the rows this server serves are its.
  const declaration = await readFile(new URL("timeline.d.ts", import.meta.resolve("@parcha/pi-durable-agent/timeline")), "utf8");
  const union = /export type TimelineKind =([^;]+);/.exec(declaration.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "";
  const declared = [...union.matchAll(/"([a-z_]+)"/g)].map(([, kind]) => kind);
  assert.ok(declared.includes("decision") && declared.includes("usage"), `the timeline's kinds are read: ${declared}`);
  const kinds = doc.components.schemas.TimelineKind;
  assert.deepEqual([...kinds.enum].sort(), [...declared].sort(), "a client that validates rows against the document takes every kind this server serves");
  assert.equal(kinds["x-agentrun-serve"], "decision-rows/1");
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("TimelineKind.decision"), "info names it among the marked properties");
  // A decision row as this server builds it, a batched sift with many sources, meets the served row: its kind and its caps.
  const answers = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`item_${i}`, { type: "noul", noul: 0.9 }]));
  const evidence = Array.from({ length: 100 }, (_, i) => ({ url: `https://example.org/filing/${i}?sig=${i}`, title: `Filing ${i}`, excerpts: [], scope: "call" }));
  const [row] = decisionRows([{ id: "d1", at: "2026-10-29T23:00:00.000Z", node: "sift_docs", kind: "sift", request: { index: 0, count: 1 }, status: "answered", answers, evidence, cost_usd: null }]);
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, { ...row, seq: 0 }), []);
});
