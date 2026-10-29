import { describe, expect, it } from "vitest";
import { messageOffer, readHarness } from "./liveRun";
import { runState } from "./runState";

const ON = { steer: true, answer: true, follow_up: true, steer_workflow_runs: false };
const caps = { features: { messages: ON }, harnesses: [{ id: "pi", available: true }, { id: "codex", available: true, steer: false }] };
const mode = (offer: ReturnType<typeof messageOffer>) => runState("working", "working", "agentic", offer.messages, offer.steers).messageMode;

describe("messageOffer", () => {
  it("offers no message while the run's harness is not known yet", () => {
    expect(mode(messageOffer({ state: "loading" }, caps))).toBeNull();
  });
  it("once read as codex, a working run takes a follow_up, never a steer", () => {
    expect(mode(messageOffer({ state: "read", id: "codex" }, caps))).toBe("follow_up");
    expect(mode(messageOffer({ state: "read", id: "pi" }, caps))).toBe("steer");
  });
  it("fails closed: an agent that could not be read is never offered a steer", () => {
    expect(mode(messageOffer({ state: "failed" }, caps))).toBe("follow_up");
  });
  it("offers nothing without the server's capabilities", () => {
    expect(mode(messageOffer({ state: "read", id: "pi" }, null))).toBeNull();
  });
});

describe("readHarness", () => {
  it("is the agent's harness when its read succeeds (none named is the default, pi)", async () => {
    expect(await readHarness({ agentHarness: async () => "codex" }, "a1")).toEqual({ state: "read", id: "codex" });
    expect(await readHarness({ agentHarness: async () => undefined }, "a1")).toEqual({ state: "read", id: undefined });
  });
  it("is failed when the agent cannot be read, so no steer is offered", async () => {
    const failed = await readHarness({ agentHarness: async () => { throw new Error("503"); } }, "a1");
    expect(failed).toEqual({ state: "failed" });
    expect(mode(messageOffer(failed, caps))).not.toBe("steer");
  });
});
