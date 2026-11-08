// A replay-safe host tool (web_fetch, web_search on claude-agent and codex) is run again after a crash cut its first
// attempt: the kernel's step for the retry is `#1` or later. That first attempt may have reached its provider and been
// billed, so a deny or a refusal on the retry never says "nothing was sent and nothing was charged": it says the call
// had started and whether it took effect is not known. A first attempt keeps the plain NOT_RUN words.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools } from "../dist/host-tools.js";
import { NOT_RUN, RunGate } from "../dist/tool-gate.js";

const UNKNOWN = "It had started before the deny, and whether it took effect is not known.";
const scratch = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gate-replayed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const park = { commit: async (change) => change({ appendEntry: async () => undefined }) };

/** A codex run's gate with the server's `settings`; `approvers` false is a server with accounts off. */
async function gateOf(t, settings, approvers = true) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  return new RunGate({ root, work, data, runId: "r1", harness: "codex" }, {}, true, approvers);
}

test("a denied call on its first attempt says nothing was sent or charged; a replayed one says it may have taken effect", async (t) => {
  const gate = await gateOf(t, { web_fetch: { permission: "deny" } });
  const first = await gate.enter("web_fetch", { url: "https://a.example/" }, "c1", park);
  assert.equal(first?.text, `Permission denied: web_fetch is set to deny on this server. ${NOT_RUN} Don't retry it.`);
  const replayed = await gate.enter("web_fetch", { url: "https://a.example/" }, "c1", park, { replayed: true });
  assert.equal(replayed?.text, `Permission denied: web_fetch is set to deny on this server. ${UNKNOWN} Don't retry it.`);
  assert.ok(!replayed.text.includes("nothing was charged"), "never the NOT_RUN claim on a replay");
});

test("with no one to approve (accounts off), an asked call's refusal on a replay makes no 'nothing was charged' claim either", async (t) => {
  const gate = await gateOf(t, { web_fetch: { permission: "ask" } }, false);
  const first = await gate.enter("web_fetch", { url: "https://a.example/" }, "c1", park);
  assert.ok(first?.text.endsWith(NOT_RUN), first?.text);
  const replayed = await gate.enter("web_fetch", { url: "https://a.example/" }, "c1", park, { replayed: true });
  assert.ok(!replayed.text.includes("nothing was charged") && replayed.text.endsWith(UNKNOWN), replayed.text);
});

test("a host tool tells the gate the call is a replay when the kernel's attempt is above 0, and not otherwise", async () => {
  const seen = [];
  const gate = { enter: async (_name, _args, _callId, _park, options = {}) => (seen.push(options.replayed === true), { text: "refused", isError: true }) };
  const [tool] = hostTools({ claim: { work: "/nonexistent/work" } }, ["web_fetch"], ctx, new Map(), undefined, { gate, park });
  const signal = new AbortController().signal;
  await tool.call({ url: "https://a.example/" }, { callId: "c1", signal });
  await tool.call({ url: "https://a.example/" }, { callId: "c1", signal, attempt: 0 });
  await tool.call({ url: "https://a.example/" }, { callId: "c1", signal, attempt: 1 });
  assert.deepEqual(seen, [false, false, true]);
});
