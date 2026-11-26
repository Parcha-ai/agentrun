// The agent's own file setting on an MCP tool (`mcp:<server>/<tool>: {file: {folder, show}}` in its revision's tool
// settings) reaches the claim's gateway from every place a claim makes its MCP: pi's spec (adapter-run-spec.ts), the CLI
// spec (cli-run-spec.ts) and a run's own process, whose MCP is its runner's (run-child-host.ts heldFor), in Mode 2 (through
// the computer that mounts the run's folder, or over the disk's file API) and in Mode 1 (the run's folder here). Each
// answer is filed whole in the setting's folder of the run's files and the model reads only its summary; nothing lands in
// this machine's folder for a Mode 2 run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { AGENT, KEY as RUN_KEY, mode2Run, RUN } from "./fixtures/mode2-mounted-run.mjs";
import { storeOn } from "./store-helpers.mjs";

const { sealMcpCredential } = await import("../dist/store/index.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const host = await import("../dist/runner/run-child-host.js");
const { runFolder, runKey, scratchFolder } = await import("../dist/workspace/paths.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

const SEAL_KEY = Buffer.alloc(32, 7);
const TOKEN = `not-a-secret-${"filed-results-claim-bearer"}`;
const LIST = { name: "list_transactions", description: "List balance transactions.", inputSchema: { type: "object", properties: {} } };
const GRANTS = ["mcp:stripe/list_transactions"];
const PIN = (url) => ({ stripe: { url, tools: [LIST] } });
const PAGE = JSON.stringify({ data: [{ id: "txn_1", description: "Track Day Pass for Marisol Quintero" }, { id: "txn_2", description: "Refund to Marisol Quintero" }], has_more: false });
const SETTINGS = { "mcp:stripe/list_transactions": { file: { folder: "stripe", show: ["has_more", "data.-1.id"] } } };
const SUMMARY = /^list_transactions answered \d+ bytes, filed whole at stripe\/(list_transactions-[^ ]+\.json) for the skill's code; its values are not shown here \(the agent's setting files this tool's answers\); only these are:\n\{"has_more": false, "data\.-1\.id": "txn_2"\}\nShape: \{"data": \[2 objects\], "has_more": boolean\}$/;

async function fakeStripe(t) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.list_transactions = { description: LIST.description, input: LIST.inputSchema, run: () => ({ content: [{ type: "text", text: PAGE }] }) };
  const register = (server) => server.mcp.put({ name: "stripe", url: fake.url, auth: "bearer", tools: [{ name: LIST.name, description: LIST.description, input_schema: LIST.inputSchema }], sealed: sealMcpCredential(SEAL_KEY, "stripe", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  return { fake, register };
}

/** The tool's answer, as a harness calls it: the summary, and the file it names. */
async function answered(tool) {
  const result = await tool.call({}, { callId: "c1", signal: new AbortController().signal, attempt: 0 });
  assert.equal(result.isError, undefined, result.text);
  const match = SUMMARY.exec(result.text);
  assert.ok(match, `the summary alone: ${result.text}`);
  assert.ok(!result.text.includes("Marisol"), result.text);
  return match[1];
}

/** Nothing in the runner's own folder for a Mode 2 run. */
function nothingHere(data, agentId, runId) {
  mkdirSync(runFolder(data, agentId, runId), { recursive: true, mode: 0o700 });
  return () => assert.deepEqual(readdirSync(runFolder(data, agentId, runId)), [], "nothing filed in this machine's folder for the run");
}

const MCP = (fake, register) => ({ grants: GRANTS, pin: PIN(fake.url), toolSettings: SETTINGS, before: register, deps: { mcpLoopback: true } });
const toolOf = (spec) => spec.mcp.tools.find((one) => spec.mcp.catalogOf(one.name) === GRANTS[0]);

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`Mode 2, ${name}, its computer mounting the run's folder: the setting files the answer through the computer, the model reads the summary`, { timeout: 120_000 }, async (t) => {
    const { fake, register } = await fakeStripe(t);
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, mcp: MCP(fake, register) });
    const empty = nothingHere(run.data, AGENT, RUN);
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 1, "the run's computer mounts its folder");
    const file = await answered(toolOf(spec));
    assert.equal(readFileSync(join(run.scratch, "stripe", file), "utf8"), PAGE, "the whole answer, in the run's files");
    assert.deepEqual(disk.refusedByDelegation, []);
    empty();
  });

  test(`Mode 2, ${name}, no computer: the setting files the answer over the disk's file API, the model reads the summary`, { timeout: 120_000 }, async (t) => {
    const { fake, register } = await fakeStripe(t);
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, mcp: MCP(fake, register), computer: false });
    const empty = nothingHere(run.data, AGENT, RUN);
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 0);
    const file = await answered(toolOf(spec));
    const puts = disk.calls.filter((call) => call.op === "putObject").map((call) => call.key);
    assert.ok(puts.includes(`${RUN_KEY}/stripe/${file}`), `on the run's disk: ${JSON.stringify(puts)}`);
    empty();
  });
}

