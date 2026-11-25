// computer_screenshot's save_as writes a file into the run's files, as the write tool writes one, so the run's gate holds
// it to write's setting too: after the computer kind's deny, the stricter of the two decides. Write's deny refuses it in
// words before the computer is asked; write's ask puts it to a person; where no one can approve, write's ask is refused.
// A screenshot with no save_as is held to the kind's setting alone, as it always was.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stores } from "./runner-support.mjs";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screenshot-save-gate-"));
const saved = { callId: "c-saved", tool: "computer_screenshot", args: { save_as: "shots/home.png" } };
const plain = { callId: "c-plain", tool: "computer_screenshot", args: {} };
const gateOf = async (toolSettings, { approvers = true } = {}) => {
  const { server, runners } = await stores({ runners: 1 });
  if (!approvers) await server.settings.put("approvers", { approvers: false });
  return adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", computer: { kind: "desktop", provider: "faux-desktop" }, toolSettings } }, root(), "none", { facts: undefined });
};

test("write set to deny refuses a screenshot with save_as in write's words, saying why; one with no save_as runs", async () => {
  const gate = await gateOf({ desktop: { permission: "allow" }, write: { permission: "deny" } });
  const decision = await gate(saved);
  assert.equal(typeof decision, "object", "refused");
  assert.match(decision.deny, /write is set to deny for this agent/, decision.deny);
  assert.match(decision.deny, /It was not run/, decision.deny);
  assert.match(decision.deny, /save_as/, decision.deny);
  assert.equal(await gate(plain), "allow", "no save_as: the desktop's allow alone");
});

test("write set to ask puts a screenshot with save_as to a person, and where no one can approve refuses it; one with no save_as runs", async () => {
  const asks = await gateOf({ desktop: { permission: "allow" }, write: { permission: "ask" } });
  assert.equal(await asks(saved), "ask");
  assert.equal(await asks(plain), "allow");
  const none = await gateOf({ desktop: { permission: "allow" }, write: { permission: "ask" } }, { approvers: false });
  const refused = await none(saved);
  assert.equal(typeof refused, "object", "no one can approve: refused");
  assert.match(refused.deny, /save_as/, refused.deny);
});

test("the kind's own setting still holds: a desktop set to ask asks with write allowed, and a desktop set to deny refuses first, in the desktop's words", async () => {
  const asks = await gateOf({ desktop: { permission: "ask" }, write: { permission: "allow" } });
  assert.equal(await asks(saved), "ask");
  const denied = await gateOf({ desktop: { permission: "deny" }, write: { permission: "deny" } });
  const decision = await denied(saved);
  assert.match(decision.deny, /desktop/, decision.deny);
  assert.doesNotMatch(decision.deny, /write is set to deny/, "the kind's deny comes first");
});
