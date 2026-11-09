// GET /v2/openapi.json: the agentrun.v2/0 contract as vendored, with this server's marks. It holds every route the
// server serves and nothing it does not, the contract's operations unchanged, and its references whole.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { decisionRows } from "../dist/decision-rows.js";
import { agentFolderOf } from "../dist/files.js";
import { agentHomeFolder } from "../dist/workspace/index.js";
import { ROUTES } from "../dist/server.js";
import { DEFINITION_FIELDS } from "../dist/validate.js";
import { DEFINITION_INPUT_OPTIONAL, DEFINITION_OPTIONAL, REQUEST_EXAMPLES, RUN_FIELDS_SENT } from "../dist/openapi.js";
import { schemaProblems } from "./schema-support.mjs";
import { capabilities } from "../dist/index.js";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, made, SWITCH_TODO, started } from "./learn-support.mjs";
import { agent, FAUX, flowAgent, follow, serve } from "./support.mjs";
import { fakeClock, schedule } from "./trigger-support.mjs";

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

test("approving a note is the owner's password session alone, from the console with a JSON body: the operation names a cookie scheme and no token, and declares its empty JSON body, so a client generated from the document sends what the route takes", async (t) => {
  const { baseUrl, doc } = await served(t);
  const op = doc.paths["/agents/{agent_id}/learning/files/{file}/approve"].post;
  assert.deepEqual(op.security, [{ ownerSession: [] }], "never the document's bearer: the route answers 403 to every token");
  const scheme = doc.components.securitySchemes.ownerSession;
  assert.deepEqual([scheme.type, scheme.in], ["apiKey", "cookie"]);
  assert.equal(scheme.name, `agentrun-${new URL(baseUrl).port}`, "the cookie the console sets on this server: agentrun-<its port>");
  assert.match(scheme.description, /password/);
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(op.requestBody.content["application/json"].schema, { type: "object", additionalProperties: false, maxProperties: 0 });
  assert.deepEqual(doc.components.securitySchemes.bearer, VENDORED.components.securitySchemes.bearer, "the contract's scheme is as vendored");
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
    // A server-wide pushed source's own hook (receiveHook_<source>) is the one hook route's, at its source's path.
    const name = /^receiveHook_[a-z][a-z0-9-]*$/.test(op.operationId) ? "receiveHook" : op.operationId;
    const route = ROUTES.find((r) => r.name === name && r.method.toLowerCase() === method);
    assert.ok(route, `${method.toUpperCase()} ${path} (${op.operationId}) is a route of this server`);
    if (route.capability) assert.deepEqual(Object.keys(op["x-agentrun-serve-unsupported"] ?? {}).sort(), ["capability", "reason"], `${op.operationId} is marked unsupported`);
    else assert.equal(op["x-agentrun-serve-unsupported"], undefined, `${op.operationId} is served`);
    if (route.capability) assert.equal(op["x-agentrun-serve-unsupported"].capability, route.capability);
  }
  assert.equal(ops.filter(({ op }) => op["x-agentrun-serve-unsupported"]).length, 4, "the four this server answers 501");
  assert.deepEqual(doc.info["x-agentrun-serve"].unsupported.length, 4);
});

