// computer_screenshot's save_as writes a file into the run's files, as the write tool writes one, so the run's gate holds
// it to write's setting too: after the computer kind's deny, the stricter of the two decides. Write's deny refuses it in
// words before the computer is asked; write's ask puts it to a person; where no one can approve, write's ask is refused.
// A screenshot with no save_as is held to the kind's setting alone, as it always was. An agent whose tools leave write
// out is refused every save_as, whatever write's setting says: leaving write out is how its owner keeps it from writing.
// The same holds for a script's computer op held as write (files.write): on a desktop that mounts the run's folder it
// writes into the run's files as save_as does, so an agent not given write is refused it too, on every shell.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMPUTER_OPS } from "@parcha/agentrun-kernel/kernel";
import { stores } from "./runner-support.mjs";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screenshot-save-gate-"));
const saved = { callId: "c-saved", tool: "computer_screenshot", args: { save_as: "shots/home.png" } };
const plain = { callId: "c-plain", tool: "computer_screenshot", args: {} };
/** `tools` null: the agent names no tools list at all. */
const gateOf = async (toolSettings, { approvers = true, tools = ["read", "write"], shell = "none", approvals = "ask" } = {}) => {
  const { server, runners } = await stores({ runners: 1 });
  if (!approvers) await server.settings.put("approvers", { approvers: false });
  return adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals, computer: { kind: "desktop", provider: "faux-desktop" }, ...(tools === null ? {} : { tools }), toolSettings } }, root(), shell, { facts: undefined });
};
const op = (name, args) => ({ callId: `c-${name}`, tool: "computer_op", args: { op: name, args } });
const PNG_WRITE = { path: "/workspace/shots/x.png", data: "iVBORw0KGgo=", encoding: "base64" };

test("every script op held as write is refused to an agent not given write or naming no tools, on a mounted desktop and on one that mounts nothing, whatever write's setting", async () => {
  const probe = await gateOf({});
  const writes = Object.keys(COMPUTER_OPS).filter((name) => probe.askedAs("computer_op", { op: name, args: {} }) === "write");
  assert.ok(writes.includes("files.write"), `files.write is held as write: ${JSON.stringify(writes)}`);
  for (const tools of [["read"], [], null]) {
    for (const shell of ["computer", "none"]) {
      for (const [approvals, toolSettings] of [["ask", {}], ["ask", { write: { permission: "allow" } }], ["never", { write: { permission: "ask" } }]]) {
        const gate = await gateOf(toolSettings, { tools, shell, approvals });
        for (const name of writes) {
          const decision = await gate(op(name, PNG_WRITE));
          const what = `${name}, tools ${JSON.stringify(tools)}, shell ${shell}, ${approvals}, ${JSON.stringify(toolSettings)}`;
          assert.equal(typeof decision, "object", `refused: ${what}`);
          assert.match(decision.deny, /not given write/, `${what}: ${decision.deny}`);
          assert.match(decision.deny, /It was not run/, decision.deny);
        }
      }
    }
  }
});

test("an agent given write still has a script's files.write decided by write's setting: allowed, asked, or refused in write's words", async () => {
  for (const shell of ["computer", "none"]) {
    assert.equal(await (await gateOf({}, { shell }))(op("files.write", PNG_WRITE)), "allow", `${shell}: write's default`);
    assert.equal(await (await gateOf({ write: { permission: "ask" } }, { shell }))(op("files.write", PNG_WRITE)), "ask", `${shell}: write's ask`);
    const denied = await (await gateOf({ write: { permission: "deny" } }, { shell }))(op("files.write", PNG_WRITE));
    assert.match(denied.deny, /write is set to deny/, `${shell}: ${denied.deny}`);
  }
});

test("an agent naming no tools list is refused a screenshot with save_as; one with no save_as runs", async () => {
  const gate = await gateOf({ desktop: { permission: "allow" }, write: { permission: "allow" } }, { tools: null });
  const decision = await gate(saved);
  assert.equal(typeof decision, "object", "refused");
  assert.match(decision.deny, /not given write/, decision.deny);
  assert.equal(await gate(plain), "allow");
});

test("an agent not given write is refused a screenshot with save_as, write's setting allow or unset, saying why; one with no save_as runs", async () => {
  for (const toolSettings of [{ desktop: { permission: "allow" } }, { desktop: { permission: "allow" }, write: { permission: "allow" } }]) {
    const gate = await gateOf(toolSettings, { tools: ["read"] });
    const decision = await gate(saved);
    assert.equal(typeof decision, "object", `refused: ${JSON.stringify(toolSettings)}`);
    assert.match(decision.deny, /not given write/, decision.deny);
    assert.match(decision.deny, /save_as/, decision.deny);
    assert.match(decision.deny, /It was not run/, decision.deny);
    assert.equal(await gate(plain), "allow", "no save_as: the desktop's allow alone");
  }
});

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

/** A run whose agent has the browser: its screenshot (the browser's registration) held to the browser's setting, and with
 *  save_as to write's too. */
const browserGateOf = async (toolSettings, { approvers = true, tools = ["read", "write", "browser"] } = {}) => {
  const { server, runners } = await stores({ runners: 1 });
  if (!approvers) await server.settings.put("approvers", { approvers: false });
  return adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", tools, toolSettings } }, root(), "none", { facts: undefined });
};
const browserSaved = { callId: "c-bsaved", tool: "screenshot", args: { save_as: "shots/walk.png" } };
const browserPlain = { callId: "c-bplain", tool: "screenshot", args: {} };

test("a browser screenshot's save_as is held to write's setting as computer_screenshot's is: not given write, write's deny and an unapprovable ask refuse it, write's ask asks; one with no save_as is the browser's alone", async () => {
  const notGiven = await (await browserGateOf({ browser: { permission: "allow" }, write: { permission: "allow" } }, { tools: ["read", "browser"] }))(browserSaved);
  assert.match(notGiven.deny, /screenshot with save_as \(it writes a file into the run's files\) needs write among this agent's tools/, notGiven.deny);
  assert.match(notGiven.deny, /It was not run/, notGiven.deny);
  const denied = await (await browserGateOf({ browser: { permission: "allow" }, write: { permission: "deny" } }))(browserSaved);
  assert.match(denied.deny, /write is set to deny for this agent/, denied.deny);
  assert.match(denied.deny, /screenshot with save_as writes a file into the run's files/, denied.deny);
  assert.equal(await (await browserGateOf({ browser: { permission: "allow" }, write: { permission: "ask" } }))(browserSaved), "ask");
  const none = await (await browserGateOf({ browser: { permission: "allow" }, write: { permission: "ask" } }, { approvers: false }))(browserSaved);
  assert.match(none.deny, /save_as/, none.deny);
  for (const [settings, tools] of [[{ browser: { permission: "allow" }, write: { permission: "deny" } }, undefined], [{ browser: { permission: "allow" } }, ["read", "browser"]]]) {
    assert.equal(await (await browserGateOf(settings, tools ? { tools } : {}))(browserPlain), "allow", `no save_as: the browser's allow alone (${JSON.stringify(settings)})`);
  }
  assert.equal(await (await browserGateOf({ browser: { permission: "allow" } }))(browserSaved), "allow", "write given and allowed");
});
