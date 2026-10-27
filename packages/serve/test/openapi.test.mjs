// GET /v2/openapi.json: the agentrun.v2/0 contract as vendored, with this server's marks. It holds every route the
// server serves and nothing it does not, the contract's operations unchanged, and its references whole.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { ROUTES } from "../dist/server.js";
import { serve } from "./support.mjs";

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
      assert.equal(op["x-agentrun-serve"], true, `${method.toUpperCase()} ${path} is this server's own, and marked`);
      own.push(`${method.toUpperCase()} ${path}`);
      continue;
    }
    const { "x-agentrun-serve-unsupported": _, ...rest } = op;
    assert.ok(isDeepStrictEqual(rest, original), `${op.operationId} is the contract's, unchanged`);
    assert.equal(op["x-agentrun-serve"], undefined);
  }
  assert.equal(vendored.size + own.length, operations(doc).length, "no contract operation is gone");
  assert.deepEqual(own.sort(), [...doc.info["x-agentrun-serve"].extensions].sort(), "info lists the server's own");
  assert.ok(isDeepStrictEqual(doc.components, VENDORED.components), "the contract's components are unchanged");
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
