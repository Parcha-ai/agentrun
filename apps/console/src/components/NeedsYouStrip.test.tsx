import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import type { Run } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse("2026-11-03T16:20:00Z");
const run = (id: string, agent: string, over: Partial<Run>): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: id, agent_id: agent, agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: `Run ${id}`,
  created_at: "2026-11-03T16:08:00Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, ...over,
});
const asking = [
  run("q1", "invoice", { status: "input_required", state: "waiting", title: "Check invoice INV-2310 from Contoso Freight, a new vendor.", pending: { kind: "question", question: "Which approval limit applies: the $5,000 standard or the $25,000 preferred tier?", asked_at: "2026-11-03T16:11:00Z" } }),
  run("q2", "triage", { status: "input_required", state: "waiting", title: "Triage ticket #4427", pending: { kind: "question", question: "Which product or plan was charged twice?", asked_at: "2026-11-03T16:19:30Z" } }),
];
const overloaded = { code: "run_failed" as const, message: "529 overloaded: the provider is over capacity", retryable: false };
const failed = [
  run("f1", "invoice", { status: "failed", error: overloaded, ended_at: "2026-11-03T16:10:00Z" }),
  run("f2", "triage", { status: "failed", error: overloaded, ended_at: "2026-11-03T16:09:00Z" }),
  run("f3", "scorer", { status: "failed", error: { code: "spend_cap_reached", message: "the run hit its $0.50 spend cap", retryable: false }, ended_at: "2026-11-03T16:05:00Z", title: "Score the lead: Hooli" }),
];
const live = [run("w1", "notes", { status: "working", state: "working", title: "Draft release notes for 2.15", created_at: "2026-11-03T16:17:30Z", cost: { usd: 0.0031, basis: "estimate", charge_state: null, cap_usd: null } })];
const names: Record<string, string> = { invoice: "Invoice checker", triage: "Support triage", scorer: "Lead scorer", notes: "Release notes writer" };
const base: NeedsYouProps = { asking, failed, live, agentName: (id) => names[id] ?? id, now: () => NOW, onAnswer: async () => null, onRunAgain: async (runs) => ({ started: runs.map((r) => r.run_id), problem: null }), onStop: async () => null };
const html = (p: Partial<NeedsYouProps> = {}) => renderToStaticMarkup(createElement(NeedsYouStrip, { ...base, ...p }));

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const mount = (p: Partial<NeedsYouProps> = {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(NeedsYouStrip, { ...base, ...p })));
  return host;
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("NeedsYouStrip, the runs waiting on a person", () => {
  it("heads itself with how many things need you, the questions and the failures, not the live runs", () => {
    expect(html()).toContain("Needs you");
    expect(html()).toMatch(/Needs you[^<]*<[^>]*>[^0-9]*5/);
  });
  it("shows each question with its agent, its run, how long ago it was asked, and the choices it offers", () => {
    const h = html();
    expect(h).toContain("Which approval limit applies: the $5,000 standard or the $25,000 preferred tier?");
    expect(h).toContain("Invoice checker");
    expect(h).toContain('href="#/runs/q1"');
    expect(h).toContain("asked 9 min ago");
    expect(h).toContain(">$5,000 standard<");
    expect(h).toContain(">$25,000 preferred tier<");
    // An open question offers no choices, only the answer box.
    expect(h).toContain("Which product or plan was charged twice?");
    expect(h).toContain("asked 30 s ago");
  });
  it("answers in place: a choice fills the box, Send sends it to that run, and the card says it went", async () => {
    const sent: string[] = [];
    const host = mount({ onAnswer: async (id, text) => { sent.push(`${id}: ${text}`); return null; } });
    const card = host.querySelector('[data-run="q1"]')!;
    await act(async () => { [...card.querySelectorAll("button")].find((b) => b.textContent === "$25,000 preferred tier")!.click(); });
    expect((card.querySelector("input") as HTMLInputElement).value).toBe("$25,000 preferred tier");
    await act(async () => { (card.querySelector("form") as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(sent).toEqual(["q1: $25,000 preferred tier"]);
    expect(host.querySelector('[data-run="q1"]')!.textContent).toContain("Answered: $25,000 preferred tier");
  });
  it("keeps the answer and says why when the server refuses it", async () => {
    const host = mount({ onAnswer: async () => "run_not_waiting: the run is not waiting for an answer" });
    const card = host.querySelector('[data-run="q2"]')!;
    const input = card.querySelector("input") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "The Pro plan"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { (card.querySelector("form") as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(card.textContent).toContain("run_not_waiting: the run is not waiting for an answer");
    expect(input.value).toBe("The Pro plan");
  });
});

describe("NeedsYouStrip, the failures", () => {
  it("says identical failures once, with how many runs they stopped and Run all again", () => {
    const h = html();
    expect(h).toContain("2 runs failed");
    expect(h).toContain("529 overloaded: the provider is over capacity");
    expect(h).toContain("Run all again");
    // A failure of its own keeps its run's title, its agent, and Run again.
    expect(h).toContain("Score the lead: Hooli");
    expect(h).toContain("the run hit its $0.50 spend cap");
    expect(h).toContain(">Run again<");
  });
  it("runs every run of a group again on one click, and drops the group once they started", async () => {
    const again: string[][] = [];
    const host = mount({ onRunAgain: async (runs) => { again.push(runs.map((r) => r.run_id)); return { started: runs.map((r) => r.run_id), problem: null }; } });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Run all again")!.click(); });
    await flush();
    expect(again).toEqual([["f1", "f2"]]);
    expect(host.textContent).toContain("Started again: 2 runs");
  });
});

describe("NeedsYouStrip, the live runs", () => {
  // Stop ends an agentic run's turn. A workflow run, or one not in a turn, doesn't stop (the server answers stopped:
  // false and it keeps running), so the strip doesn't offer Stop for it: it points to the run's page, where Cancel is.
  it("offers Stop only for a run that can stop, and points a workflow run to its page to cancel", () => {
    const wf = { ...live[0]!, run_id: "w2", kind: "workflow" as const, title: "Nightly invoice batch" };
    const idle = { ...live[0]!, run_id: "w3", state: "idle" as const, title: "Parked notes" };
    const h = html({ asking: [], failed: [], live: [wf, idle] });
    expect(h).not.toContain(">Stop<");
    expect(h.match(/>Open to cancel</g)).toHaveLength(2);
    expect(h).toContain('href="#/runs/w2"');
    expect(html({ asking: [], failed: [], live })).toContain(">Stop<");
  });

  it("shows each live run with how long it has worked, its cost so far, Steer (its page) and Stop", () => {
    const h = html();
    expect(h).toContain("Draft release notes for 2.15");
    expect(h).toContain("working · 2m 30s");
    expect(h).toContain("$0.0031 est. so far");
    expect(h).toContain('href="#/runs/w1"');
    expect(h).toContain(">Stop<");
    expect(html({ live: [{ ...live[0]!, cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: null } }] })).toContain("nothing spent yet");
  });
  it("shows nothing at all when no run waits, failed or works", () => {
    expect(html({ asking: [], failed: [], live: [] })).toBe("");
  });
});

describe("NeedsYouStrip, keeping track of what started and what is asked", () => {
  const render = (p: Partial<NeedsYouProps>) => act(() => root!.render(createElement(NeedsYouStrip, { ...base, ...p })));
  it("leaves the runs a refused Run all again didn't start, with the refusal, and never offers the started ones again", async () => {
    const again: string[][] = [];
    const host = mount({ onRunAgain: async (runs) => { again.push(runs.map((r) => r.run_id)); return { started: ["f1"], problem: "agent_not_runnable: the triage agent is archived" }; } });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Run all again")!.click(); });
    await flush();
    expect(host.textContent).toContain("agent_not_runnable: the triage agent is archived");
    expect(host.textContent).toContain("Started again: 1 run");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Run again" && b.closest("li")?.textContent?.includes("529"))!.click(); });
    await flush();
    expect(again).toEqual([["f1", "f2"], ["f2"]]);
  });
  it("offers Run again for a new failure with the same error, after the earlier ones started", async () => {
    const host = mount();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Run all again")!.click(); });
    await flush();
    render({ failed: [...failed, run("f9", "invoice", { status: "failed", error: overloaded, ended_at: "2026-11-03T16:15:00Z", title: "Check invoice INV-2400" })] });
    const row = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("529 overloaded"))!;
    expect(row.textContent).toContain("Check invoice INV-2400");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Run again"]);
  });
  it("shows a new question's form, never the last answer's note, when the run asks again", async () => {
    const host = mount();
    const card = () => host.querySelector('[data-run="q2"]')!;
    const input = card().querySelector("input") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "The Pro plan"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { (card().querySelector("form") as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(card().textContent).toContain("Answered: The Pro plan");
    render({ asking: [asking[0]!, { ...asking[1]!, pending: { kind: "question", question: "Was it charged in October or November?", asked_at: "2026-11-03T16:19:50Z" } }] });
    expect(card().textContent).toContain("Was it charged in October or November?");
    expect(card().textContent).not.toContain("Answered:");
    expect(card().querySelector("input")).not.toBeNull();
  });
  it("says a live run's cost is not known yet, never that nothing was spent, unless it is an explicit zero", () => {
    expect(html({ live: [{ ...live[0]!, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } }] })).toContain("cost not known yet");
    expect(html({ live: [{ ...live[0]!, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } }] })).not.toContain("nothing spent yet");
  });
  it("says a live run's cost so far and how many charges have no price yet, when the server says them", () => {
    const h = html({ live: [{ ...live[0]!, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null, so_far_usd: 0.0123, unpriced: 1 } }] });
    expect(h).toContain("so far $0.0123 est. · 1 not priced");
    expect(h).not.toContain("cost not known yet");
  });
  it("says what could not be read, and keeps what could", () => {
    const h = html({ problem: "The failed runs could not be read: Failed to fetch" });
    expect(h).toContain("The failed runs could not be read: Failed to fetch");
    expect(h).toContain("Which approval limit applies");
    expect(html({ asking: [], failed: [], live: [], problem: "The runs could not be read: Failed to fetch" })).toContain("could not be read");
  });
});

describe("NeedsYouStrip, a run paused at its spend cap", () => {
  const SAID = "Not sent: this run has spent $0.45 of its $0.50 cap, and the next step needs at least $0.03. Raise the cap to at least $0.48 to continue.";
  const paused = run("b1", "scorer", { status: "input_required", state: "waiting", title: "Score the lead: Initech", pending: { kind: "budget", cap_usd: 0.5, spent_usd: 0.45, needs_usd: 0.03, said: SAID, at: "2026-11-03T16:18:00Z" } });
  it("says why it waits, in the cap's words, with no answer form: a message to it is refused until its cap is raised", () => {
    const host = mount({ asking: [paused], failed: [], live: [] });
    const card = host.querySelector('[data-run="b1"]')!;
    expect(card.textContent).toContain(SAID);
    expect(card.textContent).toContain("Paused at its $0.50 spend cap");
    expect(card.querySelector("input, textarea, form")).toBeNull();
    expect(card.querySelector('a[href="#/runs/b1"]')).not.toBeNull();
  });
});