test("the contract's operations are as vendored; this server's own are added and marked x-agentrun-serve", async (t) => {
  const { doc } = await served(t);
  const vendored = new Map(operations(VENDORED).map(({ path, method, op }) => [`${method} ${path}`, op]));
  assert.ok(vendored.has("put /agents/{agent_id}/definition") && doc.paths["/agents/{agent_id}/definition"].put["x-agentrun-serve-changed"], "PUT definition is a changed operation, its bodies checked below");
  const own = [];
  for (const { path, method, op } of operations(doc)) {
    const original = vendored.get(`${method} ${path}`);
    if (!original) {
      assert.ok(op["x-agentrun-serve"] === true || /^[a-z]+\/\d+$/.test(op["x-agentrun-serve"]), `${method.toUpperCase()} ${path} is this server's own, and marked`);
      own.push(`${method.toUpperCase()} ${path}`);
      continue;
    }
    let { "x-agentrun-serve-unsupported": _, "x-agentrun-serve-changed": changes, ...rest } = op;
    assert.equal(op["x-agentrun-serve"], undefined);
    // examples/1: the JSON body's working examples (REQUEST_EXAMPLES), added and listed; without them, the operation is
    // what its other marks say.
    if (changes?.requestBody === "examples/1") {
      assert.ok(doc.info["x-agentrun-serve"].changed.includes(`${method.toUpperCase()} ${path}`), `${op.operationId} is listed as changed`);
      assert.deepEqual(rest.requestBody.content["application/json"].examples, REQUEST_EXAMPLES[op.operationId]);
      assert.equal(original.requestBody.content["application/json"].examples, undefined);
      rest = structuredClone(rest);
      delete rest.requestBody.content["application/json"].examples;
      const { requestBody: _examples, ...others } = changes;
      changes = Object.keys(others).length ? others : undefined;
    }
    if (!changes) {
      assert.ok(isDeepStrictEqual(rest, original), `${op.operationId} is the contract's, unchanged`);
      continue;
    }
    // A changed operation: each change named, the contract's own body kept as the first choice, If-Match unchanged but
    // for whether it is required and what it says, and the rest as vendored.
    assert.ok(doc.info["x-agentrun-serve"].changed.includes(`${method.toUpperCase()} ${path}`), `${op.operationId} is listed as changed`);
    for (const mark of Object.values(changes)) assert.match(mark, /^[a-z]+\/\d+$/);
    if (op.operationId === "createFile") {
      // upload/2: the contract's JSON body kept as the first choice and the raw bytes beside it; its parameters kept, then
      // path, content_type and sha256; its responses kept but for 201's description, and 415 added; the rest as vendored.
      assert.deepEqual(Object.keys(changes).sort(), ["parameters", "requestBody", "responses"]);
      assert.deepEqual(Object.keys(op.requestBody.content), ["application/json", "application/octet-stream", "*/*"]);
      assert.deepEqual(op.requestBody.content["application/json"], original.requestBody.content["application/json"]);
      assert.equal(op.requestBody.required, original.requestBody.required);
      assert.deepEqual(op.parameters.slice(0, original.parameters.length), original.parameters);
      assert.deepEqual(op.parameters.slice(original.parameters.length).map((p) => [p.name, p.in, p.required]), [["path", "query", false], ["content_type", "query", false], ["sha256", "query", false]]);
      const { description: _d, ...created } = op.responses["201"];
      const { description: _e, ...vendoredCreated } = original.responses["201"];
      assert.deepEqual(created, vendoredCreated, "201's answer is the contract's FileUpload");
      assert.deepEqual(Object.keys(op.responses).filter((code) => !(code in original.responses)), ["415"]);
      for (const code of Object.keys(original.responses).filter((code) => code !== "201")) assert.deepEqual(op.responses[code], original.responses[code], code);
      const { requestBody: _a, parameters: _b, responses: _c, ...same } = rest;
      const { requestBody: _f, parameters: _g, responses: _h, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), "createFile is the contract's but for upload/2");
      continue;
    }
    if (op.operationId === "getTimeline") {
      // A page's limit: the contract's parameters, then this server's one, and the rest as vendored.
      assert.deepEqual(Object.keys(changes), ["limit"]);
      assert.deepEqual(op.parameters.slice(0, -1), original.parameters);
      assert.deepEqual([op.parameters.at(-1).name, op.parameters.at(-1).in, op.parameters.at(-1).required], ["limit", "query", false]);
      const { parameters: _a, ...same } = rest;
      const { parameters: _b, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), "getTimeline is the contract's but for its limit");
      continue;
    }
    if (op.operationId === "listAgents") {
      // archivedparam/1: this route also takes `archived`, as GET /runs already does (C1): the contract's
      // parameters, then this server's one, and the rest as vendored.
      assert.deepEqual(Object.keys(changes), ["archived"]);
      assert.deepEqual(op.parameters.slice(0, -1), original.parameters);
      assert.deepEqual([op.parameters.at(-1).name, op.parameters.at(-1).in, op.parameters.at(-1).required], ["archived", "query", false]);
      const { parameters: _a, ...same } = rest;
      const { parameters: _b, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), "listAgents is the contract's but for its archived");
      continue;
    }
    if (op.operationId === "listRunFiles" || op.operationId === "readRunFile") {
      // A hidden run's files (signins/1): the contract's description, then why 403 is answered here, and 403 added where
      // the contract has none; the rest as vendored.
      assert.ok(op.description.startsWith(original.description.trimEnd()) && /403 forbidden/.test(op.description), "the contract's description first, then the 403");
      assert.equal(op.responses["403"].$ref, "#/components/responses/Forbidden");
      assert.deepEqual(Object.keys(changes).sort(), original.responses["403"] ? ["description"] : ["description", "responses"]);
      const { description: _a, responses: _b, ...same } = rest;
      const { description: _c, responses: _d, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), `${op.operationId} is the contract's but for the 403`);
      for (const code of Object.keys(original.responses)) assert.deepEqual(op.responses[code], original.responses[code], code);
      continue;
    }
    if (op.operationId === "getAgent") {
      // agenttools/1: this route always sends the agent's tools, so its 200 is the contract's Agent with `tools` required
      // (the same schema as Agent.tools); its headers, its other answers and the rest as vendored.
      assert.deepEqual(changes, { responses: "agenttools/1" });
      const vendoredOk = original.responses["200"];
      assert.deepEqual(op.responses["200"].content["application/json"].schema, { allOf: [vendoredOk.content["application/json"].schema, { type: "object", required: ["tools"], properties: { tools: doc.components.schemas.Agent.properties.tools } }] });
      const { content: _a, ...ok } = op.responses["200"];
      const { content: _b, ...okVendored } = vendoredOk;
      assert.deepEqual(ok, okVendored);
      assert.deepEqual(Object.keys(op.responses), Object.keys(original.responses));
      for (const code of Object.keys(original.responses).filter((code) => code !== "200")) assert.deepEqual(op.responses[code], original.responses[code], code);
      const { responses: _c, ...same } = rest;
      const { responses: _d, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), "getAgent is the contract's but for its 200's tools");
      continue;
    }
    if (op.operationId === "cancelRun" || op.operationId === "createRun") {
      // What a cancel's 202 reads here, and how long a run create's key replays: the contract's description, then this
      // server's own reading of it.
      assert.deepEqual(Object.keys(changes), ["description"]);
      assert.ok(op.description.startsWith(original.description.trimEnd()), "the contract's description comes first");
      const { description: _a, ...same } = rest;
      const { description: _b, ...vendoredSame } = original;
      assert.ok(isDeepStrictEqual(same, vendoredSame), `${op.operationId} is the contract's but for its description`);
      continue;
    }
    assert.deepEqual(Object.keys(changes).sort(), ["If-Match", "requestBody"]);
    const schema = (o) => o.requestBody.content["application/json"].schema;
    assert.deepEqual(schema(op).oneOf[0], schema(original), "the contract's body is one of the two");
    if (path === "/agents/{agent_id}/definition") {
      // Exactly one of PUT definition's two bodies: the contract's, or this server's {definition, skills?, note?}.
      assert.deepEqual(changes, { requestBody: "definitionbody/1", "If-Match": "definitionbody/1" });
      const definition = { id: "a", version: 2, name: "a", instructions: "x", skills: [], tools: [] };
      const problems = (value) => schemaProblems(doc, schema(op), value);
      assert.deepEqual(problems(definition), [], "the contract's body");
      assert.deepEqual(problems({ definition, skills: { "cite/SKILL.md": "# Cite" }, note: "why" }), [], "this server's body");
      assert.notDeepEqual(problems({ ...definition, definition }), [], "never both at once");
      assert.notDeepEqual(problems({ note: "why" }), [], "never neither");
    }
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
  // Names taken out of a schema's `required` with the property they name: only the fields this server always sends
  // (RUN_FIELDS_SENT) may be, so a required addition anywhere else still fails this comparison.
  const unrequired = [];
  const notes = [];
  const strip = (schema, at) => {
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      for (const mark of ["x-agentrun-serve-unsupported", "x-agentrun-serve-details", "x-agentrun-serve-note"]) {
        if (property[mark] === undefined) continue;
        delete property[mark];
        notes.push(`${at}.${field}`);
      }
      if (property["x-agentrun-serve"] === undefined) {
        strip(property, `${at}.${field}`);
        continue;
      }
      // A contract property whose enum this server widens (models.source) is marked on the property, each value it adds
      // listed, as RunStatus is: cut back to the vendored enum and description, it is the contract's.
      const vendored = at.split(".").slice(1).reduce((object, key) => object?.properties?.[key], VENDORED.components.schemas[at.split(".")[0]])?.properties?.[field];
      if (Array.isArray(vendored?.enum) && Array.isArray(property.enum)) {
        for (const value of property.enum.filter((v) => !vendored.enum.includes(v))) marked.push(`${at}.${field}.${value}`);
        property.enum = property.enum.filter((v) => vendored.enum.includes(v));
        if (vendored.description === undefined) delete property.description;
        else property.description = vendored.description;
        delete property["x-agentrun-serve"];
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
      // One this server always sends is required beside the contract's (RUN_FIELDS_SENT): taken out with it.
      if (schema.required?.includes(field)) {
        schema.required = schema.required.filter((name) => name !== field);
        unrequired.push(`${at}.${field}`);
      }
      marked.push(`${at}.${field}`);
    }
  };
  for (const [name, schema] of Object.entries(components.schemas)) {
    // A contract condition this server widens (SignIn's held_by for its own `unreadable` state) is marked on the branch.
    if (schema.else?.["x-agentrun-serve"] !== undefined) {
      // Only the widening it is marked for: held_by may name a run when the state is `unreadable`, the vendored branch
      // whole beneath it, and nothing else.
      const { "x-agentrun-serve": mark, ...branch } = schema.else;
      assert.equal(mark, "signins/1", `${name}.else names its addition`);
      assert.deepEqual(branch, { if: { properties: { state: { const: "unreadable" } } }, then: { properties: { held_by: { oneOf: [{ $ref: "#/components/schemas/Id" }, { type: "null" }] } } }, else: VENDORED.components.schemas[name].else }, `${name}.else widens held_by for unreadable alone`);
      marked.push(`${name}.else`);
      schema.else = VENDORED.components.schemas[name].else;
    }
    // A contract enum this server widens (RunStatus's `paused`) is marked on the schema, each value it adds listed.
    if (schema["x-agentrun-serve"] !== undefined && Array.isArray(schema.enum)) {
      const original = VENDORED.components.schemas[name].enum;
      for (const value of schema.enum.filter((v) => !original.includes(v))) marked.push(`${name}.${value}`);
      schema.enum = schema.enum.filter((v) => original.includes(v));
      delete schema["x-agentrun-serve"];
    }
    strip(schema, name);
  }
  // A security scheme this server adds is its own, marked (the owner's session that approving a note takes).
  for (const [name, scheme] of Object.entries(components.securitySchemes ?? {})) if (scheme["x-agentrun-serve"] !== undefined) delete components.securitySchemes[name];
  // DefinitionInput: instructions, version, skills and tools are optional here where the server does not require them
  // (validate.ts, agents.ts definitionOf); Definition keeps only instructions optional, as a workflow revision's own
  // answer has none, and always sends the rest. Checked absent, then restored, so the comparison below is the
  // contract's own required arrays.
  for (const [name, fields] of [["DefinitionInput", DEFINITION_INPUT_OPTIONAL], ["Definition", DEFINITION_OPTIONAL]]) {
    for (const field of fields) assert.ok(!components.schemas[name].required.includes(field), `${name}.${field} is optional here`);
    components.schemas[name].required = VENDORED.components.schemas[name].required;
  }
  assert.ok(isDeepStrictEqual(components, VENDORED.components), "the contract's components are unchanged but for the marked properties");
  assert.deepEqual(unrequired.sort(), ["Run", "RunSummary"].flatMap((schema) => RUN_FIELDS_SENT.map((field) => `${schema}.${field}`)).sort(), "only the fields this server always sends are required beyond the contract");
  assert.deepEqual(marked.sort(), [...doc.info["x-agentrun-serve"].fields].sort(), "info lists the marked properties");
  assert.deepEqual(notes.sort(), [...doc.info["x-agentrun-serve"].unsupported_fields, ...doc.info["x-agentrun-serve"].details, ...doc.info["x-agentrun-serve"].notes].sort(), "info lists the contract properties it notes");
});

