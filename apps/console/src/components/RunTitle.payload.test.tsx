import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LatestRun } from "./LatestRun";
import { NeedsYouStrip } from "./NeedsYouStrip";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import type { Run } from "@/lib/v2";

// A run a webhook (or GitHub) trigger started has the trigger's input and then the request's payload as its input, the
// payload inside <trigger-payload … untrusted> (serve's triggers.ts). Its title is the input's line: the runs list and the
// run's header say the trigger's words, never the wrapper or the payload, which stay readable on the Timeline.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const WRAPPED = 'Say hello. <trigger-payload source="webhook" scheme="standard" untrusted> {"event":"lead.created","lead":{"name":"Ada"}} </trigger-payload>';
// A long payload: the served title is cut before the wrapper closes.
const CUT = 'Say hello. <trigger-payload source="webhook" scheme="standard" untrusted> {"eve';
const run = (title: string, over: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-09T00:00:00Z", poll_after_ms: 0,
  run_id: "01a1a869-ce4e-7cf5-abf8-c5407893934a", place: { mode: "runner" }, agent_id: "greeter", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-09T00:14:00Z", ended_at: "2026-11-09T00:14:03Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
  trigger: { id: "trg_w", firing_key: "fir_1" }, ...over,
} as Run);
// The server's title rule (runs.ts): whitespace runs made one space, then clipped to 80 with an ellipsis (clip).
const served = (input: string) => { const t = input.trim().replace(/\s+/g, " "); return t.length > 80 ? `${t.slice(0, 79)}…` : t; };
const mount = (el: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};

describe("a triggered run's title", () => {
  it("in the runs list, is the trigger's input line, not the payload's wrapper", () => {
    const host = mount(createElement(RunsList, { runs: [run(WRAPPED), run(CUT)], agentName: (id: string) => id, onOpen: () => {} }));
    const titles = [...host.querySelectorAll("span.line-clamp-2")].map((s) => s.textContent);
    expect(titles).toEqual(["Say hello.", "Say hello."]);
    expect(host.textContent).not.toContain("trigger-payload");
  });

  it("in the run's header, the same", () => {
    const host = mount(createElement(RunHeader, { run: run(CUT), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe("Say hello.");
    expect(host.textContent).not.toContain("trigger-payload");
  });

  it("a trigger with no input of its own: its kind's words, not an empty title", () => {
    // A GitHub delivery comes in as the webhook source, its scheme github (serve's triggers.ts and trigger-signatures.ts).
    const github = mount(createElement(RunHeader, { run: run('<trigger-payload source="webhook" scheme="github" event="pull_request" action="opened" untrusted> {"action":"opened"}'), agentName: "Greeter" }));
    expect(github.querySelector("h1")!.textContent).toBe("A GitHub event");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const hook = mount(createElement(RunHeader, { run: run('<trigger-payload source="webhook" scheme="standard" untrusted> {"event":"lead.created"}'), agentName: "Greeter" }));
    expect(hook.querySelector("h1")!.textContent).toBe("A webhook request");
  });

  it("a caller's own title is left as it is", () => {
    const host = mount(createElement(RunHeader, { run: run("Name three primes above 100."), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe("Name three primes above 100.");
  });

  it("a title the server clipped inside the wrapper's tag name still reads as the input alone", () => {
    const input = "Qualify the inbound lead and draft a reply to the sender, briefly, by noon.";
    const title = served(`${input}\n\n<trigger-payload source="webhook" scheme="standard" untrusted>\n{"event":"lead.created"}\n</trigger-payload>`);
    expect(title).toMatch(/<tr…$/);
    const host = mount(createElement(RunHeader, { run: run(title), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe(input);
  });

  it("a run no trigger started keeps its title, wrapper-like text and all", () => {
    const host = mount(createElement(RunHeader, { run: run("Explain <trigger-payload> tags.", { trigger: null }), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe("Explain <trigger-payload> tags.");
  });

  it("the needs-you strip's waiting, failed and working runs, and an agent's latest run, say the input alone", () => {
    const waiting = run(WRAPPED, { run_id: "q1", place: { mode: "runner" }, status: "input_required", state: "waiting", pending: { kind: "question", question: "Which lead?", asked_at: "2026-11-09T00:14:01Z" } } as Partial<Run>);
    const failed = run(WRAPPED, { run_id: "f1", place: { mode: "runner" }, status: "failed", error: { code: "run_failed", message: "it failed", retryable: false } });
    const working = run(WRAPPED, { run_id: "w1", place: { mode: "runner" }, status: "working", state: "working", ended_at: null });
    const strip = mount(createElement(NeedsYouStrip, { asking: [waiting], failed: [failed], live: [working], agentName: (id: string) => id, now: () => Date.parse("2026-11-09T00:15:00Z"), onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null }));
    expect(strip.textContent).toContain("Say hello.");
    expect(strip.textContent).not.toContain("trigger-payload");
    act(() => root?.unmount()); document.body.innerHTML = "";
    // Its reads never answer here: the row shows from the run it is given.
    const v2 = new Proxy({}, { get: () => () => new Promise(() => {}) });
    const latest = mount(createElement(LatestRun, { v2: v2 as never, run: run(WRAPPED), onRun: () => {} }));
    expect(latest.textContent).toContain("Say hello.");
    expect(latest.textContent).not.toContain("trigger-payload");
    expect(latest.querySelector("a[title]")!.getAttribute("title")).toBe("Say hello.");
  });
});
