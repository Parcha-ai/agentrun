// A monid grant is read against monid's listing at the save and pinned on the revision (monid.ts pinMonid, server.ts
// saveable): a provider's wildcard as every endpoint monid lists for it, one endpoint as monid inspects it, each with its
// input and what one call is held at. A grant monid does not list, or one saved with no monid key, is refused in words;
// the pin is never shown in the definition. Faux monid's listing (fixtures/faux-monid.mjs LISTING), no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const { MONID_USAGE_CEILING_USD } = await import("../dist/monid.js");

/** The pin the agent `id`'s current revision holds, as its runs read it. */
const pinOf = async (store, id) => {
  const [current] = (await store.agents.revisions(id)).slice(-1);
  return current.body.monidPin;
};

test("monid:apollo/* resolves at the save to the endpoints monid lists for apollo, each pinned with its input and price", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("apollo", { tools: ["monid:apollo/*", "monid:faux/person/enrich"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.tools ?? saved.body.definition?.tools, ["monid:apollo/*", "monid:faux/person/enrich"], "the grants as given");
  assert.doesNotMatch(JSON.stringify(saved.body), /monidPin|monid_pin/, "the pin is never shown");
  const pin = await pinOf(store, "apollo");
  assert.deepEqual(Object.keys(pin), ["monid:apollo/news_articles/search", "monid:apollo/people/match", "monid:faux/person/enrich"]);
  assert.deepEqual(Object.fromEntries(Object.entries(pin).map(([name, one]) => [name, [one.usd, one.usage ?? false]])), {
    "monid:apollo/news_articles/search": [MONID_USAGE_CEILING_USD, true],
    "monid:apollo/people/match": [0.026, false],
    "monid:faux/person/enrich": [0.003, false],
  });
  assert.deepEqual(pin["monid:apollo/people/match"].input, { type: "object", additionalProperties: false, properties: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, required: ["body"] }, "its input, monid's $schema left out");
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
  assert.equal(await inspects(), 2, "a new version is pinned at its first run");
});

test("a monid grant saved with no monid key is refused: it cannot be pinned", async (t) => {
  withEnv(t, {}, ["MONID_API_KEY"]);
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const saved = await api("POST", "/agents", agent("keyless", { tools: ["monid:apollo/people/match"] }));
  assert.equal(saved.status, 422, JSON.stringify(saved.body));
  assert.match(JSON.stringify(saved.body), /no monid key here to read it with: save the monid key in Settings → Tool keys first/);
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
    assert.match(issue.message, /^The monid endpoint monid:tagger\/tag cannot be offered on codex: \/properties\/body\/patternProperties: patternProperties is not supported by Codex/, issue.message);
  }
  assert.equal((await api("GET", "/agents/tagger-codex")).status, 404, "nothing saved");
  const pi = await api("POST", "/agents", agent("tagger-pi", { tools: ["monid:tagger/*"] }));
  assert.equal(pi.status, 201, JSON.stringify(pi.body));
  assert.deepEqual(Object.keys(await pinOf(store, "tagger-pi")), ["monid:tagger/tag"]);
});
