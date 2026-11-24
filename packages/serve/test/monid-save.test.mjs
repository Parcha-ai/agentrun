// A monid grant is read against monid's listing at the save and pinned on the revision (monid.ts pinMonid, server.ts
// saveable): a provider's wildcard as every endpoint monid lists for it, one endpoint as monid inspects it, each with its
// input and what one call is held at. A grant monid does not list, or one saved with no monid key, is refused in words.
// An endpoint priced by usage is pinned too, named or from a wildcard, each named in the save's warnings: monid can't cap
// what such a call charges. The pin is never shown in the definition. Faux monid's listing (fixtures/faux-monid.mjs
// LISTING), no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
/** The warning a save gives for each endpoint priced by usage it pins. */
const USAGE = (tool) => `${tool} is priced by usage: monid can't cap what it charges, so a call can cost more than its estimate and more than the run's cap allows.`;

/** The pin the agent `id`'s current revision holds, as its runs read it. */
const pinOf = async (store, id) => {
  const [current] = (await store.agents.revisions(id)).slice(-1);
  return current.monidPin;
};

test("monid:apollo/* resolves at the save to the endpoints monid lists for apollo, each pinned with its input and price", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("apollo", { tools: ["monid:apollo/*", "monid:faux/person/enrich"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.tools ?? saved.body.definition?.tools, ["monid:apollo/*", "monid:faux/person/enrich"], "the grants as given");
  assert.doesNotMatch(JSON.stringify(saved.body), /monidPin|monid_pin/, "the pin is never shown");
  const pin = await pinOf(store, "apollo");
  assert.deepEqual(Object.fromEntries(Object.entries(pin).map(([name, one]) => [name, one.usd])), { "monid:apollo/news_articles/search": null, "monid:apollo/organizations/enrich": 0.01, "monid:apollo/people/match": 0.026, "monid:faux/person/enrich": 0.003 });
  assert.deepEqual(pin["monid:apollo/people/match"].input, { type: "object", additionalProperties: false, properties: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, required: ["body"] }, "its input, monid's $schema left out");
});

test("a named grant of an endpoint priced by usage saves, pinned, with a warning naming it", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const named = await api("POST", "/agents", agent("usage-named", { tools: ["monid:faux/person/enrich", "monid:apollo/news_articles/search"] }));
  assert.equal(named.status, 201, JSON.stringify(named.body));
  const pin = await pinOf(store, "usage-named");
  assert.deepEqual(Object.fromEntries(Object.entries(pin).map(([name, one]) => [name, one.usd])), { "monid:apollo/news_articles/search": null, "monid:faux/person/enrich": 0.003 }, "pinned, with no fixed price: each call is held at monid's estimate");
  const usage = (named.body.warnings ?? []).filter((warning) => warning.message.includes("priced by usage"));
  assert.deepEqual(usage.map(({ field, reason, message }) => ({ field, reason, message })), [{ field: "definition.tools[1]", reason: "priced_by_usage", message: USAGE("monid:apollo/news_articles/search") }], JSON.stringify(named.body.warnings));
});

test("a provider's wildcard keeps its endpoints priced by usage, each named in a warning at the wildcard's grant; a provider priced only by usage saves too", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const wild = await api("POST", "/agents", agent("usage-wild", { tools: ["monid:faux/person/enrich", "monid:apollo/*", "monid:metered/*"] }));
  assert.equal(wild.status, 201, JSON.stringify(wild.body));
  assert.deepEqual(Object.keys(await pinOf(store, "usage-wild")), ["monid:apollo/news_articles/search", "monid:apollo/organizations/enrich", "monid:apollo/people/match", "monid:faux/person/enrich", "monid:metered/rows"], "every endpoint pinned");
  const usage = (wild.body.warnings ?? []).filter((warning) => warning.message.includes("priced by usage"));
  assert.deepEqual(usage.map(({ field, message }) => ({ field, message })), [
    { field: "definition.tools[1]", message: USAGE("monid:apollo/news_articles/search") },
    { field: "definition.tools[2]", message: USAGE("monid:metered/rows") },
  ], JSON.stringify(wild.body.warnings));
});

