// The handoff's parts, each tested on its own: the block, the digest, the attempt's files and the redaction, over
// synthetic transcripts and states. buildHandoff composes them; recovery-handoff.test.mjs tests the whole.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boundedValue, escalationBudgetLine, escalationContextBlock, stateShapes, STATE_LIMIT } from '../dist/recovery/handoff-block.js';
import { DIGEST_LIMIT, DIGEST_STEP_LIMIT, inheritedJobDigest, stepDigest, stepLabelOf } from '../dist/recovery/handoff-digest.js';
import { inputProvenance, judgedRecords, writeHandoffFiles } from '../dist/recovery/handoff-files.js';
import { handoffFirstTurn } from '../dist/recovery/handoff.js';

const scratch = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));

const row = {
  kind: "review_required", stage: "plan", summary: "The plan needs a human look before rendering.",
  step_label: "review-gate", step_exec_id: "e1", workflow_sha_used: "abcdef0123456789abcdef",
  state: { plan: { pose: "wave", palette: ["red", "blue"] }, profile: { name: "Ana", title: "x".repeat(900) }, review_required: true },
  cost_usd: 0.1234, evidence_dir: "/w/jobs/j/evidence", report_path: "/w/jobs/j/report-frozen-attempt.md",
};

test("the tail block is built from the row alone: step, reason, completed outputs, state, evidence, spend, instruction", () => {
  const block = escalationContextBlock(row);
  assert.match(block, /stopped at step `review-gate` \(execution e1\): review_required at stage plan/);
  assert.match(block, /The plan needs a human look/);
  assert.match(block, /- plan: object \{pose, palette\}/);
  assert.match(block, /- profile: object \{name, title\}/);
  assert.match(block, /- review_required: boolean/);
  assert.match(block, /"pose": "wave"/);
  assert.ok(block.includes(`"title": "${"x".repeat(900)}"`), "the state at the gate is rendered whole: no value is cut");
  assert.match(block, /evidence`?/);
  assert.match(block, /report-frozen-attempt\.md/);
  assert.match(block, /The frozen attempt spent \$0\.1234\./);
  assert.match(block, /Do not redo completed work/);
  assert.equal(escalationContextBlock(row), block, "deterministic for the same row");
});

test("a state beyond the limit is pointed at, never cut: the instruction, the key count and the file survive", () => {
  const big = { ...row, state: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key_${i}_${"n".repeat(40)}`, "y".repeat(10 * 1024)])) };
  const block = escalationContextBlock(big);
  assert.ok(block.length <= STATE_LIMIT, `block is ${block.length} chars`);
  assert.ok(block.endsWith("rather than inventing a cause."), "the block ends with the instruction");
  assert.match(block, /- …and \d+ more keys \(500 in total\)/, "the key count is listed");
  assert.match(block, /State body is \d+ chars \(500 keys\), beyond what this text carries; the list above names every key/, "with no file, the key list stands in");
  const filed = escalationContextBlock({ ...big, files: ["evidence/frozen/state.json"] });
  assert.match(filed, /State body is \d+ chars \(500 keys\), beyond what this text carries; read it whole in `evidence\/frozen\/state\.json`/, "with the file, the block points at it");
  const fits = { ...row, state: { records: Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, text: "t".repeat(500) })) } };
  assert.ok(JSON.stringify(fits.state, null, 2).length > 12 * 1024 && JSON.stringify(fits.state, null, 2).length < STATE_LIMIT);
  const whole = escalationContextBlock(fits);
  assert.ok(whole.includes('"id": "r59"') && !whole.includes("more items>"), "a state under the limit is rendered whole, every array item included");
  assert.match(block, /^## YOU ARE CONTINUING A RUN THAT ESCALATED/, "the header is present");
  assert.match(block, /The plan needs a human look/, "the reason is present");
  const many = { ...row, state: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { text: "y".repeat(300) }])) };
  assert.match(escalationContextBlock(many), /- k39: object \{text\}/, "a state that fits lists every key");
});

