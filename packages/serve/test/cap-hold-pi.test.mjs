// pi on GPT-6.1 Sol through OpenRouter under a $1.50 cap, at Sol's list price (pi-ai's openrouter table: $2 input, $10
// output, $2.50 a cache write, $0.10 a cache read, a million tokens; past 272,000 input tokens every rate of the request
// doubles, output to $15). pi-ai lists that model on chat completions, so pi's session speaks Messages to serve's
// translation (model-route.ts messagesFetch): its proxy's upstream is no provider that counts a body, so the cap bounds
// each request's input by what it can state. Its bytes are a bound (a token covers at least a byte), and four times what
// English text bills: a run that has read a few long pages sends a body past 272,000 bytes while it bills some 75,000
// tokens, and on its bytes alone the request's least step is priced at the long-context rate, more than the cap has left.
// Sol's tokenizer is o200k_base, so the body is counted locally with the stated margin (local-count.ts), as a Responses
// request to a gateway is: a true bound, at a quarter of the bytes, and the run goes on.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { closeOpenSessions, hostTools } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
after(closeOpenSessions);

const CAP = 1.5;
/** GPT-6.1 Sol as OpenRouter names it, the model a run on an OpenRouter key gets on pi. */
const SOL = "openai/gpt-6.1-sol";
/** Sol as the cap prices it, from pi-ai's openrouter table: its rates, its long-context tier and its 128,000-token
 *  output ceiling. */
const SOL_CAP = Object.freeze({ id: SOL, api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }, outputCeiling: 128_000, reasoning: true });
/** What the provider bills a usage at Sol's list price, below its long-context tier (every request here is). */
const price = (_model, usage) => ((usage.input ?? 0) * 2 + (usage.cacheWrite ?? 0) * 2.5 + (usage.cacheRead ?? 0) * 0.1 + (usage.output ?? 0) * 10) / 1e6;
/** A long page as a fetch returns it: some 300 KB of English, which o200k_base reads as some 60,000 tokens. */
const PAGE = "Each party's total liability under these terms will not exceed the fees paid in the three months before the claim.\n".repeat(2_600);

const BILLED_AFTER_PAGE = 58_000;

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** Step 0 calls read (billed $0.10: 45,000 input tokens and 1,000 output); step 1 answers, billed for the page's tokens
 *  (58,000, under the body's o200k_base count without its margin). */
function answer(body, step, usage) {
  const block = step === 0
    ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }]
    : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }];
  return sse([
    { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: step === 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ]);
}
/** The translation's upstream as the proxy sees it: no count of its own, step 0 calls read, step 1 answers. */
function origin(sent) {
  return async (url, init = {}) => {
    if (String(url).includes("count_tokens")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ body, bytes: Buffer.byteLength(String(init.body ?? ""), "utf8") });
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    return step === 0 ? answer(body, 0, { input_tokens: 45_000, output_tokens: 1_000 }) : answer(body, step, { input_tokens: BILLED_AFTER_PAGE, output_tokens: 200 });
  };
}

const read = { name: "read", replaySafe: true, ask: false, run: async () => PAGE };
const specOf = (fetch) => (_claim, run) => ({
  // The translation's origin: not Anthropic's, so the proxy asks no provider to count a body.
  adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: SOL, provider: { api: "anthropic-messages", origin: "https://model-route.invalid", credential: () => "model-route" }, fetch, price }),
  session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools({ read }), context: "fresh" },
  input: "Follow the script.",
  hooks: quiet,
  gate: () => "allow",
});

/** The run's spend as its records count it, every session summed. */
async function spentOf(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let spent = 0;
    for (const key of await sessions.keys()) spent += sessionSpendOf(await sessions.read(key)).spentUsd;
    return spent;
  } finally {
    await harness.close(ctx);
  }
}

/** A unified diff of TypeScript of about `bytes` bytes, the same every time: code tokenizes denser than prose, so a body
 *  of it checks the local count's margin where a token covers fewer bytes. */
