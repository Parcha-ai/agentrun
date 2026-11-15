// A backend callback's Monid-shaped name does not grant managed metadata reads or create a managed revision pin.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";
import { KEY } from "./fixtures/faux-monid.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const TOOLS = ["monid:apollo/*", "monid:faux/person/enrich"];
const CALLBACK = "monid:apollo/news_articles/search";

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  test(`${runtime} keeps Monid-shaped callbacks outside managed metadata and nullable revision pins`, { timeout: 60_000 }, async (t) => {
    const log = join(await scratch(t), "monid-calls.ndjson");
    withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
    const server = await serve(t, { fauxMonid: FAUX_MONID }), { api, store } = server;
    const calls = async () => {
      const text = await readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    };
    const baseline = await calls(), id = `sdk-monid-${runtime}`;
    const unchanged = async () => assert.deepEqual(await calls(), baseline, "SDK metadata and evidence do not call managed Monid");
    const unpinned = async () => {
      const revisions = await store.agents.revisions(id);
      assert.ok(revisions.length > 0);
      for (const revision of revisions) {
        assert.equal(revision.monidPin, null, "SDK revisions never receive managed Monid pins");
        assert.ok(!Object.hasOwn(revision.body, "monidPin"), "managed pins do not belong in a definition body");
      }
    };

    const created = await api("POST", "/agents", {
      definition: { id, name: id, instructions: "Keep the backend's callback ownership.", sdk: { runtime }, learning: false, tools: TOOLS },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await unchanged(); await unpinned();
    const edited = await api("PUT", `/agents/${id}/definition`, {
      definition: { instructions: "Edited backend policy.", tools: TOOLS },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.definition.sdk, { runtime });
    assert.deepEqual(edited.body.definition.tools, TOOLS);
    await unchanged(); await unpinned();

    const ordinary = await api("POST", `/agents/${id}/runs`, { input: { content: "Do not dispatch a managed task." } });
    assert.equal(ordinary.status, 409, JSON.stringify(ordinary.body));
    assert.match(ordinary.body.error.message, /backend SDK/);
    const inline = await api("POST", "/runs", {
      external: { source: "fixture", kind: "sdk", id, version: "1" },
      definition: { name: id, instructions: "Keep backend callback ownership.", sdk: { runtime }, learning: false, tools: TOOLS },
      input: { content: "Do not dispatch an inline managed task." },
    });
    assert.equal(inline.status, 409, JSON.stringify(inline.body));
    assert.match(inline.body.error.message, /backend SDK/);
    assert.deepEqual((await api("GET", `/agents/${id}/runs`)).body.runs, []);
    assert.equal((await api("GET", "/agents")).body.agents.length, 1, "a refused inline start creates no agent");
    await unchanged(); await unpinned();

    const started = await api("POST", `/agents/${id}/sdk-runs`, {
      runtime, input: "Read the backend's prepared result.", instructions: "Use the application's own callback.", model: "backend-fixture",
    }, { "Idempotency-Key": "backend-monid" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await unchanged(); await unpinned();
    const receipt = started.body, sdk = client(server.baseUrl, receipt.token), path = `/sdk-runs/${receipt.run_id}`;
    let callbacks = 0;
    const search = () => { callbacks++; return { title: "Backend result" }; };
    const result = search();
    assert.equal((await sdk("POST", `${path}/events`, { sequence: 1, events: [
      { type: "tool", id: "backend-search", name: CALLBACK, status: "started", input: { query: "fixture" } },
      { type: "tool", id: "backend-search", name: CALLBACK, status: "completed", output: result },
    ] })).status, 200);
    await unchanged();
    assert.equal((await sdk("POST", `${path}/complete`, { status: "completed", answer: result.title })).status, 200);
    await follow(api, receipt.run_id, ["completed"]);
    const run = (await api("GET", `/runs/${receipt.run_id}`)).body;
    assert.equal(callbacks, 1);
    assert.equal(run.result.final_answer, result.title);
    assert.equal(run.sdk.runtime, runtime);
    assert.equal((await store.runs.launch(receipt.run_id)).body.harness, "sdk");
    await unchanged(); await unpinned();

    // The same fake boundary must be live for a managed save, including the current usage-priced null pin.
    const managedId = `managed-monid-${runtime}`;
    const managed = await api("POST", "/agents", agent(managedId, { tools: TOOLS }));
    assert.equal(managed.status, 201, JSON.stringify(managed.body));
    const metadata = (await calls()).slice(baseline.length);
    assert.ok(metadata.some(call => call.path === "/v1/endpoints"), "managed wildcard grants read the listing");
    assert.ok(metadata.some(call => call.path === "/v1/inspect" && call.endpoint === "/news_articles/search"), "managed usage-priced grants are inspected");
    assert.ok(metadata.every(call => ["/v1/endpoints", "/v1/inspect"].includes(call.path)), "saving metadata executes no provider tool");
    const revision = (await store.agents.revisions(managedId)).at(-1);
    assert.equal(revision.monidPin[CALLBACK].usd, null, "usage pricing stays unknown, not zero or a fabricated fixed price");
    assert.equal(revision.monidPin["monid:faux/person/enrich"].usd, 0.003);
    assert.ok(!Object.hasOwn(revision.body, "monidPin"));
    assert.ok(managed.body.warnings.some(warning => warning.reason === "priced_by_usage" && warning.message.includes(CALLBACK)));
    assert.doesNotMatch(JSON.stringify(managed.body), /monidPin|monid_pin/, "the managed revision pin remains internal");
    await unpinned();
  });
}