test("bounded values: strings, arrays and nested objects are cut with markers, scalars pass through", () => {
  assert.equal(boundedValue("abc"), "abc");
  assert.equal(boundedValue("z".repeat(405)), `${"z".repeat(400)}<5 more chars>`);
  const arr = boundedValue(Array.from({ length: 25 }, (_, i) => i));
  assert.equal(arr.length, 21); assert.equal(arr[20], "<5 more items>");
  assert.deepEqual(boundedValue({ a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(stateShapes(null), []);
  assert.deepEqual(stateShapes({ n: null, s: "ab", a: [1, 2], o: { x: 1 } }), ["- n: empty", "- s: string (2 chars)", "- a: array of 2", "- o: object {x}"]);
});

test("the block names every frozen file and the evidence directory only when given one", () => {
  const files = ["evidence/frozen/effects/e1-lookup.json", "evidence/frozen/gate.json", "evidence/frozen/inputs.json", "evidence/frozen/items/rec-1.md", "evidence/frozen/state.json"];
  const block = escalationContextBlock({ ...row, evidence_dir: null, files: files });
  assert.match(block, /Files the frozen attempt left in the workspace/);
  for (const file of files) assert.ok(block.includes(`- ${file}`), `${file} is listed`);
  assert.match(block, /Each file under evidence\/frozen\/items\/ is one record the workflow judged/);
  assert.match(block, /Each file under evidence\/frozen\/effects\/ is one paid call: its arguments and its full result/);
  assert.match(block, /State at the gate \(whole; also in `evidence\/frozen\/state\.json`\)/);
  assert.equal(block.includes("Evidence gathered so far"), false, "no evidence directory is named when none exists");
  const many = escalationContextBlock({ ...row, files: Array.from({ length: 250 }, (_, i) => `evidence/frozen/items/r${String(i).padStart(3, "0")}.md`) });
  assert.match(many, /- …50 more under evidence\/frozen\/items\//, "past the list limit the rest are counted by directory");
  assert.equal(escalationContextBlock({ ...row }).includes("Files the frozen attempt left"), false, "no files, no section");
});

test("the escalation reason is the workflow's own text, whole: no summary cut", () => {
  const summary = `Decide who the person is. ${"Weigh every candidate record against the stated identity. ".repeat(80)}END-OF-REASON`;
  assert.ok(summary.length > 4000);
  const block = escalationContextBlock({ ...row, summary });
  assert.ok(block.includes(summary), "the whole summary is in the block");
});

test("the host's escalation budget is one typed line in the block; none sent, no line", () => {
  assert.equal(escalationBudgetLine({ max_tool_calls: 4, max_seconds: 40 }), "Budget for this continuation (set by the host): 4 external tool calls and 40 seconds.");
  assert.equal(escalationBudgetLine({ max_seconds: 40 }), "Budget for this continuation (set by the host): 40 seconds.");
  assert.equal(escalationBudgetLine(null), "");
  const block = escalationContextBlock({ ...row, budget: { max_tool_calls: 4, max_seconds: 40 } });
  assert.match(block, /Why it stopped:\nThe plan needs a human look before rendering\.\n\nBudget for this continuation \(set by the host\): 4 external tool calls and 40 seconds\.\n/);
  assert.equal(escalationContextBlock(row).includes("Budget for this continuation"), false, "the harness states no budget of its own");
});



const RUN = "job-1";
/** A submitted step's transcript: asked, one tool call with its result, a conclusion, a submit. */
function stepSession(root, { label = "plan-figure", conclude = "The brief names Ada at Example Robotics; planning a jumpsuit figure.", extraCalls = 0 } = {}) {
  const messages = [{ role: "user", content: `{"question":"Name: Ada Example","brief":{"name":"Ada Example","company":"Example Robotics"}}` }];
  const calls = [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "brief.txt" } }];
  for (let i = 0; i < extraCalls; i++) calls.push({ type: "toolCall", id: `x${i}`, name: "grep", arguments: { pattern: "robot".repeat(60), path: "." } });
  messages.push({ role: "assistant", content: calls, stopReason: "toolUse" });
  messages.push({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "Ada at Example Robotics" }], isError: false });
  for (let i = 0; i < extraCalls; i++) messages.push({ role: "toolResult", toolCallId: `x${i}`, toolName: "grep", content: [{ type: "text", text: "match ".repeat(80) }], isError: false });
  messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: conclude },
    { type: "toolCall", id: "c2", name: "submit", arguments: { figure_prompt: "Ada Example as a LEGO minifigure in an Example Robotics jumpsuit", accepted: true } }], stopReason: "toolUse" });
  messages.push({ role: "toolResult", toolCallId: "c2", toolName: "submit", content: [{ type: "text", text: "Submitted." }], isError: false });
  const id = `${RUN}:${label}:step:/root/steps/1:a0`;
  transcripts.set(id, messages);
  return { id, role: "step", state: "submitted", file: null, spend: { usd: 0.0123, turns: 2 } };
}
/** The steps' transcripts by session id, as the run's durable file would hand them back. */
const transcripts = new Map();
const transcriptOf = (id) => transcripts.get(id) ?? null;
const job = (root, session, extra = {}) => {
  const cwd = path.join(root, "ws"); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "brief.txt"), "Ada at Example Robotics");
  const evidenceDir = path.join(cwd, "evidence"); fs.mkdirSync(path.join(evidenceDir, "profile"), { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "profile", "ada.json"), "{}");
  return { runId: RUN, transcriptOf, cwd, evidenceDir, sessions: session ? [session] : [], files: { "brief.txt": "f".repeat(64) },
    effects: [{ id: "step:0:call:0", name: "lookup-profile", status: "completed", result: { headline: "Head of Robotics Platform" } }, { id: "step:1:call:0", name: "write", status: "completed" }], ...extra };
};

