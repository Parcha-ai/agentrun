import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionLine, progressLine, replayable, ReplayRevision } from "./ReplayRevision";
import { Steps, WorkflowReplay } from "./WorkflowReplay";
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
  it("a held or edited (not decided) revision; never one serving, served, stopped or replaying", () => {
    for (const word of ["Held", "Not decided"] as const) expect(replayable({ word })).toBe(true);
    for (const word of ["Serving", "Served", "Stopped", "Replaying"] as const) expect(replayable({ word })).toBe(false);
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
      read({ status: "done", decided: "promote", reason: "it answered alone on the inputs of the agent's own runs and said what the agent said", outcomes: { answered: 4, handed_back: 1, failed: 0, skipped_write: 0 }, score: { n: 5, agree: 5, agent_acc: 0.8, wf_acc: 0.8, delta: 0, handed_back: 1 } }),
    ]);
    const host = mountOne(v2, { onDecided });
    expect(button(host)!.textContent).toBe("Replay");
    act(() => button(host)!.click());
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.querySelector("button")!.textContent).toBe("Starting…");
    await flush();
    expect(v2.startLearnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST);
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST, "rp_1");
    expect(text(host, "replay-progress")).toBe("Checking on 5 inputs of the agent's own runs: 2 of 5 ended (1 answered alone, 1 handed back).");
    expect(button(host)).toBeUndefined();
    expect(onDecided).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text(host, "replay-decision")).toContain("Promoted: it serves first now. It answered alone on the inputs of the agent's own runs and said what the agent said");
    expect(text(host, "replay-score")).toBe("Workflow 80% vs agent 80% on 5 inputs of the agent's own runs, 5 said what the agent said, 1 handed back");
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
    expect(text(host, "replay-decision")).toContain("Still held. The workflow 60.0% against the agent 80.0%");
    expect(text(host, "replay-score")).toBe("Workflow 60% vs agent 80% on 5 inputs of the agent's own runs, 3 said what the agent said, 0 handed back");
    expect(button(host)!.textContent).toBe("Replay again");
  });
  it("a replay that failed says so in the read's words, and a decided one with no score says no score", async () => {
    const failed = mountOne(fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "failed", reason: "none of its runs started by its deadline: start it again" })]));
    act(() => button(failed)!.click());
    await flush();
    expect(text(failed, "replay-decision")).toBe("The replay did not finish. None of its runs started by its deadline: start it again");
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
    expect(text(host, "replay-decision")).toContain("Still held. Worse");
  });
  it("follows a replay already running (the record's replay_id) without a click, and decides it", async () => {
    const onDecided = vi.fn();
    const v2 = fake(async () => ({ replay: "unused", inputs: 0 }), [read({ replay: "rp_9", outcomes: { answered: 2, handed_back: 0, failed: 0, skipped_write: 0 } }), read({ replay: "rp_9", status: "done", decided: "promote", reason: "good" })]);
    const host = mountOne(v2, { offered: false, resume: "rp_9", onDecided });
    await flush();
    expect(v2.startLearnedWorkflowReplay).not.toHaveBeenCalled();
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST, "rp_9");
    expect(text(host, "replay-progress")).toContain("2 of 5 ended");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text(host, "replay-decision")).toContain("Promoted");
    expect(onDecided).toHaveBeenCalledTimes(1);
  });
  it("follows a replay whose id arrives after the card mounted idle (a reload: revisions before promotions)", async () => {
    const onDecided = vi.fn();
    const v2 = fake(async () => ({ replay: "unused", inputs: 0 }), [read({ replay: "rp_9", outcomes: { answered: 2, handed_back: 0, failed: 0, skipped_write: 0 } }), read({ replay: "rp_9", status: "done", decided: "promote", reason: "good" })]);
    const host = mountOne(v2, { offered: true, resume: null, onDecided });
    await flush();
    expect(v2.learnedWorkflowReplay).not.toHaveBeenCalled();
    act(() => root!.render(createElement(ReplayRevision, { v2, agentId: "a", workflow: "sorter", digest: DIGEST, offered: false, resume: "rp_9", onDecided, pollMs: 1000 })));
    await flush();
    expect(v2.learnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", DIGEST, "rp_9");
    expect(text(host, "replay-progress")).toContain("2 of 5 ended");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(text(host, "replay-decision")).toContain("Promoted");
    expect(onDecided).toHaveBeenCalledTimes(1);
  });
  it("keeps the decision after the tab reads again and the revision no longer offers Replay", async () => {
    const v2 = fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "done", decided: "promote", reason: "good" })]);
    const host = mountOne(v2);
    act(() => button(host)!.click());
    await flush();
    act(() => root!.render(createElement(ReplayRevision, { v2, agentId: "a", workflow: "sorter", digest: DIGEST, offered: false })));
    expect(text(host, "replay-decision")).toContain("Promoted");
    expect(button(host)).toBeUndefined();
  });
});

