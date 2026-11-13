// B2c: a pi session whose open fails after its model proxy started (the claim lost mid-open, as a busy runner's renew
// can) leaves no proxy listening. Found by runner-live-batch's 300 loops: each open that failed on "claim lost" kept its
// proxy's server open, so the runner's process held a listening socket per failed open and never exited.
import assert from "node:assert/strict";
import { test } from "node:test";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");

/** Servers listening in this process now. */
const listening = () => process._getActiveHandles().filter((handle) => handle?.constructor?.name === "Server" && handle.listening).length;

test("a pi session whose open fails after its proxy started leaves no proxy listening", async () => {
  // The run as the adapter loop lends it, with a Harness whose root refuses: the claim was lost while the session opened.
  const run = {
    harness: { root: async () => Promise.reject(new Error("claim lost (not-renewed)")) },
    registry: { install: () => {} },
    setModels: () => {},
  };
  const adapter = piAdapter({
    run,
    model: "claude-sonnet-4-5",
    provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` },
    fetch: async () => new Response("{}", { status: 500 }),
    price: () => 0,
  });
  const before = listening();
  const io = { writer: {}, models: {}, signal: new AbortController().signal, onEvent: () => {} };
  const spec = { key: "root", label: "root", system: [], tools: [], context: "fresh" };
  await assert.rejects(adapter.open(spec, io), /claim lost/);
  assert.equal(listening(), before, "the failed open closed its proxy");
});