function typescriptDiff(bytes) {
  const lines = ["diff --git a/src/billing/ledger.ts b/src/billing/ledger.ts", "index 3f2a91c..8be04d7 100644", "--- a/src/billing/ledger.ts", "+++ b/src/billing/ledger.ts"];
  let size = lines.join("\n").length;
  for (let i = 0; size < bytes; i++) {
    const hunk = [
      `@@ -${12 * i + 1},7 +${14 * i + 1},9 @@ export class Ledger${i % 37} implements Settles<Entry${i % 11}> {`,
      ` export async function settle${i}(entry: LedgerEntry, limits: ReadonlyMap<string, number>): Promise<SettleResult> {`,
      `-  const total = entry.lines.reduce((sum, line) => sum + line.amountCents, 0);`,
      `+  const rate = (line: LedgerLine): number => limits.get(line.currency) ?? ${(i % 9) + 1};`,
      `+  const total = entry.lines.reduce((sum, line) => sum + Math.round(line.amountCents * rate(line)), ${i % 5});`,
      `+  if (total > MAX_SETTLE_CENTS_${i % 13}) throw new RangeError(\`settle${i}: \${total} cents is over the limit\`);`,
      `   await this.journal.append({ kind: "settle", id: entry.id, total, at: clock.now() + ${i} });`,
      `   return { id: entry.id, total, settledAt: Date.now(), shard: hashShard(entry.id, ${(i * 7) % 64}) };`,
      ` }`,
    ];
    lines.push(...hunk);
    size += hunk.join("\n").length + hunk.length;
  }
  return lines.join("\n");
}
/** What the code review pastes: a diff of some 281 KB, so its parent's merge request is some 286 KB on the wire. */
const DIFF = typescriptDiff(281_000);
/** The eight reviewers' findings, as each returns to the parent. */
const FINDING = (n) => `Reviewer ${n}: settle${n * 31} rounds each line before summing, so a ledger of many small lines drifts by up to a cent a line; sum in cents first. No other finding.`;
const CODE_CAP = 2;
/** What the parent and its reviewers spent before the merge request: its first step, billed at Sol's list price. */
const SPENT_BEFORE_MERGE = 0.62;