describe("the words", () => {
  it("progress before the first read, and a decision with no reason", () => {
    expect(progressLine(null)).toBe("Replay started: its runs are queued.");
    expect(progressLine(read({ inputs: 1, outcomes: { answered: 0, handed_back: 0, failed: 1, skipped_write: 1 } }))).toBe("Checking on 1 input of the agent's own runs: 2 of 1 ended (0 answered alone, 0 handed back, 1 failed, 1 skipped).");
    expect(decisionLine(read({ status: "done", decided: "promote" }))).toEqual({ text: "Promoted: it serves first now.", score: null });
  });
});

// The card: Replay shows on a held or edited revision and not on the one serving.
describe("on the workflow card", () => {
  const flow = (n: number) => JSON.stringify({ v: 2, name: "sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } }, root: { node: "chain", steps: [{ node: "extract", label: "classify", instructions: `Sort it ${n}.`, out: "Answer", as: "classify" }] } });
  const rev = (n: number): WorkflowRevision => ({ commit: String(n).repeat(40), at: new Date(Date.UTC(2026, 10, n, 14, 10)).toISOString(), by: { run: `run_${n}` }, reason: `reason ${n}`, text: flow(n), digest: String(n).repeat(16) });
  const data = { name: "sorter", revisions: [rev(1), rev(2)], total: 2, truncated: false };
  const promo = (n: number, decided: Promotion["decided"]): Promotion => ({ workflow: "sorter", digest: String(n).repeat(16), at: "2026-11-02T10:00:00Z", decided, reason: "r", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [], outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 } } } as Promotion);
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
  it("a revision replaying follows its record's replay, and stepping to another revision and back starts clean", async () => {
    const replaying = { ...promo(2, "replaying"), replay_id: "rp_7" } as Promotion;
    const client = fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ replay: "rp_7" })]);
    const host = mount(createElement(Steps, { data, promotions: [promo(1, "promote"), replaying], serving: "1".repeat(16), replay: { v2: client, agentId: "a" } }));
    await flush();
    expect(client.learnedWorkflowReplay).toHaveBeenCalledWith("a", "sorter", "2".repeat(16), "rp_7");
    expect(text(host, "replay-progress")).toContain("Checking on 5 inputs of the agent's own runs");
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="replay-revision"]')).toBeNull();
  });
  it("tells the tab when a replay starts (so stepping away and back finds its record), and reads the revisions again when it is decided", async () => {
    const client = Object.assign(fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ status: "done", decided: "hold", reason: "worse" })]), { learnedWorkflowRevisions: vi.fn(async () => data) });
    const onReplayed = vi.fn();
    const host = mount(createElement(WorkflowReplay, { v2: client, agentId: "a", workflows: [{ name: "sorter", status: "active" }], promotions: [promo(1, "promote"), promo(2, "hold")], serving: [{ workflow: "sorter", digest: "1".repeat(16), replaying: null, state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0, champion: null }], onReplayed }));
    await flush();
    expect(client.learnedWorkflowRevisions).toHaveBeenCalledTimes(1);
    act(() => button(host)!.click());
    await flush();
    expect(client.startLearnedWorkflowReplay).toHaveBeenCalledTimes(1);
    expect(onReplayed).toHaveBeenCalledTimes(2);
    expect(client.learnedWorkflowRevisions).toHaveBeenCalledTimes(2);
  });
  it("a replay of an older revision keeps its decision on screen when the revisions are read again (the card stays on that revision)", async () => {
    const client = Object.assign(fake(async () => ({ replay: "rp_1", inputs: 5 }), [read({ digest: "1".repeat(16), status: "done", decided: "hold", reason: "worse" })]), { learnedWorkflowRevisions: vi.fn(async () => ({ ...data, revisions: [...data.revisions] })) });
    const host = mount(createElement(WorkflowReplay, { v2: client, agentId: "a", workflows: [{ name: "sorter", status: "active" }], promotions: [promo(1, "hold"), promo(2, "promote")], serving: [{ workflow: "sorter", digest: "2".repeat(16), replaying: null, state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0, champion: null }] }));
    await flush();
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    act(() => button(host)!.click());
    await flush();
    expect(client.learnedWorkflowRevisions).toHaveBeenCalledTimes(2);
    expect(text(host, "replay-decision")).toContain("Still held");
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
