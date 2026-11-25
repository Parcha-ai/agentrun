// A Mode 2 run's MCP files its answers in the run's own files, on its Archil disk, never in a folder of this machine.
// Every place a claim makes its MCP is tested: pi's spec (adapter-run-spec.ts), the CLI spec (cli-run-spec.ts), and a
// run's own process, whose MCP is its runner's (run-child-host.ts heldFor). Where the run's computer mounts the folder,
// its mount holds the disk's write delegation and a write over the disk's file API is refused (409): the gateway files
// through the computer then, and a fal job's result is filed at evidence/fal/<request_id>.json (the attached Workspace
// makes a file without the chance of replacing one). Where nothing mounts the folder, the gateway files over the disk's
// file API, and a fal result is filed nowhere: that Workspace has no writeNew until Parcha-ai/agentrun#3777. An answer too
// long for the model is filed whole at evidence/mcp in both. The answer the model reads is fal's, byte for byte.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { bookedIn } = await import("../dist/paid-calls.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { toolLedger } = await import("./support.mjs");

const SEAL_KEY = Buffer.alloc(32, 7);
const TOKEN = `not-a-secret-${"mode2-mcp-evidence-bearer"}`;
const WAIT = { name: "wait_for_jobs", description: "Wait for fal jobs.", inputSchema: { type: "object", properties: {} } };
const GRANTS = ["mcp:fal/wait_for_jobs"];
const PIN = (url) => ({ fal: { url, tools: [WAIT], meter: "fal" } });
const ID = "01a1fb43-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const RESULT = { audio: { url: "https://v3.fal.media/files/voice.mp3", content_type: "audio/mpeg" }, timestamps: [{ text: "Hi ", start: 0.1, end: 0.4 }] };
const JOB = { all_terminal: true, jobs: [{ index: 0, endpoint_id: "fal-ai/elevenlabs/tts/eleven-v3", request_id: ID, status: "completed", terminal: true, queue_status: "COMPLETED", result: RESULT }] };
/** An answer past the gateway's clip (MCP_CLIP, 60,000 characters), in lines. */
const LONG = Array.from({ length: 2_000 }, (_, i) => `line ${i} of a long fal answer`).join("\n");

/** A fake fal MCP whose wait_for_jobs answers `answers` in turn: the first a completed job as text, the next past the
 *  gateway's clip (which it files whole at evidence/mcp/fal/). */
async function fakeFal(t) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const answers = [
    { content: [{ type: "text", text: JSON.stringify(JOB) }] },
    { content: [{ type: "text", text: LONG }] },
  ];
  fake.tools.wait_for_jobs = { description: WAIT.description, input: WAIT.inputSchema, run: () => answers.shift() };
  const register = (server) => server.mcp.put({ name: "fal", url: fake.url, auth: "bearer", tools: [{ name: WAIT.name, description: WAIT.description, input_schema: WAIT.inputSchema }], sealed: sealMcpCredential(SEAL_KEY, "fal", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  return { fake, register };
}

/** Both calls through `tool` (the claim's wait_for_jobs, as a harness calls it), each on the run's ledger. */
async function callTwice(tool) {
  const paid = await toolLedger(5);
  const call = (id) => bookedIn({ call: id, paid }, () => tool.call({}, { callId: id, signal: new AbortController().signal, attempt: 0 }));
  return [await call("c1"), await call("c2")];
}

/** What both answers say, and nothing in this machine's folder for the run. */
function assertAnswered({ data, agentId, runId, first, second }) {
  assert.equal(first.isError, undefined, first.text);
  assert.equal(first.text, JSON.stringify(JOB), "the model reads fal's answer byte for byte");
  assert.match(second.text, /the whole answer is in the run's files at evidence\/mcp\/fal\//);
  const local = runFolder(data, agentId, runId);
  assert.equal(existsSync(join(local, "evidence")), false, `nothing is filed in this machine's folder for the run (${local})`);
}

/** Filed through the computer that mounts the run's folder (`scratch`, its /workspace): no write refused by the mount's
 *  delegation, the whole long answer at evidence/mcp, fal's result at evidence/fal/<request_id>.json. */
function assertFiledThroughTheComputer({ scratch, disk, ...answered }) {
  assertAnswered(answered);
  assert.deepEqual(disk.refusedByDelegation, [], "nothing is written over the disk's file API while the computer's mount holds it");
  const mcp = readdirSync(join(scratch, "evidence", "mcp", "fal"));
  assert.equal(mcp.length, 1, JSON.stringify(mcp));
  assert.equal(readFileSync(join(scratch, "evidence", "mcp", "fal", mcp[0]), "utf8"), LONG, "the whole answer");
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "evidence", "fal", `${ID}.json`), "utf8")), RESULT, "fal's completed result, filed");
}

