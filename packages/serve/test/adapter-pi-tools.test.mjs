// pi on the runner offers its model the session's tools: through the real loop and the session's model proxy, the request
// the provider gets carries each of the host's tools by its own name, and the proxy's policy reads that request as the
// turn's answer request (an answer request's content-filter stop ends the turn; a side call's does not).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";

const { piAdapter, piPolicy } = await import("../dist/runner/adapters/pi.js");
after(closeOpenSessions);

const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` };
const tools = {
  note: { name: "note", replaySafe: true, run: async () => "noted" },
  read: { name: "read", replaySafe: true, run: async () => "read" },
};

test("pi's tool definitions reach the provider: the request the provider gets offers each of the session's tools by its own name, and it is the turn's answer request", async (t) => {
  const sent = [];
  const { row } = await capRun(t, {
    specOf: () => (_claim, run) => ({
      adapter: piAdapter({ run, model: MODEL, provider, fetch: scriptedOrigin([{ call: "note" }, { say: "done" }], sent), price: () => 0 }),
      session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
      input: "Follow the script.",
      hooks: quiet,
      gate: () => "allow",
    }),
    beforeRequest: () => undefined,
  });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(sent.length, 2, "the call's round and the answer's");
  for (const [i, body] of sent.entries()) {
    assert.deepEqual((body.tools ?? []).map((tool) => tool.name).sort(), ["note", "read"], `request ${i} offers the session's tools`);
  }
  // The session's own policy, on the very body the provider got: the turn's request, never a side call.
  assert.equal(piPolicy(MODEL, ["note", "read"]).answers(sent[0]), true, "the turn's answer request");
});
