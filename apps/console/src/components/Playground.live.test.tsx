import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LiveRun } from "./LiveRun";
import { Playground } from "./Playground";
import type { Agent } from "@/lib/agentForm";
import type { Run, TimelinePage, TimelineRow } from "@/lib/v2";

// The playground follows the run it started: the same reads as the run page (the run, its timeline from the cursor),
// until the run ends, and again after a follow-up, so its messages, steps and answer show where the request was sent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { agent_id: "calc", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } } as Agent;
const caps = { harnesses: [{ id: "pi", available: true, steer: true }], features: { messages: { steer: true, answer: true, follow_up: true, steer_workflow_runs: false } } };
const row = (seq: number, kind: string, text: string): TimelineRow => ({ id: `r${seq}`, seq, kind, summary: text, text, timestamp: "2026-10-30T03:40:00Z", tool_name: null } as TimelineRow);

/** A faux server: the run completes on the third timeline poll; a follow-up adds its own turn, answered at once. */
function fauxServer() {
  let polls = 0;
  let turns = 1;
  const rows = () => {
    const out = [row(1, "user_message", "What is six times seven?")];
    if (polls >= 3) out.push(row(2, "final_answer", "The answer is 42."));
    if (turns > 1) out.push(row(3, "user_message", "And eight times nine?"), row(4, "final_answer", "Eight times nine is 72."));
    return out;
  };
  const done = () => polls >= 3;
  const run = (): Run => ({
    run_id: "run1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: done() ? "completed" : "working", state: done() ? "idle" : "working",
    title: "What is six times seven?", created_at: "2026-10-30T03:40:00Z", ended_at: done() ? "2026-10-30T03:40:03Z" : null,
    result: done() ? { final_answer: turns > 1 ? "Eight times nine is 72." : "The answer is 42." } : null, error: null, cost: null, archived_at: null,
  });
  const v2 = {
    getRun: async () => run(),
    listFiles: async () => ({ files: [] }),
    readFile: async () => "",
    listRevisions: async () => ({ revisions: [{ revision: "rv1", definition: { harness: "pi" } }], next_cursor: null }),
    getTimeline: async (): Promise<TimelinePage> => {
      polls++;
      const r = done();
      return { run_id: "run1", status: r ? "completed" : "working", state: r ? "idle" : "working", reset: false, rows: rows(), drop: [], next_after: rows().length, unchanged: false, has_more: false, final: r, cost: null, poll_after_ms: 0 } as unknown as TimelinePage;
    },
    sendMessage: async () => { turns++; return {}; },
    stop: async () => ({}), cancel: async () => ({}),
  };
  return { v2, polls: () => polls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const until = async (ok: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out; page reads: ${document.body.textContent?.slice(0, 400)}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
};
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (label: RegExp) => { const b = [...document.querySelectorAll("button")].find((x) => label.test((x.textContent ?? "").trim())); if (!b) throw new Error(`no button ${label}; buttons: ${[...document.querySelectorAll("button")].map((x) => JSON.stringify(x.textContent)).join(", ")}`); return b; };

describe("Playground, after Send", { timeout: 15000 }, () => {
  it("follows the run it started until it ends, shows its answer, and shows a follow-up's own turn", async () => {
    const server = fauxServer();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, {
      agents: [agent], efforts: ["low"], origin: "http://serve.test", agentId: "calc",
      onSend: async () => ({ status: 202, ms: 5, body: { run_id: "run1" }, runId: "run1" }),
      live: (id: string) => createElement(LiveRun, { v2: server.v2 as never, runId: id, caps, agentName: () => "Calc" }),
    })));
    act(() => type(document.querySelector("textarea")!, "What is six times seven?"));
    await act(async () => { button(/send request/i).click(); });
    await until(() => (document.body.textContent ?? "").includes("The answer is 42."));
    expect(server.polls()).toBeGreaterThanOrEqual(3);
    // A follow-up from the playground continues the same run, and its own turn shows there.
    await until(() => !!document.querySelector('textarea[placeholder^="Ask a follow-up"]'));
    act(() => type(document.querySelector('textarea[placeholder^="Ask a follow-up"]') as HTMLTextAreaElement, "And eight times nine?"));
    await act(async () => { button(/^send$/i).click(); });
    await until(() => (document.body.textContent ?? "").includes("Eight times nine is 72."));
  });
});