test("step labels parse from the step session id and nothing else", () => {
  assert.equal(stepLabelOf(RUN, `${RUN}:plan-figure:step:/root/steps/1:a0`), "plan-figure");
  assert.equal(stepLabelOf(RUN, `${RUN}:plan-figure:step:/root/steps/1:a3`), "plan-figure");
  assert.equal(stepLabelOf(RUN, `${RUN}:deepen: customer identity:step:/root/steps/5/branches/0:a0`), "deepen: customer identity", "a label may hold colons");
  assert.equal(stepLabelOf(RUN, RUN), null, "the driver's own row is not a step");
  assert.equal(stepLabelOf(RUN, "other:plan:step:/root/steps/1:a0"), null, "another run's rows are not this run's steps");
  assert.equal(stepLabelOf(RUN, `${RUN}:render-items:step:/root/steps/2/items/2/body:a0`), "render-items[2]", "a map item names its index");
  assert.notEqual(stepLabelOf(RUN, `${RUN}:render-items:step:/root/steps/2/items/0/body:a0`), stepLabelOf(RUN, `${RUN}:render-items:step:/root/steps/2/items/1/body:a0`), "distinct items, distinct labels");
  assert.equal(stepLabelOf(RUN, `${RUN}:draft:step:/root/steps/3/iterations/1/body/steps/0:a0`), "draft#1", "a loop iteration names its index");
  assert.equal(stepLabelOf(RUN, `${RUN}:review/verify:step:/root/steps/1/workflow/root/steps/0:a1`), "review/verify", "a child step carries the name the interpreter gives it");
  assert.equal(stepLabelOf(RUN, `${RUN}:adapt:plan/render:adapt:/root/steps/0/workflow/root/steps/1:a0`), "adapt:plan/render", "a plan step likewise");
});

