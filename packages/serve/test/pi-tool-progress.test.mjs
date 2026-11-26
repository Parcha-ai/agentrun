// The wiring of boundedProgress into piTool: a host tool's live output reaches pi (api.output, which pi-durable's tool task
// pushes into the call's OutputBuffer, the slot it writes a cut-off call's result from past its restart limit, with no
// hooks) held to the per-model bound for the calling agent's model. piTool's execute is called as pi's tool task calls it
// (defineTool returns the tool as given): its api a stand-in that records each chunk api.output receives. Pure: no pi
// loop, no model, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";

const { piTool } = await import("../dist/runner/adapters/pi.js");

/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;

/** A host tool that streams 2 MB through its context's `output`, in 64 KB chunks, its start marked; and answers "done". */
const streaming = {
  name: "stream",
  description: "Streams two megabytes.",
  inputSchema: { type: "object", properties: {} },
  replay: "safe",
  call: async (_args, context) => {
    context.output("START-OF-OUTPUT ");
    for (let i = 0; i < 32; i += 1) context.output("x".repeat(65_536));
    return { text: "done" };
  },
};

/** What api.output received of one call of `streaming` through piTool, the calling agent's model's window `window`. */
async function reachedPi(window) {
  const io = { onEvent() {}, signal: new AbortController().signal };
  const tool = piTool(streaming, io, undefined, undefined, undefined, () => window);
  const chunks = [];
  const api = {
    callId: "call-1",
    agent: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
    models: { getModel: () => undefined },
    output: (chunk) => void chunks.push(chunk),
  };
  const result = await tool.execute({}, api, {});
  assert.equal(result.output[0].text, "done", "the answer itself is untouched");
  return chunks.join("");
}

test("piTool, a 16k model: what a host tool streams reaches pi's output within the per-model bound, saying it was cut", async () => {
  // MUTATION: a piTool that hands the tool `(chunk) => api.output(chunk)` (boundedProgress unwired) passes all 2 MB here.
  const text = await reachedPi(16_384);
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  assert.ok(text.startsWith("START-OF-OUTPUT x"), "its start kept");
  assert.match(text, /\n\[live output cut at \d+ characters: the rest is not kept, past what this model's context window takes\]$/);
});

test("piTool, no window known: what a host tool streams reaches pi within the host's bound", async () => {
  const text = await reachedPi(undefined);
  assert.ok(text.length <= HOST_RESULT_MAX_CHARS, `${text.length} characters, past ${HOST_RESULT_MAX_CHARS}`);
  assert.ok(text.startsWith("START-OF-OUTPUT x"));
});