test("a grant monid does not list is refused at the save in words, nothing saved", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const endpoint = await api("POST", "/agents", agent("nope", { tools: ["monid:apollo/people/nowhere"] }));
  assert.equal(endpoint.status, 422, JSON.stringify(endpoint.body));
  assert.match(JSON.stringify(endpoint.body), /monid lists no endpoint \/people\/nowhere of a provider apollo/);
  const provider = await api("POST", "/agents", agent("nope2", { tools: ["monid:nobody/*"] }));
  assert.equal(provider.status, 422, JSON.stringify(provider.body));
  assert.match(JSON.stringify(provider.body), /monid lists no endpoint of a provider nobody/);
  const grammar = await api("POST", "/agents", agent("nope3", { tools: ["monid.run"] }));
  assert.equal(grammar.status, 422, "monid's old tools are no tools");
  assert.equal((await api("GET", "/agents/nope")).status, 404);
});

test("an inline agent's version already run keeps the pin its first run stamped: monid is not read again, and the same definition runs", async (t) => {
  const log = join(await scratch(t), "monid-calls.ndjson");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const inline = { external: { source: "grep", kind: "expert", id: "7", version: 1 }, definition: { name: "Expert 7", instructions: "Answer.", skills: [], tools: ["monid:faux/person/enrich"] }, input: { content: "Hi" } };
  const inspects = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.includes("/v1/inspect")).length;
  const first = await api("POST", "/runs", inline);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(await inspects(), 1, "the version's first run pins it");
  const again = await api("POST", "/runs", inline);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(await inspects(), 1, "a later run of the version reads its stored pin, not monid's listing now");
  const next = await api("POST", "/runs", { ...inline, external: { ...inline.external, version: 2 } });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  assert.equal(await inspects(), 1, "a new version's first run is its save: one granting what the agent's current revision grants carries that pin, nothing read");
});

test("an edit that leaves the monid grants as they were reads nothing of monid's and keeps the pin; a grant it adds is read alone", async (t) => {
  const log = join(await scratch(t), "monid-calls.ndjson");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const reads = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line).path);
  const tools = ["monid:apollo/*", "monid:faux/person/enrich"];
  assert.equal((await api("POST", "/agents", agent("kept", { tools }))).status, 201);
  const first = await reads();
  assert.ok(first.some((path) => path.startsWith("/v1/endpoints")) && first.includes("/v1/inspect"), JSON.stringify(first));
  const pinned = await pinOf(store, "kept");
  const edited = await api("PUT", "/agents/kept/definition", { definition: { instructions: "Answer in one line.", tools } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(await reads(), first, "the listing is not read again");
  assert.deepEqual(await pinOf(store, "kept"), pinned, "the same pin");
  assert.deepEqual(edited.body.warnings.filter((warning) => warning.reason === "priced_by_usage").map(({ field, message }) => ({ field, message })), [{ field: "definition.tools[0]", message: USAGE("monid:apollo/news_articles/search") }], "a kept endpoint priced by usage is still said");
  const added = await api("PUT", "/agents/kept/definition", { definition: { instructions: "Answer in one line.", tools: [...tools, "monid:metered/rows"] } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual((await reads()).slice(first.length), ["/v1/inspect"], "the added grant alone is read");
  assert.deepEqual(Object.keys(await pinOf(store, "kept")), [...Object.keys(pinned), "monid:metered/rows"].sort());
});

test("an endpoint already pinned under a kept grant is not read again when a wildcard or named grant over it is added", async (t) => {
  const log = join(await scratch(t), "monid-calls.ndjson");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const reads = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const named = "monid:apollo/people/match";
  assert.equal((await api("POST", "/agents", agent("over", { tools: [named] }))).status, 201);
  const pinned = (await pinOf(store, "over"))[named];
  const before = (await reads()).length;
  assert.equal((await api("PUT", "/agents/over/definition", { definition: { instructions: "Answer.", tools: [named, "monid:apollo/*"] } })).status, 200);
  assert.ok(!(await reads()).slice(before).some((call) => call.endpoint === "/people/match"), "the kept endpoint is not inspected again");
  assert.deepEqual((await pinOf(store, "over"))[named], pinned, "its pin as saved");
  assert.equal((await api("POST", "/agents", agent("over2", { tools: ["monid:apollo/*"] }))).status, 201);
  const wild = (await reads()).length;
  assert.equal((await api("PUT", "/agents/over2/definition", { definition: { instructions: "Answer.", tools: ["monid:apollo/*", named] } })).status, 200);
  assert.deepEqual((await reads()).slice(wild), [], "a named grant of an endpoint its kept wildcard pinned reads nothing");
});

test("a monid grant saved with no monid key is refused: it cannot be pinned", async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("keyless", { tools: ["monid:apollo/people/match"] }));
  assert.equal(saved.status, 422, JSON.stringify(saved.body));
  assert.match(JSON.stringify(saved.body), /no monid key here to read it with: save the monid key in Settings → API Keys first/);
});