// A CLI works in the run's scratch folder on this machine, which its file tools take as another name of the run's folder
// (cli-run-spec.ts: runTools' aliases). The run's gate holds the filed folder by every name those tools resolve into
// the run's files, so the CLI's own path to it is refused too; a sibling by that path is not.
for (const computer of [true, false]) {
  test(`the CLI spec, Mode 2 ${computer ? "with" : "with no"} computer: a read of the filed folder by the scratch folder's path is refused in the setting's words, a sibling by that path is not`, { timeout: 120_000 }, async (t) => {
    const { fake, register } = await fakeStripe(t);
    const run = await mode2Run(t, { harness: "opencode", disk: new FakeArchilDisk(), mcp: MCP(fake, register), computer });
    const { spec } = await run.claimNext(cliRunSpecFromLaunch);
    const scratch = scratchFolder(run.data, AGENT, RUN);
    const gate = (path, i) => spec.gate({ callId: `r${i}`, tool: "read", args: { path } });
    for (const [i, given] of [`${scratch}/stripe/list_transactions-1.json`, `${scratch}/stripe`, `${scratch}/notes/../stripe/a.json`].entries()) {
      const said = await gate(given, i);
      assert.equal(typeof said, "object", `${given}: ${JSON.stringify(said)}`);
      assert.ok(said.deny.startsWith(`read can't be called: ${given} is in stripe/, the folder this agent's setting for ${GRANTS[0]} files that tool's answers in (its file setting)`), said.deny);
    }
    const plain = await gate("notes.md", 10);
    assert.equal(typeof plain, "string", JSON.stringify(plain));
    for (const [i, given] of [`${scratch}/notes.md`, `${scratch}/stripes/a.json`].entries()) assert.equal(await gate(given, 20 + i), plain, `${given}: as any other file of the run's`);
    assert.deepEqual(fake.log.filter((entry) => entry.method === "tools/call"), [], "nothing was called");
  });
}

test("a run's own process (its runner's MCP, heldFor), Mode 2 with no computer and Mode 1: the runner reads the revision's setting, files the answer, and the model reads the summary", { timeout: 120_000 }, async (t) => {
  for (const mode of [2, 1]) {
    const { fake, register } = await fakeStripe(t);
    const { store } = await storeOn(t);
    const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `mode${mode}-filed-results-`));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    const disk = new FakeArchilDisk();
    let deps = { store, sealKey: SEAL_KEY, env: {}, data, mcpLoopback: true };
    if (mode === 2) {
      const DISK = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
      await saveArchilSettings(store, DISK);
      await storeAgentDisk(store, "agent-own", { diskId: DISK.diskId });
      await store.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
      const control = archilControlFetch();
      deps = { ...deps, makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } };
    }
    await register(store);
    const revision = { kind: "agentic", body: { instructions: "Answer.", tools: GRANTS, toolSettings: SETTINGS }, mcpPin: PIN(fake.url) };
    await store.agents.create({ id: "agent-own", name: "Own" }, { id: "rev-own", ...revision });
    await store.runs.create({ id: "run-own", agentId: "agent-own", revisionId: "rev-own" });
    const empty = nothingHere(data, "agent-own", "run-own");
    const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision, claimed: {} };
    const side = host.heldFor(deps, reads, (text) => text, () => {});
    t.after(() => side.release());
    const mcp = await side.held.mcp({ appendRoot: async () => {} });
    const tool = mcp?.tools.find((one) => one.catalog === GRANTS[0]);
    assert.ok(tool, `mode ${mode}: the run's list_transactions`);
    const file = await answered(tool);
    if (mode === 2) {
      const puts = disk.calls.filter((call) => call.op === "putObject").map((call) => call.key);
      assert.ok(puts.includes(`${runKey("agent-own", "run-own")}/stripe/${file}`), `on the run's disk: ${JSON.stringify(puts)}`);
      empty();
    } else {
      assert.equal(readFileSync(join(runFolder(data, "agent-own", "run-own"), "stripe", file), "utf8"), PAGE, "the whole answer, in the run's folder");
    }
  }
});

test("a revision whose stored file setting no longer reads (a folder of ../x): the runner refuses every call of the tool, naming the setting, and the server logs no call", { timeout: 120_000 }, async (t) => {
  const { fake, register } = await fakeStripe(t);
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mode1-unreadable-file-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await register(store);
  const broken = { "mcp:stripe/list_transactions": { file: { folder: "../x", show: ["has_more"] } } };
  const revision = { kind: "agentic", body: { instructions: "Answer.", tools: GRANTS, toolSettings: broken }, mcpPin: PIN(fake.url) };
  await store.agents.create({ id: "agent-own", name: "Own" }, { id: "rev-own", ...revision });
  await store.runs.create({ id: "run-own", agentId: "agent-own", revisionId: "rev-own" });
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision, claimed: {} };
  const side = host.heldFor({ store, sealKey: SEAL_KEY, env: {}, data, mcpLoopback: true }, reads, (text) => text, () => {});
  t.after(() => side.release());
  const mcp = await side.held.mcp({ appendRoot: async () => {} });
  const tool = mcp?.tools.find((one) => one.catalog === GRANTS[0]);
  assert.ok(tool, "the run's list_transactions");
  const result = await tool.call({}, { callId: "c1", signal: new AbortController().signal, attempt: 0 });
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, /mcp:stripe\/list_transactions/);
  assert.match(result.text, /file setting/);
  assert.ok(!/Marisol|txn_/.test(result.text), result.text);
  assert.deepEqual(fake.log.filter((entry) => entry.method === "tools/call"), [], "no call reached the server");
});
