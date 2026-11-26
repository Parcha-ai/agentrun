// What a host tool streams while it runs (its `output` chunks, pi's api.output) is the text pi's tool slot keeps, and the
// one result pi writes WITHOUT its afterTool hook, for a call cut off its restart limit times (pi-durable
// harness/tool.js endCutOff, and abort's last attempt: settleFromSlot with no hooks, the result built from the slot by
// fromSlot), is that text as it is. So piTool holds what it streams to pi to the same per-model bound as a result
// (boundedProgress, at the kernel's resultMaxChars for the calling agent's model): the slot, and so that result, never
// carries more than the model's share of its window, nor more than the host's bound with no window known. Pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { resultMaxChars } from "@parcha/agentrun-kernel/process";

const { boundedProgress } = await import("../dist/runner/adapters/pi.js");

/** What `max` lets through of `chunks` streamed one by one: the chunks forwarded, joined. */
function streamed(max, chunks) {
  const forwarded = [];
  const push = boundedProgress((chunk) => forwarded.push(chunk), max);
  for (const chunk of chunks) push(chunk);
  return { text: forwarded.join(""), count: forwarded.length };
}

/** 2 MB streamed in 64 KB chunks, its start marked. */
const HUGE = ["START-OF-OUTPUT ", ...Array.from({ length: 32 }, () => "x".repeat(65_536))];

test("a 16k model: a host tool's 2 MB of live output reaches pi's slot within the per-model bound, its start kept, saying it was cut", () => {
  // MUTATION: a piTool that forwards every chunk (no bound on api.output) leaves the slot, and the result pi writes past its
  // restart limit, at pi's own 360 KB.
  const max = resultMaxChars({ contextWindow: 16_384 });
  const { text } = streamed(max, HUGE);
  assert.ok(text.length <= max, `${text.length} characters, past ${max}`);
  assert.ok(text.startsWith("START-OF-OUTPUT x"), "its start kept");
  assert.match(text, /\n\[live output cut at \d+ characters: the rest is not kept, past what this model's context window takes\]$/);
});

test("no window known: the live output is held to the host's bound", () => {
  const { text } = streamed(resultMaxChars(), HUGE);
  assert.ok(text.length <= HOST_RESULT_MAX_CHARS, `${text.length} characters, past ${HOST_RESULT_MAX_CHARS}`);
  assert.ok(text.startsWith("START-OF-OUTPUT x"));
});

test("output within the bound passes chunk for chunk, unchanged", () => {
  const chunks = ["one\n", "two\n", "three"];
  const { text, count } = streamed(resultMaxChars({ contextWindow: 16_384 }), chunks);
  assert.equal(text, "one\ntwo\nthree");
  assert.equal(count, 3);
});

test("a window too small for any of it: nothing of the output passes", () => {
  const max = resultMaxChars({ contextWindow: 100 });
  const { text } = streamed(max, HUGE);
  assert.ok(text.length <= max, `${text.length} characters, past ${max}`);
  assert.ok(!text.includes("xxxx"), text);
});

test("a character written as a surrogate pair is never split where the output is cut", () => {
  const max = resultMaxChars({ contextWindow: 16_384 });
  for (let lead = 0; lead < 3; lead += 1) {
    const { text } = streamed(max, ["a".repeat(lead), ..."😀".repeat(20_000).match(/.{1,1001}/gsu)]);
    const kept = text.replace(/\n\[live output cut at .*\]$/, "");
    assert.ok(!/[\uD800-\uDBFF]$/.test(kept), `no lone high surrogate at the cut (lead ${lead})`);
    assert.ok(text.length <= max);
  }
});
