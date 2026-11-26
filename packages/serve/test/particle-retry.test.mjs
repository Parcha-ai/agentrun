// The real Pi durable loop must not retry Particle after an uncertain paid request. Disabling the HTTP SDK's retries
// alone is insufficient: the conversation has a separate retry policy.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { piAdapter } from "../dist/runner/adapters/pi.js";
const { heldRedactor } = await import("../dist/runner/redact.js");
import { routeOf } from "../dist/runner/model-route.js";
import { modelRetryOf } from "../dist/runner/adapter-run-spec.js";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

after(closeOpenSessions);
const KEY = `not-a-secret-${"particle"}`;
const text = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const success = () => new Response(frame(text("A retry must not reach this answer.")) + frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

for (const failure of ["503", "cut-stream"]) {
  test(`Particle in the durable Pi runner sends once after ${failure}, then fails for the caller to decide`, { timeout: 20_000 }, async (t) => {
    let calls = 0;
    const upstream = async () => {
      calls++;
      // If the loop retries, answer successfully so the test fails promptly instead of waiting through every backoff.
      if (calls > 1) return success();
      if (failure === "503") return new Response(JSON.stringify({ error: { message: "Particle service unavailable", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json" } });
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(frame(text("Partial generation"))));
        } else controller.error(new TypeError("upstream stream was interrupted"));
      } }), { headers: { "content-type": "text/event-stream" } });
    };
    const route = await routeOf("particle/particle-1", { PARTICLE_API_KEY: KEY }, "default", undefined, upstream);
    const { row } = await capRun(t, {
      specOf: () => (_claim, run) => ({
        adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: route.model, provider: route.provider, like: route.like, price: route.price, fetch: route.fetch }),
        session: { key: "root", label: "root", system: ["Answer briefly."], tools: [], context: "fresh" },
        input: "Hello.", hooks: quiet, gate: () => "allow",
        ...modelRetryOf([route]),
      }),
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      ms: 15_000,
    });
    assert.equal(calls, 1, "neither the SDK nor the durable conversation resends the request");
    assert.equal(row.state, "failed", JSON.stringify(row));
  });
}

test("a Particle tier disables automatic retries for the claim; a claim with no Particle keeps the loop defaults", () => {
  const other = { like: { reasoning: true } };
  const particle = { like: { translatedChatCompletions: true } };
  assert.deepEqual(modelRetryOf([other]), {});
  assert.deepEqual(modelRetryOf([other, particle]), { retry: { enabled: false } });
});