test("monid's error that echoes the key it was sent is refused at the save with the key cut from it, on the listing and on an inspect", async (t) => {
  for (const [path, grant] of [["/v1/inspect", "monid:faux/person/enrich"], ["/v1/endpoints", "monid:apollo/*"]]) {
    await t.test(path, async (t) => {
      withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_ECHO: path });
      const { api } = await serve(t, { fauxMonid: FAUX_MONID });
      const saved = await api("POST", "/agents", agent("echo", { tools: [grant] }));
      assert.equal(saved.status, 422, JSON.stringify(saved.body));
      assert.match(JSON.stringify(saved.body), /No such endpoint for the key \[redacted\]/, "monid's words, the key cut");
      assert.ok(!JSON.stringify(saved.body).includes(KEY), "no key in the refusal");
    });
  }
});

test("an endpoint whose input the agent's harness refuses is refused at the save, at the grant that names it, in words; another harness takes it", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  for (const grant of ["monid:tagger/tag", "monid:tagger/*"]) {
    const saved = await api("POST", "/agents", agent("tagger-codex", { harness: "codex", tools: ["monid:faux/person/enrich", grant] }));
    assert.equal(saved.status, 422, JSON.stringify(saved.body));
    const [issue, ...more] = saved.body.error.fields;
    assert.deepEqual(more, [], "the one endpoint, once");
    assert.equal(issue.field, "definition.tools[1]", JSON.stringify(issue));
    assert.match(issue.message, /^The tool monid:tagger\/tag cannot be offered on codex: \/properties\/body\/patternProperties: patternProperties is not supported by Codex/, issue.message);
  }
  assert.equal((await api("GET", "/agents/tagger-codex")).status, 404, "nothing saved");
  const pi = await api("POST", "/agents", agent("tagger-pi", { tools: ["monid:tagger/*"] }));
  assert.equal(pi.status, 201, JSON.stringify(pi.body));
  assert.deepEqual(Object.keys(await pinOf(store, "tagger-pi")), ["monid:tagger/tag"]);
});

test("a carried pin is still held to the harness when the monid key is gone: a move to a harness that refuses its input is refused, never only the key's warning", async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: KEY } })).status, 204);
  assert.equal((await api("POST", "/agents", agent("carried", { tools: ["monid:tagger/tag"] }))).status, 201);
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  const moved = await api("PUT", "/agents/carried/definition", { definition: { harness: "codex", instructions: "Answer in one line.", tools: ["monid:tagger/tag"] } });
  assert.equal(moved.status, 422, JSON.stringify(moved.body));
  assert.match(JSON.stringify(moved.body.error?.fields ?? moved.body), /The tool monid:tagger\/tag cannot be offered on codex: /, "the harness's refusal, not the missing key");
});
