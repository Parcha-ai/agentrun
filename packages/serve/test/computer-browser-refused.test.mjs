// A Browser computer (Browserbase, Kernel) is refused on this server for now, in one set of words (computer-setting.ts
// BROWSER_COMPUTER_REFUSED): nothing here wires its CDP connection into a run, so a run of one would only fail at its
// start. So an agent's save that names one is 422; a run of an agent saved with one before is refused at its start (409,
// agent_not_runnable), before any run is made; and GET /v2/computers shows the browser kind not offered and its providers
// not ready, in those words. A sandbox or a desktop is untouched. The real server path, on the computer package's own
// registry (no --faux computers): the agent through POST /v2/agents, its run through POST /v2/agents/{id}/runs. A fake
// `docker` first on PATH keeps the server's start-time probe off any real Docker. No provider is called.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, SECRET_WRITE_PATHS, serve, withEnv } from "./support.mjs";

// A computer key's save is a secret write: the client sends it from the owner's session.
SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/computers\/[^/]+\/keys$/ });

const { BROWSER_COMPUTER_REFUSED, computerIssues } = await import("../dist/computer-setting.js");
const { computerReadiness, claimKinds } = await import("../dist/workspace/index.js");

const WORDS = "Browser computers don't run on this server yet: use the browser tool (Settings → Tools) for web browsing.";
const BROWSERS = [{ kind: "browser", provider: "browserbase" }, { kind: "browser", provider: "kernel" }];

/** A server alone on the real computer registry, with a seal key and a fake `docker` that does not answer. */
async function server(t) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi\nexit 0\n");
  await chmod(join(bin, "docker"), 0o755);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: `${bin}:${process.env.PATH}` }, ["AGENTRUN_BOXES", "E2B_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "ARCHIL_API_KEY"]);
  return serve(t, { faux: undefined, runner: false, accounts: true, openSetup: true });
}

const definition = (id, computer) => ({ definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools: [], ...(computer ? { computer } : {}) } });
/** A refusal's fields on the agent's computer, as [reason, message]. */
const onComputer = (body) => (body?.error?.fields ?? []).filter((one) => one.field === "definition.computer").map((one) => [one.reason, one.message]);

test("the words name the browser tool where Settings keeps it", () => {
  assert.equal(BROWSER_COMPUTER_REFUSED, WORDS);
});

test("an agent's save that names a Browser computer (Browserbase or Kernel) is refused, 422 in the words, and nothing is saved; an edit to one is refused alike", async (t) => {
  const { api } = await server(t);
  for (const computer of [...BROWSERS, { kind: "browser" }]) {
    const made = await api("POST", "/agents", definition("browsing", computer));
    assert.equal(made.status, 422, JSON.stringify(made.body));
    assert.equal(made.body.error.code, "input_invalid");
    assert.deepEqual(onComputer(made.body), [["not_an_option", WORDS]], JSON.stringify(made.body));
  }
  assert.equal((await api("GET", "/agents/browsing")).status, 404, "nothing is saved");

  const plain = await api("POST", "/agents", definition("plain", { kind: "none" }));
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  const edit = await api("PUT", "/agents/plain/definition", { definition: { name: "plain", instructions: "Answer.", tools: [], computer: BROWSERS[0] } });
  assert.equal(edit.status, 422, JSON.stringify(edit.body));
  assert.deepEqual(onComputer(edit.body), [["not_an_option", WORDS]]);
  assert.deepEqual((await api("GET", "/agents/plain")).body.definition.computer, { kind: "none" }, "the agent keeps its computer");
});

test("an agent saved with a Browser computer before the refusal: its run is refused at its start, 409 in the words, and no run is made", async (t) => {
  const served = await server(t);
  const { api, store } = served;
  for (const [index, computer] of BROWSERS.entries()) {
    const id = `old-browser-${index}`;
    assert.equal((await api("POST", "/agents", definition(id, { kind: "none" }))).status, 201);
    // A revision as a save before this one kept it: written to the store, past the save's check.
    const current = await store.agents.revision((await store.agents.get(id)).currentRevision);
    await store.agents.addRevision({ agentId: id, id: `${id}-rev`, kind: "agentic", body: { ...current.body, computer, place: { mode: "runner" } } });
    assert.deepEqual((await api("GET", `/agents/${id}`)).body.definition.computer, computer, "the agent reads as saved with it");

    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } });
    assert.equal(started.status, 409, JSON.stringify(started.body));
    assert.equal(started.body.error.code, "agent_not_runnable");
    assert.deepEqual(onComputer(started.body), [["not_set_up_here", WORDS]], JSON.stringify(started.body));
    assert.match(started.body.error.message, new RegExp(WORDS.replace(/[.()→]/g, "\\$&")));
    assert.deepEqual(await store.runs.list({ agentId: id }), [], "no run is made");
  }
});

test("GET /v2/computers: the browser kind is not offered and each of its providers is not ready, in the words; a sandbox's and a desktop's are not", async (t) => {
  const { api } = await server(t);
  const saved = await api("PUT", "/computers/browserbase/keys", { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.ready, saved.body.why], [false, WORDS], "its keys saved, it is still not ready");

  const listed = await api("GET", "/computers");
  assert.equal(listed.status, 200);
  const kind = (name) => listed.body.kinds.find((one) => one.kind === name);
  assert.deepEqual([kind("browser").offered, kind("browser").why], [false, WORDS]);
  assert.deepEqual(kind("browser").providers.map((one) => [one.id, one.ready, one.why]), [["browserbase", false, WORDS], ["kernel", false, WORDS]]);
  for (const other of ["none", "sandbox", "desktop", "phone"]) {
    assert.notEqual(kind(other).why, WORDS, other);
    assert.ok(kind(other).providers.every((one) => one.why !== WORDS), other);
  }
  assert.equal(kind("desktop").offered, true);
  assert.ok(!(await api("GET", "/capabilities")).body.features.computers.kinds.includes("browser"), "capabilities offers no browser computer");
});

test("a sandbox or a desktop computer is unaffected: saved with no refusal of the words, and its run's start is not refused in them", async (t) => {
  const { api } = await server(t);
  assert.equal((await api("PUT", "/computers/e2b/keys", { E2B_API_KEY: "fake-test-key" })).status, 200);
  for (const [id, computer] of [["desk", { kind: "desktop", provider: "e2b" }], ["sandbox", { kind: "sandbox", provider: "docker" }]]) {
    const made = await api("POST", "/agents", definition(id, computer));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok((made.body.warnings ?? []).every((one) => one.message !== WORDS), JSON.stringify(made.body));
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } });
    assert.doesNotMatch(JSON.stringify(started.body), /Browser computers don't run/, JSON.stringify(started.body));
  }
  // The checks themselves, on the computer package's registry: shape issues only for these, and the readiness never in the words.
  for (const computer of [{ kind: "sandbox", provider: "docker" }, { kind: "desktop", provider: "e2b" }, { kind: "none" }]) {
    assert.deepEqual(computerIssues(computer, "definition.computer"), []);
    const ready = await computerReadiness(computer, 1, claimKinds({}), async () => "fake-test-key", () => true);
    assert.ok(!("refused" in ready) || ready.refused !== WORDS, JSON.stringify(ready));
  }
  for (const computer of BROWSERS) assert.deepEqual(await computerReadiness(computer, 2, claimKinds({}), async () => "fake-test-key"), { refused: WORDS });
});
