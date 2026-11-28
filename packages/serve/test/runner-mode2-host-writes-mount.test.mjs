// A Mode 2 run whose computer mounts the run's folder: the mount holds the disk's write delegation, so a put over the
// disk's file API is refused (409) until the computer lets it go. What the run's non-hand tools write in the run's files
// (web_save's download, through the ToolHost) and a monid answer too long for the model go through the computer then, as
// the hands' writes and the MCP's files do, in both spec builders. With no computer, they go over the disk's file API.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KEY, mode2Run } from "./fixtures/mode2-mounted-run.mjs";

const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { CLIP, MONID_KEY_ENV } = await import("../dist/monid.js");
const { bookedIn } = await import("../dist/paid-calls.js");
const { toolLedger } = await import("./support.mjs");

const URL_CSV = "https://lists.example.org/sdn.csv";
const CSV = "name,program\nACME LTD,SDGT\n";
const WEB = {
  search: { answers: [], default: { results: [] } },
  fetch: { answers: [], default: { text: "" } },
  save: { answers: [{ url: URL_CSV, text: CSV, content_type: "text/csv" }] },
};
const BODY = { tools: ["read", "write", "web_save"] };
const ENRICH = "monid:faux/person/enrich";
const MONID = {
  revision: { monidPin: { [ENRICH]: { description: "faux /person/enrich: enrich a person.", input: { type: "object", properties: {} }, usd: 0.003 } } },
  env: { [MONID_KEY_ENV]: `not-a-secret-${"monid"}` },
  body: { tools: ["read", "write", ENRICH] },
};
const LONG = { status: "COMPLETED", output: { results: [{ slug: "widgets", note: `${"w".repeat(CLIP)}-the-end` }] } };

/** monid's API faked on fetch for the test (its price, then `answer` for every call); `off()` puts fetch back. */
function fakeMonid(t, answer) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    if (url.hostname !== "api.monid.ai") return original(input, init);
    return new Response(JSON.stringify(url.pathname === "/v1/inspect" ? { price: { type: "PER_CALL", amount: { value: 0.003, currency: "USD" } } } : answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => void (globalThis.fetch = original));
}

/** The monid endpoint called once on a run's ledger (a paid step, as the loop makes it): the path of the whole answer. */
async function enrich(spec) {
  const tools = [...spec.session.tools, ...(spec.mcp?.tools ?? [])];
  const tool = tools.find((one) => one.name === "monid__faux__person__enrich");
  assert.ok(tool, `the monid endpoint is the run's tool: ${tools.map((one) => one.name)}`);
  const paid = await toolLedger(1);
  const answer = await bookedIn({ call: "c-monid", paid }, () => tool.call({ body: { name: "Ada" } }, { callId: "c-monid", signal: new AbortController().signal }));
  const saved = /the whole answer is in the run's files at (evidence\/monid\/\S+\.json)\]$/.exec(answer.text)?.[1];
  assert.ok(saved, `the cut answer names where the whole is: ${answer.text.slice(-300)}`);
  return saved;
}

/** web_save of the list at lists/sdn.csv through the spec's own tool, its answer as the model reads it. */
async function save(spec) {
  const tool = spec.session.tools.find((one) => one.name === "web_save");
  assert.ok(tool, `the run has web_save: ${spec.session.tools.map((one) => one.name).join(", ")}`);
  const result = await tool.call({ url: URL_CSV, path: "lists/sdn.csv" }, { callId: "save-1", signal: new AbortController().signal });
  const text = typeof result === "string" ? result : result.text ?? result.content?.map((part) => part.text ?? "").join("");
  return JSON.parse(text);
}

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`Mode 2, ${name}, its computer mounting the run's folder: web_save saves through the computer, nothing refused by the mount's delegation`, { timeout: 120_000 }, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, body: BODY, deps: { evalFakes: () => ({ web: WEB }) } });
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 1, "the run's computer mounts its folder");
    const answer = await save(spec);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.path, "lists/sdn.csv");
    assert.deepEqual(disk.refusedByDelegation, [], "nothing is written over the disk's file API while the computer's mount holds it");
    assert.equal(readFileSync(join(run.scratch, "lists", "sdn.csv"), "utf8"), CSV, "the list is in the run's folder, through the computer");
  });

  test(`Mode 2, ${name}, no computer: web_save saves over the disk's file API`, { timeout: 120_000 }, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, body: BODY, computer: false, deps: { evalFakes: () => ({ web: WEB }) } });
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 0, "nothing mounts the run's folder");
    const answer = await save(spec);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const puts = disk.calls.filter((call) => call.op === "putObject").map((call) => call.key);
    assert.ok(puts.includes(`${KEY}/lists/sdn.csv`), `the list is put on the run's disk: ${JSON.stringify(puts)}`);
    assert.equal(existsSync(join(run.scratch, "lists")), false, "no computer folder holds it");
  });
}

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`Mode 2, ${name}, its computer mounting the run's folder: a monid answer too long for the model is filed through the computer`, { timeout: 120_000 }, async (t) => {
    fakeMonid(t, LONG);
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, ...MONID });
    const { spec } = await run.claimNext(build);
    assert.equal(run.mounts.length, 1, "the run's computer mounts its folder");
    const saved = await enrich(spec);
    assert.deepEqual(disk.refusedByDelegation, [], "nothing is written over the disk's file API while the computer's mount holds it");
    assert.equal(readFileSync(join(run.scratch, saved), "utf8"), JSON.stringify(LONG), "the whole answer is in the run's folder, through the computer");
  });
}
