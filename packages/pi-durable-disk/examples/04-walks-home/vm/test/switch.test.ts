// The switch_environment tool and its channel: no server, no model. What a host's agent depends on: a request is answered once,
// by its own id, a refusal comes back as an error result with the reason, nothing waits forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameSwitchChannel, SWITCH_TOOL, SwitchRefusedError, switchEnvironment } from "../../../03-tab-to-cloud/switch-tool.ts";
import type { SwitchRequest } from "../../../03-tab-to-cloud/switch-tool.ts";

test("a request is settled by the answer carrying its own id, and only once", async () => {
  const sent: SwitchRequest[] = [];
  const channel = new FrameSwitchChannel((f) => (sent.push(f), true));
  const first = channel.request("modal-vm", "more cores");
  const second = channel.request("daytona-gpu", "a gpu");
  assert.equal(sent.length, 2);
  assert.deepEqual({ ...sent[0]!, ask: "" }, { t: "switch", to: "modal-vm", by: "agent", reason: "more cores", ask: "" });
  assert.equal(channel.accept({ t: "switch-refused", ask: sent[1]!.ask, message: "no environment daytona-gpu" }), true);
  assert.equal(channel.accept({ t: "switch-accepted", ask: sent[0]!.ask, switchId: "sw-1" }), true);
  assert.deepEqual(await first, { switchId: "sw-1" });
  await assert.rejects(second, (e: Error) => e instanceof SwitchRefusedError && /no environment daytona-gpu/.test(e.message));
  assert.equal(channel.accept({ t: "switch-accepted", ask: sent[0]!.ask, switchId: "sw-1" }), false, "a second answer to the same request is not consumed");
  assert.equal(channel.accept({ t: "pong" }), false, "other frames are the host's");
  assert.equal(channel.accept({ t: "switch-refused", message: "a user's refusal has no ask" }), false);
});

test("a request nobody answers times out, one with no socket fails at once, and a lost socket fails the open ones", async () => {
  const slow = new FrameSwitchChannel(() => true, 30);
  await assert.rejects(slow.request("x", "y"), /did not answer/);
  const dead = new FrameSwitchChannel(() => false);
  await assert.rejects(dead.request("x", "y"), /no connection/);
  const live = new FrameSwitchChannel(() => true, 5_000);
  const open = live.request("x", "y");
  live.lose("the link closed");
  await assert.rejects(open, /the link closed/);
});

test("the tool returns the handover's id on acceptance and an error result with the reason on refusal", async () => {
  const tool = switchEnvironment({ request: async (to) => (to === "modal-vm" ? { switchId: "sw-7" } : Promise.reject(new SwitchRefusedError("no environment oops; the environments are modal-vm"))) }).tools![0]!;
  assert.equal(tool.name, SWITCH_TOOL);
  assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties).sort(), ["reason", "target"]);
  const run = (target: string) => tool.execute({ target, reason: "r" } as never, {} as never, {} as never);
  const ok = await run("modal-vm");
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.details, { switchId: "sw-7", target: "modal-vm" });
  assert.match(JSON.stringify(ok.content), /Handover sw-7/);
  const refused = await run("oops");
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /You were not moved: no environment oops; the environments are modal-vm/);
});
