import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionLine, progressLine, replayable, ReplayRevision } from "./ReplayRevision";
import { Steps } from "./WorkflowReplay";
import { ClientError, createClient, type Client } from "@/lib/client";
import type { Promotion, ReplayRead, WorkflowRevision } from "@/lib/v2";

// The Replay button on the Learning tab's workflow card (POST/GET .../revisions/{digest}/replays): offered on a
// revision that is not serving, progress from the GET while it runs, one sentence and the score when it is decided, the
// server's own words on a 409.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

function mount(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const DIGEST = "3".repeat(16);
const read = (over: Partial<ReplayRead> = {}): ReplayRead => ({
  replay: "rp_1", workflow: "sorter", digest: DIGEST, status: "running", inputs: 5,
  outcomes: { answered: 0, handed_back: 0, failed: 0, skipped_write: 0 },
  score: { n: 0, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 }, cost_usd: null, ...over,
});
type Fake = Client & { startLearnedWorkflowReplay: ReturnType<typeof vi.fn>; learnedWorkflowReplay: ReturnType<typeof vi.fn> };
const fake = (start: () => Promise<{ replay: string; inputs: number }>, reads: ReplayRead[] | (() => Promise<ReplayRead>)): Fake => {
  let i = 0;
  const next = typeof reads === "function" ? reads : async () => reads[Math.min(i++, reads.length - 1)]!;
  return { startLearnedWorkflowReplay: vi.fn(start), learnedWorkflowReplay: vi.fn(next) } as unknown as Fake;
};
const button = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => /^Replay/.test(b.textContent ?? ""));
const text = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent;
const mountOne = (v2: Client, extra: Partial<Parameters<typeof ReplayRevision>[0]> = {}) => mount(createElement(ReplayRevision, { v2, agentId: "a", workflow: "sorter", digest: DIGEST, offered: true, pollMs: 1000, ...extra }));

describe("who is offered Replay", () => {
  it("a held, edited (not decided) or superseded revision; never one serving, served, refit, stopped or replaying", () => {
    for (const word of ["Held", "Not decided", "Superseded"] as const) expect(replayable({ word })).toBe(true);
    for (const word of ["Serving", "Served", "Refit", "Stopped", "Replaying"] as const) expect(replayable({ word })).toBe(false);
  });
  it("shows no button when it is not offered", () => {
    expect(mountOne(fake(async () => ({ replay: "rp_1", inputs: 5 }), []), { offered: false }).textContent).toBe("");
  });
});

describe("Replay on a revision", () => {
  it("posts the replay, shows its progress from the GET, and says the decision and the score when decided", async () => {
    const onDecided = vi.fn();
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), [
      read({ outcomes: { answered: 1, handed_back: 1, failed: 0, skipped_write: 0 } }),
      read({ status: "done", decided: "promote", reason: "within 2 points of the agent on its graded inputs", outcomes: { answered: 4, handed_back: 1, failed: 0, skipped_write: 0 }, score: { n: 5, agree: 5, agent_acc: 0.8, wf_acc: 0.8, delta: 0, handed_back: 1 } }),
    ]);
    const host = mountOne(v2, { onDecided });
    expect(button(host)!.textContent).toBe("Replay");
    act(() => button(host)!.click());
    expect(v2.startLearnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST);
    await flush();
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST, "rp_1");
    expect(text(host, "replay-progress")).toBe("Replaying on 5 graded inputs: 2 of 5 ended (1 answered alone, 1 handed back).");
    expect(button(host)).toBeUndefined();
    expect(onDecided).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text(host, "replay-decision")).toContain("Promoted: it serves first now. within 2 points of the agent on its graded inputs");
    expect(text(host, "replay-score")).toBe("Workflow 80% vs agent 80% on 5 graded inputs (+0 pts), 1 handed back");
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledTimes(2);
    // Decided: no more reads.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledTimes(2);
  });
  it("says a hold as still held, with the read's reason", async () => {
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "done", decided: "hold", reason: "the workflow 60.0% against the agent 80.0%", score: { n: 5, agree: 3, agent_acc: 0.8, wf_acc: 0.6, delta: -0.2, handed_back: 0 } })]);
    const host = mountOne(v2);
    act(() => button(host)!.click());
    await flush();
    expect(text(host, "replay-decision")).toContain("Still held. the workflow 60.0% against the agent 80.0%");
    expect(text(host, "replay-score")).toBe("Workflow 60% vs agent 80% on 5 graded inputs (-20 pts), 0 handed back");
    expect(button(host)!.textContent).toBe("Replay again");
  });
  it("a replay that failed says so in the read's words, and a decided one with no score says no score", async () => {
    const failed = mountOne(fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "failed", reason: "none of its runs started by its deadline: start it again" })]));
    act(() => button(failed)!.click());
    await flush();
    expect(text(failed, "replay-decision")).toBe("The replay did not finish. none of its runs started by its deadline: start it again");
    expect(failed.querySelector('[data-testid="replay-score"]')).toBeNull();
  });
  it("shows the server's words on a 409 and offers it again", async () => {
    for (const [code, message] of [["replay_conflict", "fewer than 5 of the graded inputs asked for fit this revision"], ["agent_not_runnable", "the agent is archived"]] as const) {
      const v2 = fake(async () => { throw new ClientError(409, code, message); }, []);
      const host = mountOne(v2);
      act(() => button(host)!.click());
      await flush();
      expect(text(host, "replay-refused")).toContain(message);
      expect(text(host, "replay-refused")).toContain(code);
      expect(v2.learnedWorkflowReplay).not.toHaveBeenCalled();
      expect(button(host)!.textContent).toBe("Replay again");
      act(() => root!.unmount());
    }
  });
  it("a failed read of a running replay says so and Check again reads again", async () => {
    let fail = true;
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), async () => { if (fail) throw new ClientError(503, "unavailable", "The folder is busy.", true); return read({ status: "done", decided: "hold", reason: "worse" }); });
    const host = mountOne(v2);
    act(() => button(host)!.click());
    await flush();
    expect(text(host, "replay-progress")).toContain("Couldn't read the replay: The folder is busy.");
    fail = false;
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Check again")!.click());
    await flush();
    expect(text(host, "replay-decision")).toContain("Still held. worse");
  });
  it("another revision's card starts clean", async () => {
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "done", decided: "hold", reason: "worse" })]);
    const host = mountOne(v2);
    act(() => button(host)!.click());
    await flush();
    expect(text(host, "replay-decision")).toBeDefined();
    act(() => root!.render(createElement(ReplayRevision, { v2, agentId: "a", workflow: "sorter", digest: "4".repeat(16), offered: true })));
    expect(host.querySelector('[data-testid="replay-decision"]')).toBeNull();
    expect(button(host)!.textContent).toBe("Replay");
  });
  it("keeps the decision after the tab reads again and the revision no longer offers Replay", async () => {
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "done", decided: "promote", reason: "good" })]);
    const host = mountOne(v2);
    act(() => button(host)!.click());
    await flush();
    act(() => root!.render(createElement(ReplayRevision, { v2, agentId: "a", workflow: "sorter", digest: DIGEST, offered: false })));
    expect(text(host, "replay-decision")).toContain("Promoted");
  });
});