test("a code review's merge step on sol: a pi parent at $2 with $0.62 spent, whose merge request carries a pasted 281 KB TypeScript diff and eight reviewers' findings (some 286 KB, past the tier on its bytes), is admitted on its local count, at least the body's own o200k count with its margin, and answers under the cap", { timeout: 90_000 }, async (t) => {
  const sent = [];
  let billed = 0;
  // Step 0 starts the eight reviewers (one tool call each), billed $0.62; step 1 merges their findings and answers,
  // billed for the body's own o200k count.
  const fetch = async (url, init = {}) => {
    if (String(url).includes("count_tokens")) return new Response("{}", { status: 404 });
    const text = String(init.body ?? "");
    const body = JSON.parse(text);
    sent.push({ body, bytes: Buffer.byteLength(text, "utf8") });
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if (step === 0) {
      const calls = Array.from({ length: 8 }, (_, n) => [
        { type: "content_block_start", index: n, content_block: { type: "tool_use", id: `toolu_${n}`, name: "review", input: {} } },
        { type: "content_block_delta", index: n, delta: { type: "input_json_delta", partial_json: JSON.stringify({ reviewer: n + 1 }) } },
        { type: "content_block_stop", index: n },
      ]).flat();
      return sse([
        { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 260_000, output_tokens: 1 } } },
        ...calls,
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10_000 } },
        { type: "message_stop" },
      ]);
    }
    return answer(body, step, { input_tokens: billed, output_tokens: 400 });
  };
  const review = { name: "review", replaySafe: true, ask: false, run: async (args) => FINDING(args.reviewer ?? 0) };
  const spec = (_claim, run) => ({
    adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: SOL, provider: { api: "anthropic-messages", origin: "https://model-route.invalid", credential: () => "model-route" }, fetch, price }),
    session: { key: "root", label: "root", system: ["Review the pasted diff: start eight reviewers, then merge their findings."], tools: hostTools({ review }), context: "fresh" },
    input: `Review this change.\n\n${DIFF}`,
    hooks: quiet,
    gate: () => "allow",
  });
  // The body's own o200k count, what Sol bills it: the diff, the findings and the instructions, as text.
  const { o200kTokens } = await import("@parcha/agentrun-kernel/host");
  billed = await o200kTokens([DIFF, ...Array.from({ length: 8 }, (_, n) => FINDING(n + 1)), "Review this change.", "Review the pasted diff: start eight reviewers, then merge their findings."].join("\n"));
  const { row, asked, store } = await capRun(t, { specOf: () => spec, cap: specCap(CODE_CAP), runCap: { capUsd: () => CODE_CAP, modelOf: () => SOL_CAP }, ms: 60_000 });
  const spent = await spentOf(store);
  t.diagnostic(`${row.state} ${JSON.stringify(row.summary ?? row.error ?? null).slice(0, 400)}: spent $${spent.toFixed(4)}; bodies ${JSON.stringify(sent.map((one) => one.bytes))}; billed ${billed}`);
  t.diagnostic(`asked: ${JSON.stringify(asked.map((one) => ({ inputTokensMax: one.request?.inputTokensMax, answer: one.answer && ("refuse" in one.answer ? { refuse: one.answer.refuse } : { holdUsd: Number(one.answer.holdUsd?.toFixed(4)), outputTokensMax: one.answer.outputTokensMax }) })))}`);
  assert.ok(Math.abs(price(SOL, { input: 260_000, output: 10_000 }) - SPENT_BEFORE_MERGE) < 1e-9, "the first step is billed $0.62");
  const refusals = asked.filter((one) => one.answer && "refuse" in one.answer).map((one) => one.answer.refuse);
  assert.deepEqual(refusals, [], "the merge request is not refused: its bound is its count, not its 286 KB");
  assert.equal(sent.length, 2, "the merge request was sent");
  const merge = sent[1];
  assert.equal(merge.body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result").length, 8, "it carries the eight findings");
  assert.ok(merge.bytes > 272_000 && merge.bytes < 300_000, `the merge request is ${merge.bytes} bytes: past Sol's 272,000-token tier on its bytes`);
  // Its bound is the body's own count with the stated margin: never under it, and under the tier.
  const bound = asked[1].request.inputTokensMax;
  assert.ok(bound >= Math.ceil(billed * 1.1) && bound < 272_000, `bounded at ${bound} tokens: at least ${billed} counted with its 10% margin, and under the tier`);
  // Its least, at the bound: a cache write at $2.50 and a least answer at $10, well under the $1.38 left.
  const least = (bound * 2.5 + 1_024 * 10) / 1e6;
  assert.ok(least < (CODE_CAP - SPENT_BEFORE_MERGE) / 2, `its least, $${least.toFixed(4)}, is well under the $${(CODE_CAP - SPENT_BEFORE_MERGE).toFixed(2)} left`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(spent <= CODE_CAP + 1e-12, `the run's records count $${spent} on a $${CODE_CAP} cap`);
});

/** A code review's three requests on sol, the wrap-up's case: step 0 reads the review skill; step 1 writes a script that
 *  pastes the diff into one codemode call and hits the 32,000-token output ceiling mid-string, so its arguments are cut and
 *  its tool result is the parse error echoing the 117 KB it got; step 2 answers. Before step 2 the run has spent $0.44
 *  ($0.10, then $0.34), and step 2's body (the pasted diff, the skill, the echo) is past 272,000 bytes. The wrap-up's note
 *  is priced on the input count admission reads (the local count), never on the bytes: on its bytes step 2's least is
 *  past the tier, about $1.45, and a $2 run was told to finish with $1.56 left and answered with no review. */
const REVIEW_DIFF = typescriptDiff(157_000);
const SKILL = `# Review\n\n${"Start eight independent reviewers on the change, merge what they find, and return the findings as JSON.\n".repeat(64)}`.slice(0, 6_717);
/** What step 1 streams for codemode's arguments: the script's JSON, cut 116,891 bytes in, inside its string. */
const CUT_ARGS = JSON.stringify({ script: `const diff = String.raw\`${REVIEW_DIFF}\`;\nconst found = await Promise.all(reviewers.map((r) => r(diff)));` }).slice(0, 116_891);

