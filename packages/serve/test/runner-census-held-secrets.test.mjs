// A runner's census (runner/main.ts runnerCensus) reads a Mode 2 run's files with the Archil account key the runner was
// started with. The launcher holds its secrets off the runner's environment (secrets.ts), so the census reads them by
// name, as the server's file routes do: given the environment alone, it finds no key, and every Mode 2 end writes
// "unscanned". With no launcher (this test's process), a secret the process holds is read from process.env, so the key
// set there and an `env` without it stand for a launcher's runner. Over a real store and the Archil fake; nothing leaves
// this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { pathMac, runCensus } from "../dist/run-census.js";
import { runnerCensus } from "../dist/runner/main.js";
import { sealRunLaunch } from "../dist/store/seal.js";
import { runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const HELD_KEY = "fake-held-archil-account-key-census";
const TOOL_KEY = "fake-census-held-tool-value-0123456789";
const SETTINGS = { region: "aws-us-east-1", s3Url: "https://s3.archil.example" };
const DISK = "dsk-0000000000000fa1";

/** A Mode 2 store (its settings saved, agent-1 on its own disk, no account key saved) with run-1 handed TOOL_KEY, whose
 *  folder holds a file that names it; the Archil fake as its disk, each disk made recorded in `made`. */
async function mode2Run(t) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await saveArchilSettings(store, SETTINGS);
  await storeAgentDisk(store, "agent-1", { diskId: DISK });
  const sealKey = randomBytes(32);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed: sealRunLaunch(sealKey, "run-1", { keys: { TOOL_KEY } }) });
  const disk = new FakeArchilDisk();
  const root = runKey("agent-1", "run-1");
  disk.dirs.add(root);
  disk.files.set(`${root}/notes.md`, Buffer.from(`key ${TOOL_KEY} end\n`));
  const made = [];
  const makeDisk = (given) => {
    made.push(given);
    return disk;
  };
  return { store, dir, sealKey, made, makeDisk };
}

/** The account key held by the process, as a launcher's runner holds it, for the test's length. */
function holdKey(t) {
  const before = process.env.ARCHIL_API_KEY;
  process.env.ARCHIL_API_KEY = HELD_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.ARCHIL_API_KEY;
    else process.env.ARCHIL_API_KEY = before;
  });
}

test("a runner's census of a Mode 2 run opens its disk with the held Archil key, absent from the environment it was given", async (t) => {
  const { store, dir, sealKey, made, makeDisk } = await mode2Run(t);
  holdKey(t);
  const env = { AGENTRUN_ARCHIL_REGION: SETTINGS.region, AGENTRUN_ARCHIL_S3_URL: SETTINGS.s3Url };

  // The environment alone, as the runner's start gave it before: no key, none saved, so the census fails UNAVAILABLE.
  await assert.rejects(runCensus(store, { data: dir, sealKey, env, makeDisk })("run-1"), (error) => error.code === "UNAVAILABLE");
  assert.deepEqual(made, [], "no disk made without the key");

  const counted = await runnerCensus(store, dir, sealKey, env, makeDisk)("run-1");
  assert.ok(counted, "a census was made");
  assert.deepEqual(made.map((one) => [one.disk, one.key()]), [[DISK, HELD_KEY]], "the run's disk, with the held key");
  const census = JSON.parse(counted.json);
  const entry = census.files[pathMac(sealKey, "notes.md")];
  assert.ok(entry, `notes.md counted: ${counted.json}`);
  const at = Buffer.byteLength("key ");
  assert.deepEqual(entry.cut, [[at, at + Buffer.byteLength(TOOL_KEY)]], "the handed key's bytes, cut in place");
  assert.equal(counted.json.includes(TOOL_KEY) || counted.json.includes(HELD_KEY), false, "no secret in the census");
  assert.equal(census.partial, undefined);
});
