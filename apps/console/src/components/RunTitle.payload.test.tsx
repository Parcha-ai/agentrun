import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
const run = (title: string): Run => ({ sha: null, updated_at: "2026-11-09T00:00:00Z", poll_after_ms: 0,
  run_id: "01a1a869-ce4e-7cf5-abf8-c5407893934a", agent_id: "greeter", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-09T00:14:00Z", ended_at: "2026-11-09T00:14:03Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
  trigger: { id: "trg_w", firing_key: "fir_1" },
} as Run);
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
    const host = mount(createElement(RunHeader, { run: run('<trigger-payload source="github" event="pull_request" untrusted> {"action":"opened"}'), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe("A GitHub event");
  });

  it("a caller's own title is left as it is", () => {
    const host = mount(createElement(RunHeader, { run: run("Name three primes above 100."), agentName: "Greeter" }));
    expect(host.querySelector("h1")!.textContent).toBe("Name three primes above 100.");
  });
});