test("the served definition takes exactly the fields this server takes: a contract field it refuses is marked with the reason its 422 gives, and a run it refuses has the details the document says", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const fields = doc.components.schemas.DefinitionInput.properties;
  const refused = Object.keys(fields).filter((field) => fields[field]["x-agentrun-serve-unsupported"]);
  assert.deepEqual(Object.keys(fields).filter((field) => !refused.includes(field)).sort(), [...DEFINITION_FIELDS].sort(), "every field validate.ts takes, and no other, unmarked");
  assert.deepEqual(doc.info["x-agentrun-serve"].unsupported_fields, refused.map((field) => `DefinitionInput.${field}`));
  const values = { input_schema: { type: "object" }, output_schema: { type: "object" } };
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
  // A place whose box this server does not have: the same, with the box.
  assert.equal((await api("POST", "/agents", agent("boxed", { place: { mode: "sandbox", box: "docker" } }))).status, 201);
  const boxed = await api("POST", "/agents/boxed/runs", { input: { content: "hi" } });
  assert.deepEqual([boxed.status, boxed.body.error.code], [409, "agent_not_runnable"]);
  assert.deepEqual(schemaProblems(doc, shape, boxed.body.error.details), [], JSON.stringify(boxed.body.error.details));
  assert.equal(boxed.body.error.details.box, "docker");
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

test("live answers meet the served document: capabilities, and an agent made, read and edited on each harness and place, against the contract plus exactly its marked properties", async (t) => {
  const { baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const { api } = await serve(t);
  const check = (name, value) => assert.deepEqual(schemaProblems(doc, { $ref: `#/components/schemas/${name}` }, value), [], `${name}: ${JSON.stringify(value)}`);
  check("Capabilities", (await api("GET", "/capabilities")).body);
  for (const [id, body] of [["on-pi", agent("on-pi", { model: "faux/faux-1", thinking: "high" })], ["on-claude", agent("on-claude", { harness: "claude-agent" })], ["in-runner", agent("in-runner", { place: { mode: "runner" } })], ["in-bwrap", agent("in-bwrap", { place: { mode: "sandbox", box: "bwrap" } })], ["in-sandbox", agent("in-sandbox", { place: { mode: "sandbox", box: "daytona" } })], ["on-codex", flowAgent("on-codex", undefined, { harness: "codex" })]]) {
    const { warnings: _, ...made } = (await api("POST", "/agents", body)).body;
    const read = (await api("GET", `/agents/${id}`)).body;
    check("Agent", made);
    check("Agent", read);
  }
  // The document's place takes the two modes the server takes, and refuses what it refuses.
  const place = doc.components.schemas.DefinitionInput.properties.place;
  for (const box of ["bwrap", "docker"]) assert.deepEqual(schemaProblems(doc, place, { mode: "sandbox", box }), []);
  assert.notDeepEqual(schemaProblems(doc, place, { mode: "tool-box", box: "bwrap" }), []);
  assert.notDeepEqual(schemaProblems(doc, place, { mode: "runner", box: "docker" }), []);
  // The same check sees a field the document does not hold: the positive control.
  assert.notDeepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, { ...(await api("GET", "/capabilities")).body, unheard_of: 1 }), []);
});