test("a completed step's digest says what it was asked, called, concluded and submitted; deterministic", () => {
  const root = scratch("inherit-");
  try {
    const session = stepSession(root);
    const digest = stepDigest(RUN, session, transcriptOf);
    assert.match(digest, /^### Step `plan-figure` \(submitted, 2 turns, \$0\.0123\)/);
    // A spend the run's cost fold qualifies keeps its qualification: a floor, or unknown, never $0.
    assert.match(stepDigest(RUN, { ...session, spend: { usd: 0.0123, turns: 2, state: "partial" } }, transcriptOf), /^### Step `plan-figure` \(submitted, 2 turns, at least \$0\.0123, some cost unknown\)/);
    assert.match(stepDigest(RUN, { ...session, spend: { usd: null, turns: 2, state: "unavailable" } }, transcriptOf), /^### Step `plan-figure` \(submitted, 2 turns, cost unknown\)/);
    assert.match(digest, /- asked: .*Ada Example/);
    assert.match(digest, /- called read\(\{"path":"brief.txt"\}\) → ok: Ada at Example Robotics/);
    assert.match(digest, /- concluded: The brief names Ada/);
    assert.match(digest, /- submitted: .*figure_prompt.*Example Robotics jumpsuit/);
    assert.equal(digest.includes("private reasoning"), false, "a step with a conclusion does not leak its reasoning");
    assert.equal(stepDigest(RUN, session, transcriptOf), digest, "the same transcript digests to the same text");
    // An interrupted step that reasoned but never concluded hands over its status, never its reasoning.
    const stripped = transcripts.get(session.id).map((m) => m.role === "assistant" ? { ...m, content: m.content.filter((b) => b.type !== "text" && b.name !== "submit") } : m);
    const interrupted = stepDigest(RUN, { ...session, state: "running" }, () => stripped);
    assert.equal(interrupted.includes("private reasoning"), false, "an interrupted step does not leak its reasoning either");
    assert.match(interrupted, /- ended without a text conclusion/);
    assert.match(stepDigest(RUN, session, () => null), /- transcript unavailable$/);
    assert.match(stepDigest(RUN, session, () => { throw new Error("torn"); }), /- transcript unreadable$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a step's digest stays within its budget as whole lines plus a count", () => {
  const root = scratch("inherit-");
  try {
    const digest = stepDigest(RUN, stepSession(root, { extraCalls: 60 }), transcriptOf);
    assert.ok(digest.length <= DIGEST_STEP_LIMIT + 80, `bounded: ${digest.length}`);
    assert.match(digest, /- …\d+ more lines omitted$/);
    assert.match(digest, /^### Step `plan-figure`/, "the head is never dropped");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the job digest lists the steps, the paid effects with results, the files with receipts and the evidence", () => {
  const root = scratch("inherit-");
  try {
    const digest = inheritedJobDigest(job(root, stepSession(root)));
    assert.match(digest, /^## THE JOB AS IT STANDS \(inherited from the frozen attempt\)/);
    assert.match(digest, /### Step `plan-figure`/);
    assert.match(digest, /- lookup-profile \[step:0:call:0\] completed → \{"headline":"Head of Robotics Platform"\}/);
    assert.equal(digest.includes("[step:1:call:0]"), false, "workspace tool effects are not paid effects");
    assert.match(digest, /Calling the same tool again buys the same answer twice/);
    assert.match(digest, /- brief\.txt \(23 bytes\) sha256 ffffffffffff/);
    assert.match(digest, /### Evidence directory \(`.*evidence`\)\n- profile\/ada\.json \(2 bytes\)/);
    assert.match(digest, /You are continuing this job, not restarting it\./);
    assert.equal(inheritedJobDigest(job(root, stepSession(root))), digest, "deterministic");
    const bare = inheritedJobDigest({ runId: RUN, transcriptOf, cwd: path.join(root, "none"), evidenceDir: null, sessions: [], files: {}, effects: [] });
    assert.match(bare, /### LLM steps run so far[^\n]*\n- none/);
    assert.match(bare, /### Paid effects already made \(0\)\n- none/);
    assert.match(bare, /### Files produced[^\n]*\n- none/);
    assert.match(bare, /### Evidence directory\n- empty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the job digest is bounded: sections keep whole lines and count the rest, the footer survives", () => {
  const root = scratch("inherit-");
  try {
    const sessions = Array.from({ length: 40 }, (_, i) => ({ ...stepSession(root, { label: `step-${i}`, conclude: "z".repeat(1500) }) }));
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`out/file-${i}.txt`, "a".repeat(64)]));
    const effects = Array.from({ length: 300 }, (_, i) => ({ id: `step:${i}:call:0`, name: `paid-${i}`, status: "completed", result: "r".repeat(400) }));
    const digest = inheritedJobDigest(job(root, null, { sessions, files, effects }));
    assert.ok(digest.length <= DIGEST_LIMIT + 200, `bounded: ${digest.length}`);
    assert.match(digest, /### LLM steps run so far[\s\S]*more entries omitted/, "the transcripts take what the ledger facts leave");
    assert.match(digest, /- …260 more$/m, "effects beyond the list limit are counted");
    assert.match(digest, /- …260 more$/m, "files beyond the list limit are counted");
    assert.ok(digest.indexOf("### LLM steps run so far") < digest.indexOf("### Paid effects"), "display order: steps first");
    assert.ok((digest.match(/### Step `step-\d+`/g) ?? []).length >= 3, "several whole step transcripts survive");
    assert.match(digest, /You are continuing this job, not restarting it\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the tail's first turn is the block, then the digest; a missing digest degrades to the block", () => {
  const parts = { block: "## YOU ARE CONTINUING A RUN THAT ESCALATED\nblock", digest: "## THE JOB AS IT STANDS\ndigest" };
  assert.equal(handoffFirstTurn(parts), `${parts.block}\n\n${parts.digest}`);
  assert.equal(handoffFirstTurn({ block: parts.block, digest: null }), parts.block);
});

test("nothing the frozen attempt handled leaks into the tail's first turn: keys, bearer tokens, e-mails and cursor tokens are redacted everywhere", () => {
  const root = scratch("inherit-");
  try {
    const KEY = "sk-" + "a1b2c3d4e5f6g7h8i9j0";
    // Assembled at run time: a credential-shaped literal in a source file is what the source export refuses.
    const BEARER = ["Bearer eyJhbGciOiJIUzI1NiJ9", "secretpayload", "signature"].join(".");
    const EMAIL = "ada.example@example-robotics.com";
    const CURSOR = "crsr_" + "0123456789abcdefghij";
    const secrets = [KEY, BEARER, EMAIL, CURSOR];
    // Planted in every position a string enters the digest: tool args, tool results, the
    // conclusion, the submitted record, an effect result, a produced file name, an evidence file.
    const cwd = path.join(root, "ws"); fs.mkdirSync(path.join(cwd, "evidence"), { recursive: true });
    const session = { id: `${RUN}:lookup:step:/root/steps/1:a0`, role: "step", state: "submitted", file: null, spend: { usd: 0.01, turns: 2 } };
    transcripts.set(session.id, [
      { role: "user", content: `{"question":"Contact ${EMAIL}","auth":"${BEARER}"}` },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "fetch", arguments: { tool: "crm:lookup", args: { api_key: KEY, email: EMAIL, header: BEARER } } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c1", toolName: "fetch", content: [{ type: "text", text: `{"cursor":"${CURSOR}","owner":"${EMAIL}"}` }], isError: false },
      { role: "assistant", content: [{ type: "text", text: `Reached ${EMAIL} with ${KEY}; next page ${CURSOR}.` },
        { type: "toolCall", id: "c2", name: "submit", arguments: { contact: EMAIL, token: CURSOR, note: BEARER } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c2", toolName: "submit", content: [{ type: "text", text: "Submitted." }], isError: false },
    ]);
    fs.writeFileSync(path.join(cwd, `${EMAIL}.txt`), "x");
    fs.writeFileSync(path.join(cwd, "evidence", `${CURSOR}.json`), "{}");
    const digest = inheritedJobDigest({ runId: RUN, transcriptOf, cwd, evidenceDir: path.join(cwd, "evidence"), sessions: [session], files: { [`${EMAIL}.txt`]: "f".repeat(64) },
      effects: [{ id: "step:0:call:0", name: "lookup", status: "completed", result: { api_key: KEY, page: CURSOR, auth: BEARER, contact: EMAIL } }] });
    for (const secret of secrets) assert.equal(digest.includes(secret), false, `digest leaks ${secret.slice(0, 12)}`);
    assert.match(digest, /<redacted>/);
    assert.match(digest, /<redacted email>/);
    assert.match(digest, /Bearer <redacted>/);
    assert.match(digest, /### Step `lookup`/, "the step is still digested");
    // The escalation block: the summary and the state JSON.
    const block = escalationContextBlock({ step_label: "gate", kind: "review_required", stage: "lookup", summary: `Review ${EMAIL}; key ${KEY}`,
      state: { contact: EMAIL, api_key: KEY, auth: BEARER, page: CURSOR, nested: { bearer: BEARER } }, cost_usd: 0.01, remaining_usd: 1, evidence_dir: path.join(cwd, "evidence"), workflow_sha_used: "w".repeat(12) });
    for (const secret of secrets) assert.equal(block.includes(secret), false, `block leaks ${secret.slice(0, 12)}`);
    assert.match(block, /<redacted>/);
    assert.match(block, /<redacted email>/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A call-only fan-out: every lookup is a `via: tool` call, so no step wrote anything under evidence/.
// The judged records and the gate live only in the escalate node's state and the pin's routes.
function fanOutMemo() {
  const LONG = JSON.stringify({ url: "https://profiles.example/alpha", title: "Alex Sample", text: `# Alex Sample\n\nHead of Widgets at Example Co.\n\n${"Long profile body. ".repeat(40)}` });
  const records = [
    { id: "src-a-1", source: "Directory search", text: LONG, url: "https://profiles.example/alpha", match: 0.66, conflict: 0.35, given: false },
    { id: "src-b-1", source: "Records search", text: JSON.stringify({ names: ["Alex Sample"], places: ["Springfield"] }), url: null, match: 0.1, conflict: 0.43, given: false },
    { id: "src-b-2", source: "Records search", text: "short note", url: null, match: 0.01, conflict: 0.52, given: false },
  ];
  const gate = { decision: "unsure", matched_ids: [], maybe_ids: ["src-a-1", "src-b-1"], confirmed: false };
  const state = { question: "Who is Alex?", candidates: records, decide: { gate, use: { evidence: [] } }, shortlist: [records[0]] };
  const effects = [
    { id: "frozen:/root/steps/1/branches/0:0", name: "search-a", status: "completed", result: { value: { results: [{ url: "https://profiles.example/alpha" }] }, files: {}, intent: { tool: "directory:search", args: { query: "Alex Sample", api_key: "sk-" + "a1b2c3d4e5f6g7h8i9j0" } } } },
    { id: "frozen:/root/steps/1/branches/1:0", name: "search-b", status: "completed", result: { value: { people: [{ names: ["Alex Sample"] }] }, files: {}, intent: { tool: "records:search", args: { query: "Alex Sample" } } } },
    { id: "frozen:/root/steps/1/branches/2:0", name: "search-c", status: "unknown", result: null },
  ];
  const routes = { "/root/steps/2": { label: "decide", branch: "escalate", choice: "unsure", unsure: true, request_sha256: null, result: gate, receipts: null } };
  return { state, memo: { effects, routes }, row: { kind: "review_required", stage: "decide", step_label: "identity unsure", summary: "Settle the identity from the judged records.", state } };
}

test("a call-only fan-out escalation writes the frozen attempt under evidence/frozen/, and the tail's first turn names every file", async () => {
  const root = scratch("inherit-");
  try {
    const cwd = path.join(root, "ws"); fs.mkdirSync(cwd, { recursive: true });
    const { state, memo, row } = fanOutMemo();
    const input = { question: "Who is Alex?", context: { name: "Alex Sample", contact: "alex@example.com", profile: "https://profiles.example/alpha", note: "met at a trade show, works on widgets" }, files: [] };
    const { files, effectFiles } = await writeHandoffFiles(cwd, row, memo, input);
    assert.deepEqual(files, [
      "evidence/frozen/effects/frozen_root_steps_1_branches_0_0-search-a.json",
      "evidence/frozen/effects/frozen_root_steps_1_branches_1_0-search-b.json",
      "evidence/frozen/gate.json", "evidence/frozen/inputs.json",
      "evidence/frozen/items/src-a-1.md", "evidence/frozen/items/src-b-1.md", "evidence/frozen/items/src-b-2.md",
      "evidence/frozen/state.json",
    ], "one file per completed effect and per judged record; the unknown effect has none");
    const unanswered = await writeHandoffFiles(cwd, row, { effects: [{ id: "e9", name: "ran", status: "completed", result: null }, ...memo.effects], routes: memo.routes }, input);
    assert.equal(unanswered.files.some((f) => f.includes("-ran.json")), false, "a completed effect with no recorded answer has no file");
    const read = (f) => fs.readFileSync(path.join(cwd, f), "utf8");
    assert.deepEqual(JSON.parse(read("evidence/frozen/state.json")), state, "the state at the gate, whole");
    const gate = JSON.parse(read("evidence/frozen/gate.json"));
    assert.deepEqual(Object.keys(gate), ["kind", "stage", "step_label", "summary", "state_at_gate", "routes"]);
    assert.deepEqual(gate.routes["/root/steps/2"].result.maybe_ids, ["src-a-1", "src-b-1"], "the route decision is whole");
    const inputs = JSON.parse(read("evidence/frozen/inputs.json"));
    assert.deepEqual(inputs.input, input);
    assert.deepEqual(inputs.provenance, [
      { path: "question", form: "text", value: "Who is Alex?" },
      { path: "context.name", form: "text", value: "Alex Sample" },
      { path: "context.contact", form: "email", value: "alex@example.com" },
      { path: "context.profile", form: "url", value: "https://profiles.example/alpha" },
      { path: "context.note", form: "text", value: "met at a trade show, works on widgets" },
    ], "each input's path and form, unranked");
    const effect = JSON.parse(read(effectFiles["frozen:/root/steps/1/branches/0:0"]));
    assert.equal(effect.tool, "directory:search");
    assert.equal(effect.args.query, "Alex Sample");
    assert.equal(effect.args.api_key, "<redacted>", "a secret-named argument is redacted in the file");
    assert.deepEqual(effect.result, { results: [{ url: "https://profiles.example/alpha" }] }, "the full result");
    const item = read("evidence/frozen/items/src-a-1.md");
    assert.match(item, /^# src-a-1\n/);
    assert.match(item, /- match: 0\.66\n- conflict: 0\.35/, "the record's scores");
    assert.match(item, /- source: Directory search/);
    assert.match(item, /## text\n\n```json\n\{\n  "url": "https:\/\/profiles\.example\/alpha"/, "a JSON text is pretty-printed whole");
    assert.ok(item.includes("Long profile body. ".repeat(40).trim()), "the record's text is whole");
    assert.equal(judgedRecords(state).length, 3, "a record seen in two arrays is one item");

    // The ladder's handoff: the block lists the files, the digest points each paid effect at its file.
    const block = escalationContextBlock({ ...row, evidence_dir: null, files: files, inputs: inputProvenance(input) });
    assert.match(block, /Inputs the run started from, as the dispatch carried them \(path: form: value\); whole in `evidence\/frozen\/inputs\.json`/);
    assert.match(block, /- context\.name: typed text: Alex Sample\n- context\.contact: identifier \(email address\): <redacted email>\n- context\.profile: identifier \(URL\): https:\/\/profiles\.example\/alpha\n- context\.note: typed text: met at a trade show/);
    const digest = inheritedJobDigest({ runId: RUN, transcriptOf, cwd, evidenceDir: null, sessions: [], files: {}, effectFiles,
      effects: memo.effects.map((e) => ({ id: e.id, name: e.name, status: e.status, ...(e.status === "completed" ? { result: e.result } : {}) })) });
    const first = handoffFirstTurn({ block, digest });
    for (const file of files) assert.ok(first.includes(file), `the first turn names ${file}`);
    assert.match(first, /- search-a \[frozen:\/root\/steps\/1\/branches\/0:0\] completed → .{1,200}\(whole: evidence\/frozen\/effects\/frozen_root_steps_1_branches_0_0-search-a\.json\)/, "the effect line keeps its preview and names its file");
    assert.equal(first.includes("Evidence gathered so far"), false, "evidence/ held nothing of the steps': not named as a gathered directory");

    // Rewritten whole on a second handoff: a stale item never survives.
    fs.writeFileSync(path.join(cwd, "evidence/frozen/items/stale.md"), "old");
    const again = await writeHandoffFiles(cwd, row, memo, input);
    assert.deepEqual(again.files, files);
    assert.equal(fs.existsSync(path.join(cwd, "evidence/frozen/items/stale.md")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the digest's evidence listing skips the frozen files the block already lists", async () => {
  const root = scratch("inherit-");
  try {
    const j = job(root, null);
    const { memo, row } = fanOutMemo();
    await writeHandoffFiles(j.cwd, row, memo);
    const digest = inheritedJobDigest(j);
    assert.match(digest, /### Evidence directory \(`.*evidence`\)\n- profile\/ada\.json \(2 bytes\)\n\n/);
    assert.equal(digest.includes("frozen/"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("every input keeps its path and form in inputs.json; the block lists the first hundred and counts the rest", async () => {
  const input = { question: "q", context: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}`, `value ${i}`])), files: [] };
  const provenance = inputProvenance(input);
  assert.equal(provenance.length, 151);
  assert.deepEqual(provenance.at(-1), { path: "context.f149", form: "text", value: "value 149" });
  const block = escalationContextBlock({ step_label: "gate", kind: "k", stage: "s", summary: "r", state: {}, inputs: provenance, files: ["evidence/frozen/inputs.json"] });
  assert.match(block, /- …51 more inputs \(151 in total\), each with its path and form in `evidence\/frozen\/inputs\.json`/);
  assert.equal(block.includes("context.f99:"), false);
  assert.ok(block.includes("context.f98: typed text: value 98"));
});