/** The provider for that review: what each step bills, and every body sent. */
function reviewOrigin(sent) {
  return async (url, init = {}) => {
    if (String(url).includes("count_tokens")) return new Response("{}", { status: 404 });
    const text = String(init.body ?? "");
    const body = JSON.parse(text);
    sent.push({ body, bytes: Buffer.byteLength(text, "utf8") });
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const start = (input) => ({ type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 1 } } });
    if (step === 0) {
      return sse([
        start(40_000),
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_skill", name: "read", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: ".agents/skills/review/SKILL.md" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2_000 } },
        { type: "message_stop" },
      ]);
    }
    if (step === 1) {
      return sse([
        start(10_000),
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_script", name: "codemode", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: CUT_ARGS } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 32_000 } },
        { type: "message_stop" },
      ]);
    }
    return answer(body, step, { input_tokens: 90_000, output_tokens: 400 });
  };
}

/** The review run on sol at `capUsd`: its rows, what the cap was asked, every body sent and the run's spend. */
async function reviewRun(t, capUsd) {
  const sent = [];
  const read = { name: "read", replaySafe: true, ask: false, run: async () => SKILL };
  // codemode is pi's own tool: the script call goes to it, and its arguments never parse.
  const spec = (_claim, run) => ({
    adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: SOL, provider: { api: "anthropic-messages", origin: "https://model-route.invalid", credential: () => "model-route" }, fetch: reviewOrigin(sent), price }),
    session: { key: "root", label: "root", system: ["Review the pasted diff with eight reviewers and return the review JSON."], tools: hostTools({ read }), context: "fresh" },
    input: `Review this diff (no pull request behind it):\n\n${REVIEW_DIFF}`,
    hooks: quiet,
    gate: () => "allow",
  });
  const { row, asked, store } = await capRun(t, { specOf: () => spec, cap: specCap(capUsd), runCap: { capUsd: () => capUsd, modelOf: () => SOL_CAP }, ms: 60_000 });
  const spent = await spentOf(store);
  t.diagnostic(`${row.state} ${JSON.stringify(row.summary ?? row.error ?? null).slice(0, 400)}: spent $${spent.toFixed(4)}; bodies ${JSON.stringify(sent.map((one) => one.bytes))}`);
  t.diagnostic(`asked: ${JSON.stringify(asked.map((one) => ({ inputTokensMax: one.request?.inputTokensMax, noted: one.request?.noted, answer: one.answer && ("refuse" in one.answer ? { refuse: one.answer.refuse } : { holdUsd: Number(one.answer.holdUsd?.toFixed(4)), outputTokensMax: one.answer.outputTokensMax }) })))}`);
  return { row, asked, sent, spent };
}
/** The text of every block of `body`'s messages, a tool result's inner blocks included. */
const textsOf = (body) => body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])).flatMap((block) => (block.type === "tool_result" ? (Array.isArray(block.content) ? block.content : [{ text: block.content }]) : [block])).map((block) => String(block.text ?? ""));
const SPENT_BEFORE_ANSWER = 0.44;