// The exported helper is what the route serves: every harness's offer resolved, its default_model included, so a direct
// caller's document holds the schema the server publishes (the field is required), on a server with a gateway, with
// providers, and with the faux harness.
const NOT_A_KEY = "fake";
test("capabilities(), the exported helper, gives a document that passes the published Capabilities schema whole", async (t) => {
  const { doc } = await served(t);
  const shape = { $ref: "#/components/schemas/Capabilities" };
  const sources = [];
  for (const env of [{}, { AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENT_MODEL: "m-1" }, { AGENT_MODEL: "anthropic/claude-sonnet-5", ANTHROPIC_API_KEY: NOT_A_KEY }, { AGENTRUN_SERVE_FAUX: FAUX }]) {
    const caps = await capabilities(env);
    sources.push(caps.models.source);
    assert.deepEqual(schemaProblems(doc, shape, caps), [], JSON.stringify(env));
    for (const harness of caps.harnesses) assert.ok("default_model" in harness, `${harness.id} names its default_model`);
  }
  assert.deepEqual(sources, ["providers", "gateway", "providers", "faux"], "every source this server answers with is proven against the schema");
  // models/2 widens the contract's enum to what this server answers with, marked as its own addition.
  const source = doc.components.schemas.Capabilities.properties.models.properties.source;
  assert.equal(source["x-agentrun-serve"], "models/2");
  assert.deepEqual(source.enum, ["managed", "chatgpt", "env", "faux", "gateway", "providers"]);
  // The positive controls: a source outside the enum, and a harness without its default_model, are refused by the same schema.
  const plain = await capabilities({});
  assert.notDeepEqual(schemaProblems(doc, shape, { ...plain, models: { ...plain.models, source: "elsewhere" } }), []);
  const caps = await capabilities({});
  assert.notDeepEqual(schemaProblems(doc, shape, { ...caps, harnesses: caps.harnesses.map(({ default_model, ...offer }) => offer) }), []);
});

test("the decision providers' widening is its own addition, decisions/3 (parallel, then its route), and info lists it", async (t) => {
  const { doc } = await served(t);
  const decisions = doc.components.schemas.Capabilities.properties.workflows.properties.decisions;
  assert.equal(decisions["x-agentrun-serve"], "decisions/3", "a client that validates against decisions/2 refuses route, so the widening is a new mark");
  assert.deepEqual(decisions.properties.providers.items.properties.route.enum, ["parallel", "openrouter"]);
  assert.deepEqual(decisions.properties.providers.items.properties.id.enum, ["jev", "parallel", "openrouter"]);
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("Capabilities.workflows.decisions"), "info names it among the marked properties");
});

test("a timeline row's usage says where it shows here: a browser call's row carries the charges booked under it, updated in place; the shape stays the contract's", async (t) => {
  const { doc } = await served(t);
  const usage = doc.components.schemas.TimelineRow.properties.usage;
  assert.equal(usage.$ref, "#/components/schemas/TimelineUsage", "the contract's shape");
  assert.match(usage["x-agentrun-serve-note"], /On a browser call's `tool_use` row .* the browser session time booked under that call/);
  assert.match(usage["x-agentrun-serve-note"], /A browser charge has no row of its own\. A charge booked after the row was served .* is served as a change of that row, with the same `id`/);
  assert.ok(doc.info["x-agentrun-serve"].notes.includes("TimelineRow.usage"));
  // A browser call's row as it is served validates against the document.
  const row = { id: "1:7:0", timestamp: "2026-11-05T12:00:00.000Z", created_at: "2026-11-05T12:00:00.000Z", kind: "tool_use", summary: "Looked at the page structure", agent_label: null, tool_name: "snapshot", tool_use_id: "call_1", tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null, seq: 3, conversation_id: 1, round: 7, usage: { usd: 0.0017, requests: 0 } };
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, row), []);
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, { ...row, usage: { usd: null, requests: 0, so_far_usd: 0.0001, unpriced: 1 } }), []);
});