/** Filed over the disk's file API (no computer mounts the folder): the long answer's put under the run's key, no fal
 *  result (no writeNew there, Parcha-ai/agentrun#3777). */
function assertFiledOverTheDisk({ disk, key, ...answered }) {
  assertAnswered(answered);
  const puts = disk.calls.filter((call) => call.op === "putObject").map((call) => call.key);
  assert.ok(puts.some((at) => at.startsWith(`${key}/evidence/mcp/fal/`)), `the whole answer is on the run's disk: ${JSON.stringify(puts)}`);
  assert.deepEqual(puts.filter((at) => at.includes("/evidence/fal/")), [], "no fal result on the disk: its Workspace has no writeNew (Parcha-ai/agentrun#3777)");
}

const MCP = (fake, register) => ({ grants: GRANTS, pin: PIN(fake.url), before: register, deps: { mcpLoopback: true } });

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`Mode 2, ${name}, its computer mounting the run's folder: the MCP files through the computer, a fal result at evidence/fal, nothing in this machine's folder`, { timeout: 120_000 }, async (t) => {
    const { fake, register } = await fakeFal(t);
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, mcp: MCP(fake, register) });
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 1, "the run's computer mounts its folder");
    const tool = spec.mcp.tools.find((one) => spec.mcp.catalogOf(one.name) === "mcp:fal/wait_for_jobs");
    assert.ok(tool, "the run's wait_for_jobs");
    const [first, second] = await callTwice(tool);
    assertFiledThroughTheComputer({ data: run.data, agentId: AGENT, runId: RUN, scratch: run.scratch, disk, first, second });
  });
}

test("Mode 2, a run's own process (its runner's MCP, heldFor), its computer mounting the run's folder: the same, through the computer", { timeout: 120_000 }, async (t) => {
  const { fake, register } = await fakeFal(t);
  const disk = new FakeArchilDisk();
  const run = await mode2Run(t, { disk, mcp: MCP(fake, register) });
  const revision = { kind: "agentic", body: { instructions: "Answer.", tools: ["read", "write", ...GRANTS], computer: { kind: "sandbox", provider: "e2b" } }, mcpPin: PIN(fake.url) };
  const reads = { claim: { runId: RUN, epoch: 1 }, run: { agentId: AGENT, revisionId: "rev-1", signInHanded: null }, launch: { input: { content: "Do the thing." } }, revision, claimed: {} };
  const side = host.heldFor(run.deps, reads, (text) => text, () => {});
  t.after(() => side.release());
  const mcp = await side.held.mcp({ appendRoot: async () => {} });
  const got = await side.held.computer({ hadComputer: async () => false });
  assert.equal(got?.computer?.kind, "sandbox", "the runner made the run's computer");
  assert.equal(run.mounts.length, 1, "it mounts the run's folder");
  const tool = mcp?.tools.find((one) => one.catalog === "mcp:fal/wait_for_jobs");
  assert.ok(tool, "the run's wait_for_jobs");
  const [first, second] = await callTwice(tool);
  assertFiledThroughTheComputer({ data: run.data, agentId: AGENT, runId: RUN, scratch: run.scratch, disk, first, second });
});

test("Mode 2, a run's own process (its runner's MCP, heldFor), no computer: the MCP files over the disk's file API, no fal result (#3777), nothing in this machine's folder", { timeout: 120_000 }, async (t) => {
  const { fake, register } = await fakeFal(t);
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mode2-mcp-evidence-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const DISK = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
  await saveArchilSettings(store, DISK);
  await storeAgentDisk(store, "agent-own", { diskId: DISK.diskId });
  await store.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await register(store);
  const revision = { kind: "agentic", body: { instructions: "Answer.", tools: GRANTS }, mcpPin: PIN(fake.url) };
  await store.agents.create({ id: "agent-own", name: "Own" }, { id: "rev-own", ...revision });
  await store.runs.create({ id: "run-own", agentId: "agent-own", revisionId: "rev-own" });
  const disk = new FakeArchilDisk();
  const control = archilControlFetch();
  const deps = { store, sealKey: SEAL_KEY, env: {}, data, mcpLoopback: true, makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch } };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision, claimed: {} };
  const side = host.heldFor(deps, reads, (text) => text, () => {});
  t.after(() => side.release());
  const mcp = await side.held.mcp({ appendRoot: async () => {} });
  const tool = mcp?.tools.find((one) => one.catalog === "mcp:fal/wait_for_jobs");
  assert.ok(tool, "the run's wait_for_jobs");
  const [first, second] = await callTwice(tool);
  assertFiledOverTheDisk({ data, agentId: "agent-own", runId: "run-own", disk, key: runKey("agent-own", "run-own"), first, second });
});