describe("the words", () => {
  it("progress before the first read, and a decision with no reason", () => {
    expect(progressLine(null)).toBe("Replay started: its runs are queued.");
    expect(progressLine(read({ inputs: 1, outcomes: { answered: 0, handed_back: 0, failed: 1, skipped_write: 1 } }))).toBe("Replaying on 1 graded input: 2 of 1 ended (0 answered alone, 0 handed back, 1 failed, 1 skipped).");
    expect(decisionLine(read({ status: "done", decided: "promote" }))).toEqual({ text: "Promoted: it serves first now.", score: null });
  });
});

// The card: Replay shows on a held or edited revision and not on the one serving.
describe("on the workflow card", () => {
  const flow = (n: number) => JSON.stringify({ v: 2, name: "sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } }, root: { node: "chain", steps: [{ node: "extract", label: "classify", instructions: `Sort it ${n}.`, out: "Answer", as: "classify" }] } });
  const rev = (n: number): WorkflowRevision => ({ commit: String(n).repeat(40), at: new Date(Date.UTC(2026, 10, n, 14, 10)).toISOString(), by: { run: `run_${n}` }, reason: `reason ${n}`, text: flow(n), digest: String(n).repeat(16) });
  const data = { name: "sorter", revisions: [rev(1), rev(2)], total: 2, truncated: false };
  const promo = (n: number, decided: Promotion["decided"]): Promotion => ({ workflow: "sorter", digest: String(n).repeat(16), at: "2026-11-02T10:00:00Z", decided, source: "replay", reason: "r", replay: { of: [], n: 5, agree: 5, agent_acc: 0.8, wf_acc: 0.8, delta: 0, handed_back: 0, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 } } } as Promotion);
  const v2 = () => fake(async () => ({ replay: "rp_1", inputs: 5 }), [read()]);
  it("offers it on the held newest revision, not on the serving one, and an edited one with no record is offered it", () => {
    const promotions = [promo(1, "promote"), promo(2, "hold")];
    const host = mount(createElement(Steps, { data, promotions, serving: "1".repeat(16), replay: { v2: v2(), agentId: "a" } }));
    expect(button(host)).toBeDefined();
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(button(host)).toBeUndefined();
    act(() => root!.unmount());
    const edited = mount(createElement(Steps, { data, promotions: [promo(1, "promote")], serving: "1".repeat(16), replay: { v2: v2(), agentId: "a" } }));
    expect(button(edited)).toBeDefined();
  });
  it("offers none on a card with no replay wired (a read-only view)", () => {
    expect(button(mount(createElement(Steps, { data, promotions: [promo(2, "hold")] })))).toBeUndefined();
  });
});

// The client's two routes.
describe("the client", () => {
  it("posts a replay with an empty body and reads one by its id", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body });
      return new Response(JSON.stringify(init.method === "POST" ? { replay: "rp 1", inputs: 5 } : read()), { status: init.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
    });
    const client = createClient({ fetch: f as unknown as typeof fetch });
    expect(await client.startLearnedWorkflowReplay("a/b", "sorter", DIGEST)).toEqual({ replay: "rp 1", inputs: 5 });
    await client.learnedWorkflowReplay("a/b", "sorter", DIGEST, "rp 1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /v2/agents/a%2Fb/learning/workflows/sorter/revisions/${DIGEST}/replays`,
      `GET /v2/agents/a%2Fb/learning/workflows/sorter/revisions/${DIGEST}/replays/rp%201`,
    ]);
    expect(calls[0]!.body).toBe("{}");
  });
});