/** The closed list of a run's learning reasons, as the console's read shape names them. */
const REASONS = ["seed_failed", "no_budget", "unknown_cost", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "empty", "unparsed", "propose_failed", "checker", "grader", "grade_failed"];

test("learning is this server's own addition, learning/1: the definition's switch, the server's in capabilities, a run's learning whole on its read and short in lists, its timeline row, the usage meter and the stats block, each enum whole, and the answers meet the document", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, data } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schemas = doc.components.schemas;
  for (const [schema, field] of [["DefinitionInput", "learning"], ["Run", "learning"], ["RunSummary", "learning"], ["Features", "learning"], ["TimelineRow", "learning"], ["Capabilities", "learning"]]) {
    assert.equal(schemas[schema].properties[field]?.["x-agentrun-serve"], "learning/1", `${schema}.${field} is marked`);
    assert.ok(doc.info["x-agentrun-serve"].fields.includes(`${schema}.${field}`), `info lists ${schema}.${field}`);
  }
  for (const [schema, value] of [["TimelineKind", "learning"], ["Meter", "learning"]]) {
    assert.ok(schemas[schema].enum.includes(value), `${schema} holds ${value}`);
    assert.ok(doc.info["x-agentrun-serve"].fields.includes(`${schema}.${value}`), `info lists ${schema}.${value}`);
  }
  const whole = schemas.Run.properties.learning.oneOf[0].properties;
  assert.deepEqual(whole.state.enum, ["seeded", "reflecting", "proposed", "merged", "dropped"]);
  assert.deepEqual(whole.reason.enum, [...REASONS, null], "the closed list, whole");
  assert.deepEqual(schemas.RunSummary.properties.learning.oneOf[0].properties.reason.enum, [...REASONS, null]);
  assert.deepEqual(schemas.TimelineRow.properties.learning.properties.reason.enum, [...REASONS, null]);
  const stats = doc.paths["/stats"].get.responses["200"].content["application/json"].schema.properties.learning;
  assert.equal(stats["x-agentrun-serve"], "learning/1");
  assert.deepEqual(stats.properties.dropped.propertyNames.enum, REASONS);
  assert.equal(schemas.DefinitionInput.properties.learning.default, false, "off unless an agent says so");
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features.learning, "on", "the server's switch is on by default");
  assert.deepEqual(caps.learning, { grade_model: null, pending: true, approve: false, approve_needs: "password" }, "each run graded on its own model: this server names none; a risky rule the user asked for waits; approving needs the owner's password session");
  assert.deepEqual(caps.features.usage.meters, ["tokens", "tools", "browser_time", "learning"]);
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, caps), []);
  // A run whose end-of-run turn gives no note, one whose folder cannot be made (a file where it goes), and one of an agent
  // that does not learn.
  assert.equal((await api("POST", "/agents", agent("learner", { learning: true }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("blocked", { learning: true }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  await mkdir(agentFolderOf(data, "blocked"), { recursive: true });
  await writeFile(join(agentFolderOf(data, "blocked"), "learning"), "not a folder");
  const want = { learner: ["dropped", "empty"], blocked: ["dropped", "seed_failed"], plain: null };
  for (const id of Object.keys(want)) {
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"]);
    for (let i = 0; ["seeded", "reflecting", "proposed"].includes((await api("GET", `/runs/${started.body.run_id}`)).body.learning?.state); i++) {
      assert.ok(i < 600, `${id}: its learning ends`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { rows } = await follow(api, started.body.run_id, ["completed"]);
    const read = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.deepEqual(read.learning && [read.learning.state, read.learning.reason], want[id], id);
    assert.deepEqual(schemaProblems(doc, schemas.Run.properties.learning, read.learning), [], `${id}: ${JSON.stringify(read.learning)}`);
    const listed = (await api("GET", `/agents/${id}/runs`)).body.runs[0];
    assert.deepEqual(listed.learning, want[id] && { state: want[id][0], reason: want[id][1], detail: read.learning.detail }, `${id} in its list, in the same words`);
    assert.deepEqual(schemaProblems(doc, schemas.RunSummary.properties.learning, listed.learning), [], id);
    const row = rows.filter((r) => r.kind === "learning");
    assert.equal(row.length, want[id] ? 1 : 0, `${id}: its learning row`);
    for (const r of rows) assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, r), [], `${id}: ${JSON.stringify(r)}`);
  }
  const counted = (await api("GET", "/stats")).body.learning;
  assert.deepEqual(counted, { runs: 2, merged: 0, dropped: { empty: 1, seed_failed: 1 }, in_progress: 0 });
  // The positive controls: the same checks see a reason, a kind of drop and a field the document does not hold.
  assert.notDeepEqual(schemaProblems(doc, schemas.Run.properties.learning, { state: "dropped", reason: "conflict", detail: null, at: new Date().toISOString() }), []);
  assert.notDeepEqual(schemaProblems(doc, schemas.Run.properties.learning, { state: "merged", reason: null, detail: null, at: new Date().toISOString(), verdict: null }), []);
  assert.notDeepEqual(schemaProblems(doc, stats, { ...counted, dropped: { conflict: 1 } }), []);
});

test("what a run read and learned and what learning changed for its agent are learning/2, each described: a run's used and learned, in its view and its list, absent when empty, and the agent's impact, null until both sides count 2 runs; real answers meet the document", { timeout: 180_000, skip: SWITCH_TODO }, async (t) => {
  const { api, baseUrl } = await serve(t, { learning: "on", faux: LEARN });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schemas = doc.components.schemas;
  const whole = schemas.Run.properties.learning;
  const short = schemas.RunSummary.properties.learning;
  for (const schema of [whole.oneOf[0], short.oneOf[0]]) {
    assert.ok(!("used" in schema.properties), "used is gone: given and read say it");
    for (const field of ["given", "read", "learned"]) {
      assert.equal(schema.properties[field]["x-agentrun-serve"], "learning/2", field);
      assert.ok(!schema.required.includes(field), `${field} is absent when it holds no note`);
      assert.match(schema.properties[field].description, field === "read" ? /\.learning\/.*MEMORY\.md/s : field === "given" ? /# Learned/ : /merged/, field);
    }
  }
  // A list row says the run's learning in the same words, short: its detail at most 140 characters, and no time.
  assert.ok(short.oneOf[0].required.includes("detail") && !("at" in short.oneOf[0].properties));
  assert.equal(short.oneOf[0].properties.detail.maxLength, 140);
  const agentView = doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema;
  assert.equal(agentView.properties.impact["x-agentrun-serve"], "learning/2");
  assert.ok(agentView.required.includes("impact"), "impact is always there, null until it can be said");
  assert.match(agentView.properties.impact.description, /first note/);

  // Run 1 learns nothing; run 2 learns a note; runs 3 and 4 read it.
  const id = "described";
  const reads = `Read: ${JSON.stringify([".learning/check-units.md"])}`;
  await made(api, learner(id, { tools: ["write", "read"], instructions: `Answer the question.\n${reads}` }));
  const views = [(await ended(api, await started(api, id))).view];
  const { id: _, version: __, ...next } = learner(id, { tools: ["write", "read"], instructions: `Answer the question.\n${reads}`, plan: [["check-units.md", note("Check units", "Convert every amount to one unit before comparing")]], once: true }).definition;
  assert.equal((await api("PUT", `/agents/${id}/definition`, { definition: next })).status, 200);
  for (let i = 0; i < 3; i++) views.push((await ended(api, await started(api, id))).view);
  assert.deepEqual(views.map((view) => [view.learning.state, Boolean(view.learning.given), Boolean(view.learning.read), Boolean(view.learning.learned)]), [["dropped", false, false, false], ["merged", false, false, true], ["dropped", true, true, false], ["dropped", true, true, false]]);
  const listed = (await api("GET", `/agents/${id}/runs`)).body.runs;
  const runLearning = doc.paths["/runs/{run_id}/learning"].get.responses["200"].content["application/json"].schema;
  for (const field of ["given", "read", "learned"]) assert.equal(runLearning.oneOf[0].properties[field]["x-agentrun-serve"], "learning/2", `GET /runs/{run_id}/learning's ${field}`);
  assert.match(whole.oneOf[0].properties.read.description, /bash/, "a read through a command is not counted, and says so");
  for (const view of views) {
    const all = (await api("GET", `/runs/${view.run_id}/learning`)).body;
    assert.deepEqual([all.given, all.read, all.learned], [view.learning.given, view.learning.read, view.learning.learned], "the run's learning whole names the same notes");
    assert.deepEqual(schemaProblems(doc, runLearning, all), [], JSON.stringify(all));
    assert.deepEqual(schemaProblems(doc, whole, view.learning), [], JSON.stringify(view.learning));
    const row = listed.find((run) => run.run_id === view.run_id).learning;
    assert.deepEqual(schemaProblems(doc, short, row), [], JSON.stringify(row));
  }
  const agentLearning = (await api("GET", `/agents/${id}/learning`)).body;
  assert.deepEqual([agentLearning.impact?.before.runs, agentLearning.impact?.after.runs], [2, 2]);
  assert.deepEqual(schemaProblems(doc, agentView, agentLearning), [], JSON.stringify(agentLearning.impact));
  assert.deepEqual(schemaProblems(doc, agentView, { ...agentLearning, impact: null }), [], "null is in the document");
  // The positive controls: an empty list, a learned note without what it replaced, and an impact side out of shape.
  const merged = views[1].learning;
  assert.notDeepEqual(schemaProblems(doc, whole, { ...merged, read: [] }), []);
  assert.notDeepEqual(schemaProblems(doc, whole, { ...merged, given: [] }), []);
  assert.notDeepEqual(schemaProblems(doc, whole, { ...merged, used: [{ file: "a.md", name: "A" }] }), [], "used is no field any more");
  assert.notDeepEqual(schemaProblems(doc, whole, { ...merged, learned: [{ file: "a.md", name: "A" }] }), []);
  assert.notDeepEqual(schemaProblems(doc, short, { state: "merged", reason: null, detail: merged.detail, learned: merged.learned, at: merged.at }), [], "a list has no time");
  assert.notDeepEqual(schemaProblems(doc, short, { state: "merged", reason: null, detail: "x".repeat(141) }), [], "a list's detail is short");
  assert.notDeepEqual(schemaProblems(doc, agentView, { ...agentLearning, impact: { ...agentLearning.impact, after: { runs: 2, median_duration_s: 1 } } }), []);
});

test("what a person sees and controls of an agent's learning is learning/1: each route marked, its writes' 412 and 428, a refused note's problems on the error, and precondition_required among the codes", async (t) => {
  const { doc } = await served(t);
  const routes = { "/agents/{agent_id}/learning": ["get"], "/agents/{agent_id}/learning/notes": ["get"], "/agents/{agent_id}/learning/log": ["get"], "/agents/{agent_id}/learning/files/{file}": ["get", "put"], "/agents/{agent_id}/learning/files/{file}/retire": ["post"], "/runs/{run_id}/learning": ["get"], "/runs/{run_id}/learning/diff": ["get"] };
  for (const [path, methods] of Object.entries(routes)) {
    for (const method of methods) assert.equal(doc.paths[path][method]["x-agentrun-serve"], "learning/1", `${method.toUpperCase()} ${path}`);
  }
  for (const write of [doc.paths["/agents/{agent_id}/learning/files/{file}"].put, doc.paths["/agents/{agent_id}/learning/files/{file}/retire"].post]) {
    assert.ok(["200", "400", "412", "428"].every((status) => write.responses[status]), write.operationId);
    assert.ok(write.responses["200"].headers.ETag, `${write.operationId} answers the note's ETag`);
  }
  assert.ok(doc.paths["/agents/{agent_id}/learning/files/{file}"].put.responses["201"], "a create is 201");
  assert.equal(doc.components.schemas.ErrorBody.properties.problems["x-agentrun-serve"], "learning/1");
  assert.ok(doc.components.schemas.ErrorCode.enum.includes("precondition_required"));
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("ErrorBody.problems") && doc.info["x-agentrun-serve"].fields.includes("ErrorCode.precondition_required"));
});

test("an agent's home is its own addition, home/1: its routes and capabilities.home marked and listed, beside the contract's packed home, and its answers meet the document", async (t) => {
  const { api, baseUrl, token, data } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const at = "/agents/{agent_id}/home/files";
  const files = doc.paths[at];
  const file = doc.paths[`${at}/{path}`];
  for (const [op, name] of [[files.get, "listHomeFiles"], [file.get, "readHomeFile"], [file.put, "writeHomeFile"], [file.delete, "deleteHomeFile"]]) {
    assert.deepEqual([op.operationId, op["x-agentrun-serve"]], [name, "home/1"]);
    assert.ok(op.responses["404"] && op.responses["401"], `${name} answers 401 and 404`);
  }
  assert.ok(file.put.responses["403"] && file.put.responses["413"] && file.delete.responses["403"], "a write answers 403, and a PUT 413");
  assert.deepEqual(Object.keys(doc.paths["/agents/{agent_id}/home"]).sort(), Object.keys(VENDORED.paths["/agents/{agent_id}/home"]).sort(), "the contract's packed home keeps its path and methods");
  assert.equal(doc.paths["/agents/{agent_id}/home"].get["x-agentrun-serve-unsupported"].capability, "home.export");
  assert.equal(doc.components.schemas.Capabilities.properties.home["x-agentrun-serve"], "home/1");
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("Capabilities.home"));

  assert.equal((await api("POST", "/agents", agent("keeper"))).status, 201);
  const headers = { authorization: `Bearer ${token}` };
  const home = `${baseUrl}/agents/keeper/home/files`;
  const written = await fetch(`${home}/notes/a.md`, { method: "PUT", headers, body: "# A\n" });
  assert.equal(written.status, 200);
  const json = (op, status) => op.responses[status].content["application/json"].schema;
  assert.deepEqual(schemaProblems(doc, json(file.put, "200"), await written.json()), []);
  // A host-owned note, planted as the server would: learning lists as one entry of its own shape, the note not at all.
  await mkdir(join(agentHomeFolder(data, "keeper"), "learning"));
  await writeFile(join(agentHomeFolder(data, "keeper"), "learning", "l.md"), "learned");
  const listed = (await api("GET", "/agents/keeper/home/files")).body;
  assert.deepEqual(listed.files.map((f) => [f.path, f.host_owned]), [["learning", true], ["notes/a.md", undefined]]);
  assert.deepEqual(schemaProblems(doc, json(files.get, "200"), listed), []);
  // Each entry is exactly one of the two shapes: a file's entry is no host entry, and a host entry no file's.
  assert.notDeepEqual(schemaProblems(doc, json(files.get, "200"), { ...listed, files: [{ ...listed.files[1], host_owned: true }] }), []);
  const read = await (await fetch(`${home}/learning/l.md`, { headers })).json();
  assert.deepEqual([read.error.code, read.error.details], ["system_file_forbidden", { reason: "host_owned" }]);
  const forbidden = await (await fetch(`${home}/learning/l.md`, { method: "PUT", headers, body: "x" })).json();
  const shape = doc.components.schemas.ErrorBody.properties.details["x-agentrun-serve-details"]?.system_file_forbidden;
  assert.ok(shape, "the document gives system_file_forbidden's details");
  assert.deepEqual(schemaProblems(doc, shape, forbidden.error.details), [], JSON.stringify(forbidden.error));
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Error" }, forbidden), []);
});

test("a tool key's save documents every status it answers, 503 unavailable among them: a save still checking its key when the server closes keeps nothing", async (t) => {
  const { doc } = await served(t);
  const save = doc.paths["/settings/tool-keys/{key_id}"].put;
  assert.deepEqual(Object.keys(save.responses).sort(), ["204", "400", "401", "409", "415", "422", "429", "500", "503"]);
  assert.equal(save.responses["503"]?.$ref, "#/components/responses/Unavailable");
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

test("the not-metered counts are this server's own fields: TimelineUsage.not_metered and UsageLine.not_metered_calls, marked and listed; UsageLine.unpriced_runs is documented", async (t) => {
  const { baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  for (const [schema, field] of [["TimelineUsage", "not_metered"], ["UsageLine", "not_metered_calls"]]) {
    assert.deepEqual([doc.components.schemas[schema].properties[field]?.type, doc.components.schemas[schema].properties[field]?.["x-agentrun-serve"]], ["integer", "mcpservers/1"], `${schema}.${field}`);
    assert.ok(doc.info["x-agentrun-serve"].fields.includes(`${schema}.${field}`), `info lists ${schema}.${field}`);
  }
  assert.equal(doc.components.schemas.UsageLine.properties.unpriced_runs?.type, "integer");
});

test("what /usage and an agentic run's pause answer is in the document: the report's unpriced_runs, and 501 on pause and resume", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const report = (await api("GET", "/usage")).body;
  assert.equal(typeof report.unpriced_runs, "number");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Usage" }, report), []);
  for (const path of ["/runs/{run_id}/pause", "/runs/{run_id}/resume"]) assert.ok(doc.paths[path].post.responses["501"], `${path} documents 501`);
});

test("the agent create and update answers carry warnings, which the document now allows: A2", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const created = await api("POST", "/agents", agent("qa-warnings", { harness: "claude-agent" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(Array.isArray(created.body.warnings) && created.body.warnings.some((w) => w.field === "definition.harness"), "POST /agents warns of a harness it does not run here");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Agent" }, created.body), [], "the create answer, warnings included, meets Agent");
  const updated = await api("PUT", "/agents/qa-warnings/definition", { definition: { instructions: "Answer, again.", harness: "claude-agent" } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.ok(Array.isArray(updated.body.warnings) && updated.body.warnings.some((w) => w.field === "definition.harness"), "PUT .../definition warns the same way");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Agent" }, updated.body), [], "the commit answer, warnings included, meets Agent");
});

test("a workflow revision names no instructions, version, skills or tools, which the document now allows, and keeps the 422s instructions and workflow together or neither give: A4", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const body = flowAgent("qa-workflow-fields");
  assert.deepEqual(body.definition.version ?? body.definition.skills ?? body.definition.tools, undefined, "the create names none of the three");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/DefinitionInput" }, body.definition), [], "the create's definition meets DefinitionInput without instructions, version, skills or tools");
  const created = await api("POST", "/agents", body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const read = await api("GET", "/agents/qa-workflow-fields");
  assert.equal(read.status, 200);
  assert.equal(read.body.definition.instructions, undefined, "a workflow revision's own answer has none");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Agent" }, read.body), [], "the read answer, instructions absent, meets Agent");
  const both = await api("POST", "/agents", agent("qa-workflow-both", { workflow: body.definition.workflow }));
  assert.deepEqual([both.status, both.body.error.fields[0].field, both.body.error.fields[0].reason], [422, "definition.workflow", "not_allowed"], "instructions and workflow together are still refused");
  const neither = await api("POST", "/agents", { definition: { id: "qa-workflow-neither", name: "x" } });
  assert.deepEqual([neither.status, neither.body.error.fields[0].field, neither.body.error.fields[0].reason], [422, "definition.instructions", "missing"], "neither is still refused");
});

test("GET /agents documents archived, as GET /runs already does, and lists an archived agent by it: C1", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const param = doc.paths["/agents"].get.parameters.find((p) => p.name === "archived");
  assert.ok(param, "GET /agents documents archived");
  assert.deepEqual([param.in, param.required, param.schema.type], ["query", false, "boolean"]);
  await made(api, agent("qa-archived"));
  assert.equal((await api("POST", "/agents/qa-archived/archive")).status, 200);
  const archived = await api("GET", "/agents?archived=true");
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok(archived.body.agents.some((a) => a.agent_id === "qa-archived"), "the archived agent is in the archived list");
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/AgentList" }, archived.body), []);
});

test("what this server always sends is required in the document: a run's revision, kind and archived_at, on a run and in a list, an agent's tools on its own route, and a trigger's zone and interval start, which a write may leave out", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl } = await serve(t, { triggerClock: fakeClock("2026-10-31T12:00:00Z") });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  for (const name of ["Run", "RunSummary"]) for (const field of RUN_FIELDS_SENT) assert.ok(doc.components.schemas[name].required.includes(field), `${name}.${field} is required`);
  await made(api, agent("nightly"));
  const runId = await started(api, "nightly");
  const run = (await api("GET", `/runs/${runId}`)).body;
  const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  for (const [what, value] of [["a run", run], ["a list's run", listed]]) for (const field of RUN_FIELDS_SENT) assert.ok(value && field in value, `${what} holds ${field}`);

  // GET /agents/{agent_id} always holds the agent's tools, so its answer requires them; an answer without is not the document's.
  const agentAnswer = doc.paths["/agents/{agent_id}"].get.responses["200"].content["application/json"].schema;
  const agentRead = (await api("GET", "/agents/nightly")).body;
  assert.ok(Array.isArray(agentRead.tools), "an agent holds its tools");
  assert.deepEqual(schemaProblems(doc, agentAnswer, agentRead), [], JSON.stringify(agentRead));
  const { tools: _tools, ...toolless } = agentRead;
  assert.notDeepEqual(schemaProblems(doc, agentAnswer, toolless), [], "an agent without tools is not the document's");

  const answer = doc.paths["/triggers/{trigger_id}"].get.responses["200"].content["application/json"].schema;
  const write = doc.paths["/triggers"].post.requestBody.content["application/json"].schema;
  for (const [source, filled] of [[{ cron: "30 1 * * *" }, "timezone"], [{ every_s: 600 }, "start_at"]]) {
    // One name per trigger of an agent (the store's UNIQUE (agent_id, name)): each its own.
    const body = schedule("nightly", source, { name: `nightly ${filled}` });
    assert.deepEqual(schemaProblems(doc, write, body), [], `a write may leave ${filled} out`);
    const created = await api("POST", "/triggers", body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(typeof created.body.source[filled], "string", `the server fills ${filled} in`);
    const read = (await api("GET", `/triggers/${created.body.id}`)).body;
    assert.deepEqual(schemaProblems(doc, answer, read), [], JSON.stringify(read));
    const { [filled]: _, ...without } = read.source;
    assert.notDeepEqual(schemaProblems(doc, answer, { ...read, source: without }), [], `an answer without ${filled} is not the document's`);
  }
});

test("every InputIssue reason the MCP registry sends is one the document's InputIssue lists (a URL's redirect among them)", async () => {
  const { openapiDocument } = await import("../dist/openapi.js");
  const listed = openapiDocument(() => undefined).components.schemas.InputIssue.properties.reason.enum;
  const sent = new Set();
  for (const file of ["mcp-probe.ts", "mcp-servers-store.ts", "mcp-private-hosts.ts"]) {
    for (const [, reason] of (await readFile(new URL(`../src/${file}`, import.meta.url), "utf8")).matchAll(/reason: "([a-z_]+)"/g)) sent.add(reason);
  }
  assert.ok(sent.has("redirect"), "the registry refuses a redirect with reason redirect");
  assert.deepEqual([...sent].filter((reason) => !listed.includes(reason)).sort(), []);
});
