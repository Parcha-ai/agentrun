// A run graded wrong with words on a server whose runs claim an Archil disk (Mode 2): the round's correction is what every
// learning read sees. The hand-typed correction, the round's merge, the corrections read and the run's diff read are one
// agent's learning, never a folder on the disk the reads miss (a Mode 2 round once merged on the disk alone: the run read
// "Kept your correction." while the corrections read lacked it and the diff read was 404). Over the fake control plane and
// the fake disk: nothing leaves this process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { saveArchilSettings } from "../dist/archil-settings.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { ended, LEARN, learner, made, started } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const HAND = "Hand: always answer in English.";
const LABEL = "Review: the answer is 42, said as a number.";
/** The fake control plane's account key. */
const FAKE_KEY = "fake-archil-account-key-0001";

test("Mode 2: a wrong grade's correction is in the corrections read and the run's diff, beside the hand-typed one", async (t) => {
  withEnv(t, { ARCHIL_API_KEY: FAKE_KEY }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const control = archilControlFetch({ region: "aws-us-east-1" });
  const disks = new Map();
  const makeDisk = (options) => disks.get(options.disk) ?? disks.set(options.disk, Object.assign(new FakeArchilDisk(), { id: options.disk })).get(options.disk);
  const fakes = { baseUrl: control.baseUrl, fetch: control.fetch };
  const { api, store } = await serve(t, { learning: "on", faux: LEARN, archil: { makeDisk, control: fakes }, archilControl: { ...fakes, makeDisk } });
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  await made(api, learner("graded-on-disk"));

  const read = await api("GET", "/agents/graded-on-disk/learning/corrections");
  const hand = await api("PUT", "/agents/graded-on-disk/learning/corrections", { text: `${HAND}\n` }, { "if-match": read.headers.get("etag") });
  assert.equal(hand.status, 200, JSON.stringify(hand.body));
  const run = await started(api, "graded-on-disk", "What is 6 times 7?");
  await ended(api, run);
  const graded = await api("PUT", `/runs/${run}/grade`, { correct: false, label: LABEL });
  assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
  await ended(api, run);
  assert.equal(disks.size, 1, "the run claimed its agent's disk: the server is in Mode 2");

  const corrections = await api("GET", "/agents/graded-on-disk/learning/corrections");
  assert.deepEqual([corrections.status, corrections.body.text], [200, `${HAND}\n- ${LABEL}\n`], "both corrections, the hand-typed one first");
  const learning = (await api("GET", `/runs/${run}/learning`)).body;
  assert.deepEqual([learning.state, learning.corrections, learning.graded?.feedback], ["merged", 1, "correction"], JSON.stringify(learning));
  const diff = await api("GET", `/runs/${run}/learning/diff`);
  assert.equal(diff.status, 200, `the run's diff reads: ${JSON.stringify(diff.body)}`);
  assert.equal(diff.body.head, learning.merged, "the diff is the run's merge");
  assert.deepEqual(diff.body.files.map(({ path, status }) => [path, status]), [["corrections.md", "modified"]]);
  assert.match(diff.body.files[0].patch, new RegExp(`^\\+- ${LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "the round's line added");
});
