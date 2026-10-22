import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";
import { parseInbox, proposeLearning, renderInbox } from "../dist/index.js";
import { agentRepo, scratch } from "./support.mjs";

const CANDIDATES = [
  { callId: "call-1", type: "lesson", text: "Read the filing index.", evidence: ["run tool call 3"] },
  { callId: "call-2", type: "fact", text: "The index shows the SIC.", evidence: [] },
];
const SEED = "1".repeat(40);

test("one untrusted flag for the run renders as it always has, byte for byte", () => {
  assert.equal(renderInbox("run-7", CANDIDATES, { seed: SEED, untrusted: true }), "---\nrun: run-7\nseed: 1111111111111111111111111111111111111111\ncandidates: 2\n---\n# Run run-7 proposes 2 candidate(s) (untrusted)\n\n## 1. lesson\n\nRead the filing index.\n\nEvidence:\n- run tool call 3\n\n## 2. fact\n\nThe index shows the SIC.\n\n~~~json candidates\n[{\"callId\":\"call-1\",\"type\":\"lesson\",\"text\":\"Read the filing index.\",\"evidence\":[\"run tool call 3\"],\"untrusted\":true},{\"callId\":\"call-2\",\"type\":\"fact\",\"text\":\"The index shows the SIC.\",\"evidence\":[],\"untrusted\":true}]\n~~~\n");
  assert.equal(renderInbox("run-7", CANDIDATES, {}), renderInbox("run-7", CANDIDATES, { untrusted: false }));
  assert.equal(renderInbox("run-7", CANDIDATES, {}), "---\nrun: run-7\ncandidates: 2\n---\n# Run run-7 proposes 2 candidate(s)\n\n## 1. lesson\n\nRead the filing index.\n\nEvidence:\n- run tool call 3\n\n## 2. fact\n\nThe index shows the SIC.\n\n~~~json candidates\n[{\"callId\":\"call-1\",\"type\":\"lesson\",\"text\":\"Read the filing index.\",\"evidence\":[\"run tool call 3\"],\"untrusted\":false},{\"callId\":\"call-2\",\"type\":\"fact\",\"text\":\"The index shows the SIC.\",\"evidence\":[],\"untrusted\":false}]\n~~~\n");
  assert.equal(renderInbox("run-7", [], { untrusted: true }), "---\nrun: run-7\ncandidates: 0\n---\n# Run run-7 proposes 0 candidate(s) (untrusted)\n\n~~~json candidates\n[]\n~~~\n");
});

test("untrusted as a function marks each candidate on its own; the heading says when only some are", () => {
  const inbox = renderInbox("run-7", CANDIDATES, { untrusted: (c) => c.type === "lesson" });
  assert.match(inbox, /^# Run run-7 proposes 2 candidate\(s\) \(some untrusted\)$/m);
  assert.deepEqual(parseInbox(inbox).candidates.map((c) => [c.callId, c.untrusted]), [["call-1", true], ["call-2", false]]);
  assert.equal(renderInbox("run-7", CANDIDATES, { untrusted: () => true }), renderInbox("run-7", CANDIDATES, { untrusted: true }), "a function that marks all is the flag");
  assert.equal(renderInbox("run-7", CANDIDATES, { untrusted: () => false }), renderInbox("run-7", CANDIDATES, {}));
});

test("proposeLearning takes the function: the inbox it proposes carries each candidate's own mark, and the guard reads it as authored", async () => {
  const root = await scratch();
  const { bare } = await agentRepo(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote: local(bare) });
  const target = { snapshot: async (doc) => (doc.definition.kind === "learn.seed" ? undefined : { order: CANDIDATES.map((c) => c.callId), byCall: Object.fromEntries(CANDIDATES.map((c) => [c.callId, c])) }) };
  const result = await proposeLearning({ runId: "run-1", secrets: [], caseValues: [], repo, target, untrusted: (c) => c.callId !== "call-2" });
  assert.equal(result.status, "proposed", JSON.stringify(result));
  const inbox = parseInbox(await repo.read("inbox/run-1.md", result.sha));
  assert.deepEqual(inbox.candidates.map((c) => c.untrusted), [true, false]);
  // The guard still checks only what the model wrote: a case value in a text is refused whatever its mark.
  const refused = await proposeLearning({ runId: "run-2", secrets: [], caseValues: ["the index shows"], repo, target, untrusted: () => false });
  assert.equal(refused.status, "refused");
});
