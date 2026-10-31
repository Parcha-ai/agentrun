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
  type Row = { revision: string; definition: { harness?: string } };
  const pages = (...p: Row[][]) => ({
    listRevisions: async (_agent: string, cursor?: string | null) => {
      const at = cursor ? Number(cursor) : 0;
      return { revisions: p[at]!, next_cursor: at + 1 < p.length ? String(at + 1) : null };
    },
  });
  const run = (revision: string) => ({ agent_id: "a1", revision });

  it("is the harness of the revision the run started from, not the agent's current one", async () => {
    // Newest first: the agent moved to codex after a pi run started; that run keeps pi's timing.
    const v2 = pages([{ revision: "r2", definition: { harness: "codex" } }], [{ revision: "r1", definition: { harness: "pi" } }]);
    expect(await readHarness(v2, run("r1"))).toEqual({ state: "read", id: "pi" });
    expect(await readHarness(v2, run("r2"))).toEqual({ state: "read", id: "codex" });
  });
  it("none named on that revision is the default, pi", async () => {
    expect(await readHarness(pages([{ revision: "r1", definition: {} }]), run("r1"))).toEqual({ state: "read", id: undefined });
  });
  it("is failed when the revisions cannot be read, or none is the run's, so no steer is offered", async () => {
    const failed = await readHarness({ listRevisions: async () => { throw new Error("503"); } }, run("r1"));
    expect(failed).toEqual({ state: "failed" });
    expect(mode(messageOffer(failed, caps))).not.toBe("steer");
    expect(await readHarness(pages([{ revision: "r2", definition: { harness: "pi" } }]), run("r1"))).toEqual({ state: "failed" });
  });
});
