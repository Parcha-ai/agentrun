// GET /v2/openapi.json: the agentrun.v2/0 contract as vendored, with this server's marks. It holds every route the
// server serves and nothing it does not, the contract's operations unchanged, and its references whole.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { decisionRows } from "../dist/decision-rows.js";
import { homeOf } from "../dist/files.js";
import { ROUTES } from "../dist/server.js";
import { DEFINITION_FIELDS } from "../dist/validate.js";
import { schemaProblems } from "./schema-support.mjs";
import { capabilities } from "../dist/index.js";
import { agent, FAUX, flowAgent, follow, serve } from "./support.mjs";

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
    if (id !== "on-codex") {
      check("Agent", made);
      check("Agent", read);
      continue;
    }
    // A workflow definition keeps no instructions, which v2/0 requires of every definition: the one gap left, for v2/1.
    for (const answer of [made, read]) assert.deepEqual([...new Set(schemaProblems(doc, { $ref: "#/components/schemas/Agent" }, answer))], ["$.definition.instructions: is required"]);
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

test("the decision providers' widening to parallel is its own addition, decisions/2, and info lists it", async (t) => {
  const { doc } = await served(t);
  const decisions = doc.components.schemas.Capabilities.properties.workflows.properties.decisions;
  assert.equal(decisions["x-agentrun-serve"], "decisions/2", "a client that validates against decisions/1 refuses parallel, so the widening is a new mark");
  assert.deepEqual(decisions.properties.providers.items.properties.id.enum, ["jev", "parallel", "openrouter"]);
  assert.ok(doc.info["x-agentrun-serve"].fields.includes("Capabilities.workflows.decisions"), "info names it among the marked properties");
});

/** The closed list of a run's learning reasons, as the console's read shape names them. */
const REASONS = ["seed_failed", "no_budget", "unknown_cost", "no_write_tool", "tool_denied", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "empty", "propose_failed", "checker", "screen", "screen_down", "grader", "grade_failed"];

test("learning is this server's own addition, learning/1: the definition's switch, the server's in capabilities, a run's learning whole on its read and short in lists, its timeline row, the usage meter and the stats block, each enum whole, and the answers meet the document", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, data } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schemas = doc.components.schemas;
  for (const [schema, field] of [["DefinitionInput", "learning"], ["Run", "learning"], ["RunSummary", "learning"], ["Features", "learning"], ["TimelineRow", "learning"]]) {
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
  assert.deepEqual(caps.features.usage.meters, ["tokens", "tools", "learning"]);
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, caps), []);
  // A run whose agent has no write tool, one whose folder cannot be made (a file where it goes), and one of an agent that
  // does not learn.
  assert.equal((await api("POST", "/agents", agent("learner", { learning: true }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("blocked", { learning: true }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  await mkdir(homeOf(data, "blocked"), { recursive: true });
  await writeFile(join(homeOf(data, "blocked"), "learning"), "not a folder");
  const want = { learner: ["dropped", "no_write_tool"], blocked: ["dropped", "seed_failed"], plain: null };
  for (const id of Object.keys(want)) {
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"]);
    const read = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.deepEqual(read.learning && [read.learning.state, read.learning.reason], want[id], id);
    assert.deepEqual(schemaProblems(doc, schemas.Run.properties.learning, read.learning), [], `${id}: ${JSON.stringify(read.learning)}`);
    const listed = (await api("GET", `/agents/${id}/runs`)).body.runs[0];
    assert.deepEqual(listed.learning, want[id] && { state: want[id][0], reason: want[id][1] }, `${id} in its list`);
    assert.deepEqual(schemaProblems(doc, schemas.RunSummary.properties.learning, listed.learning), [], id);
    const row = rows.filter((r) => r.kind === "learning");
    assert.equal(row.length, want[id] ? 1 : 0, `${id}: its learning row`);
    for (const r of rows) assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineRow" }, r), [], `${id}: ${JSON.stringify(r)}`);
  }
  const counted = (await api("GET", "/stats")).body.learning;
  assert.deepEqual(counted, { runs: 2, merged: 0, dropped: { no_write_tool: 1, seed_failed: 1 }, in_progress: 0 });
  // The positive controls: the same checks see a reason, a kind of drop and a field the document does not hold.
  assert.notDeepEqual(schemaProblems(doc, schemas.Run.properties.learning, { state: "dropped", reason: "conflict", detail: null, at: new Date().toISOString() }), []);
  assert.notDeepEqual(schemaProblems(doc, schemas.Run.properties.learning, { state: "merged", reason: null, detail: null, at: new Date().toISOString(), verdict: null }), []);
  assert.notDeepEqual(schemaProblems(doc, stats, { ...counted, dropped: { conflict: 1 } }), []);
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
  await mkdir(join(homeOf(data, "keeper"), "learning"));
  await writeFile(join(homeOf(data, "keeper"), "learning", "l.md"), "learned");
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