test("a code review on sol at $2 whose script call is cut at the output ceiling: with $0.44 spent, its answer request (past 272,000 bytes, the cut call's 117 KB error echo in it) gets no wrap-up note, since its least on the count admission reads is $0.25, under half the $1.56 left", { timeout: 90_000 }, async (t) => {
  const { row, asked, sent, spent } = await reviewRun(t, 2);
  assert.ok(Math.abs(price(SOL, { input: 40_000, output: 2_000 }) + price(SOL, { input: 10_000, output: 32_000 }) - SPENT_BEFORE_ANSWER) < 1e-9, "the two steps before the answer are billed $0.44");
  assert.equal(sent.length, 3, "three requests: the skill, the cut script, the answer");
  const last = sent[2];
  const echo = textsOf(last.body).find((text) => text.includes("Received arguments"));
  assert.ok(echo && echo.length > 100_000, `the answer request carries the cut call's error with its arguments echoed (${echo?.length} characters)`);
  assert.ok(last.bytes > 272_000, `the answer request is ${last.bytes} bytes: past Sol's 272,000-token tier on its bytes`);
  // Admission bounds it by its local count, well under the tier, so its least is a cache write at $2.50 a million and
  // Sol's least answer.
  const bound = asked[2].request.inputTokensMax;
  const least = (bound * 2.5 + 1_024 * 10) / 1e6;
  t.diagnostic(`bound ${bound}; least $${least.toFixed(4)}; left $${(2 - SPENT_BEFORE_ANSWER).toFixed(2)}; typical $0.34`);
  assert.ok(bound < 272_000 && 2 * least < 2 - SPENT_BEFORE_ANSWER, `admitted at ${bound} tokens, a least of $${least.toFixed(4)}: twice it is under the $1.56 left`);
  assert.equal(asked[2].request.noted, undefined, "the answer request is admitted carrying no note");
  assert.equal(textsOf(last.body).some((text) => text.includes("AgentRun server note")), false, "and no note is in what it sent");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(spent <= 2 + 1e-12, `the run's records count $${spent} on a $2 cap`);
});

test("the same review at $1: its first request (160 KB, some 53,000 tokens on its count) gets no step-0 note, and its answer request, with $0.56 left, under three typical steps of $0.34, carries the wrap-up note", { timeout: 90_000 }, async (t) => {
  const { row, asked, sent, spent } = await reviewRun(t, 1);
  assert.equal(sent.length, 3, "three requests: the skill, the cut script, the answer");
  assert.deepEqual(sent.slice(0, 2).map((one) => textsOf(one.body).some((text) => text.includes("AgentRun server note"))), [false, false], "the first two requests carry no note");
  assert.ok(textsOf(sent[2].body).some((text) => text.includes("AgentRun server note: About $0.56 left of this run's budget: finish now with your answer.")), "the answer request carries the note, with what is left");
  assert.equal(asked[2].request.noted, true, "admitted carrying it");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(spent <= 1 + 1e-12, `the run's records count $${spent} on a $1 cap`);
});

test("pi on GPT-6.1 Sol through OpenRouter at $1.50, $0.10 spent: a request whose body is past 272,000 bytes after a long page is admitted on its local count and answers, never past the cap", { timeout: 60_000 }, async (t) => {
  const sent = [];
  const { row, asked, store } = await capRun(t, { specOf: () => specOf(origin(sent)), cap: specCap(CAP), runCap: { capUsd: () => CAP, modelOf: () => SOL_CAP }, ms: 40_000 });
  const spent = await spentOf(store);
  t.diagnostic(`${row.state}: spent $${spent.toFixed(4)}; bodies ${JSON.stringify(sent.map((one) => one.bytes))}`);
  t.diagnostic(`asked: ${JSON.stringify(asked.map((one) => ({ inputTokensMax: one.request?.inputTokensMax, answer: one.answer && ("refuse" in one.answer ? { refuse: one.answer.refuse } : { holdUsd: Number(one.answer.holdUsd?.toFixed(4)), outputTokensMax: one.answer.outputTokensMax }) })))}`);
  // The first request read the page; the second carries it, past the long-context tier on its bytes.
  assert.equal(sent.length >= 1, true, "the first request was sent");
  const refusals = asked.filter((one) => one.answer && "refuse" in one.answer).map((one) => one.answer.refuse);
  assert.deepEqual(refusals, [], "no request refused: the one after the page is bounded by its count, not its bytes");
  assert.equal(sent.length, 2, "the request after the page was sent");
  assert.ok(sent[1].bytes > 272_000, `the request after the page is ${sent[1].bytes} bytes: past Sol's 272,000-token tier on its bytes`);
  // Its bound is its count, never under what it was billed: a true bound, a quarter of its bytes.
  const bound = asked[1].request.inputTokensMax;
  assert.ok(bound >= BILLED_AFTER_PAGE && bound * 4 < sent[1].bytes, `bounded at ${bound} tokens: at least the ${BILLED_AFTER_PAGE} billed, under a quarter of ${sent[1].bytes} bytes`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(spent <= CAP + 1e-12, `the run's records count $${spent} on a $${CAP} cap`);
});
