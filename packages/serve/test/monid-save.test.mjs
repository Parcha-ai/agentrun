// A monid grant is read against monid's listing at the save and pinned on the revision (monid.ts pinMonid, server.ts
// saveable): a provider's wildcard as every endpoint monid lists for it, one endpoint as monid inspects it, each with its
// input and what one call is held at. A grant monid does not list, or one saved with no monid key, is refused in words;
// the pin is never shown in the definition. Faux monid's listing (fixtures/faux-monid.mjs LISTING), no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
/** faux /person/search: priced per result, and a call charges $1.42 (fixtures/faux-monid.mjs). */
const SEARCH = "monid:faux/person/search";
/** The words an endpoint priced by usage is refused or left out in: what it is, how monid prices it, and why. */
const UNBOUNDED = (tool, how) => new RegExp(`${tool.replaceAll("/", "\\/")} cannot be granted: monid prices it ${how}, so what one call costs is known only after it has run, and monid does not bound it \\(a run's maxCost checks only monid's estimate, which a call priced by usage can pass\\)\\. A run's cap could not be kept: grant endpoints monid prices per call\\.`);

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
  assert.deepEqual(Object.fromEntries(Object.entries(pin).map(([name, one]) => [name, one.usd])), { "monid:apollo/people/match": 0.026, "monid:faux/person/enrich": 0.003 });
  assert.deepEqual(pin["monid:apollo/people/match"].input, { type: "object", additionalProperties: false, properties: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, required: ["body"] }, "its input, monid's $schema left out");
});

test("(a) a call priced by usage that monid would charge past the run's cap is refused before it runs: nothing sent to monid, nothing booked", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.ndjson");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const runs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run");
  // One call, allowed, under a $1.20 cap; monid charges it $1.42.
  const inline = { external: { source: "grep", kind: "expert", id: "usage", version: 1 }, definition: { name: "Usage", instructions: "Answer.", skills: [], tools: [SEARCH], tool_settings: { [SEARCH]: { permission: "allow" } } }, input: { content: "Run monid's /person/search, called again after a raise." }, max_cost_usd: 1.2 };
  const started = await api("POST", "/runs", inline);
  if (started.status === 202) {
    // What the run booked, for the failure's words.
    const { run_id } = started.body;
    await follow(api, run_id, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    const ran = (await api("GET", `/runs/${run_id}`)).body;
    assert.fail(`started, sent ${(await runs()).length} call(s) to monid, and booked $${ran.cost?.usd} against its $${ran.cost?.cap_usd} cap`);
  }
  assert.equal(started.status, 422, JSON.stringify(started.body));
  assert.match(JSON.stringify(started.body), UNBOUNDED(SEARCH, "per result \\(PER_RESULT\\)"));
  assert.deepEqual(await runs(), [], "nothing sent to monid");
  assert.deepEqual((await api("GET", "/runs")).body.runs, [], "no run, nothing booked");
});

test("(b) an endpoint priced by usage is refused at the save as a named grant, and left out of a provider's wildcard with the reason; a wildcard left with none is refused", async (t) => {
  withEnv(t, { MONID_API_KEY: KEY });
  const { api, store } = await serve(t, { fauxMonid: FAUX_MONID });
  // Named: refused at its grant, in words naming it and why; nothing saved.
  const named = await api("POST", "/agents", agent("usage-named", { tools: ["monid:faux/person/enrich", "monid:apollo/news_articles/search"] }));
  assert.equal(named.status, 422, JSON.stringify(named.body));
  const [issue, ...more] = named.body.error?.fields ?? [];
  assert.deepEqual(more, [], JSON.stringify(named.body));
  assert.equal(issue?.field, "definition.tools[1]", JSON.stringify(issue));
  assert.match(issue.message, UNBOUNDED("monid:apollo/news_articles/search", "per result \\(PER_RESULT\\)"));
  assert.equal((await api("GET", "/agents/usage-named")).status, 404, "nothing saved");
  // A wildcard: saved without it, the save's warnings naming it and why, at the wildcard's grant.
  const wild = await api("POST", "/agents", agent("usage-wild", { tools: ["monid:apollo/*"] }));
  assert.equal(wild.status, 201, JSON.stringify(wild.body));
  assert.deepEqual(Object.keys(await pinOf(store, "usage-wild")), ["monid:apollo/people/match"], "the endpoint priced by usage is not pinned");
  const left = (wild.body.warnings ?? []).filter((warning) => /monid:apollo\/news_articles\/search/.test(warning.message));
  assert.equal(left.length, 1, JSON.stringify(wild.body.warnings));
  assert.equal(left[0].field, "definition.tools[0]");
  assert.match(left[0].message, /^monid:apollo\/news_articles\/search is left out of monid:apollo\/\*: /);
  assert.match(left[0].message, UNBOUNDED("monid:apollo/news_articles/search", "per result \\(PER_RESULT\\)"));
  // A wildcard of a provider whose every endpoint is priced by usage pins nothing: refused, naming each.
  const none = await api("POST", "/agents", agent("usage-none", { tools: ["monid:metered/*"] }));
  assert.equal(none.status, 422, JSON.stringify(none.body));
  assert.match(JSON.stringify(none.body), /every endpoint monid lists of metered is priced by usage/);
  assert.match(JSON.stringify(none.body), UNBOUNDED("monid:metered/rows", "per 1 credit \\(PER_UNIT\\)"));
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
    assert.match(issue.message, /^The monid endpoint monid:tagger\/tag cannot be offered on codex: \/properties\/body\/patternProperties: patternProperties is not supported by Codex/, issue.message);
  }
  assert.equal((await api("GET", "/agents/tagger-codex")).status, 404, "nothing saved");
  const pi = await api("POST", "/agents", agent("tagger-pi", { tools: ["monid:tagger/*"] }));
  assert.equal(pi.status, 201, JSON.stringify(pi.body));
  assert.deepEqual(Object.keys(await pinOf(store, "tagger-pi")), ["monid:tagger/tag"]);
});
