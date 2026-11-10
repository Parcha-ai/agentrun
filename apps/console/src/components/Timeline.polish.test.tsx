import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (over: Partial<TimelineRow>): TimelineRow => ({
  id: "1", seq: 1, kind: "thinking", summary: "", text: null, timestamp: "2026-11-01T00:00:00Z", tool_name: null, created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...over,
});
const open = (rows: TimelineRow[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<Timeline rows={rows} live={false} />));
  return host;
};
/** The words a step's line shows (the line under its label). */
const line = (host: HTMLElement) => host.querySelector("li button > span > span:nth-child(2)")!;

// A run's steps read in words: a model's bold heading and a command in backticks show as bold and code, never as the
// marks typed. Nothing else of Markdown is read, and no HTML gets through.
describe("Timeline, a step's own bold and code", () => {
  it("shows **bold** as bold and `code` as code, without the marks", () => {
    const host = open([row({ summary: "Thinking: **Plan** first, then `npm test`" })]);
    expect(line(host).querySelector("strong")?.textContent).toBe("Plan");
    expect(line(host).querySelector("code")?.textContent).toBe("npm test");
    expect(line(host).textContent).toBe("Plan first, then npm test");
  });

  it("reads code inside bold as code, as a model's heading writes it", () => {
    const host = open([row({ summary: "**Run `npm test` first**" })]);
    expect(line(host).querySelector("strong code")?.textContent).toBe("npm test");
  });

  it("keeps HTML as text, a lone mark as typed, and __dunder__ names as they are", () => {
    const host = open([row({ summary: "<img src=x onerror=alert(1)> a ** b in __init__.py" })]);
    expect(host.querySelector("img")).toBeNull();
    expect(line(host).querySelector("strong")).toBeNull();
    expect(line(host).textContent).toBe("<img src=x onerror=alert(1)> a ** b in __init__.py");
  });

  it("an answer's first line drops its heading mark and shows its bold", () => {
    const host = open([row({ kind: "final_answer", summary: "## **Done**: all checks pass", text: "## **Done**: all checks pass\n\nDetails follow." })]);
    expect(line(host).querySelector("strong")?.textContent).toBe("Done");
    expect(line(host).textContent).toBe("Done: all checks pass…");
  });

  it("an answer the agent left empty says so, not a blank step", () => {
    const host = open([row({ kind: "final_answer", summary: "", text: "  \n" })]);
    expect(line(host).textContent).toBe("The agent finished without writing an answer.");
  });
});

// The fold above the newest steps counts in words: one is "1 earlier step".
describe("Timeline, the fold's count", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row({ id: `t${i}`, seq: i, summary: `Thinking: step ${i}` }));
  it("one hidden step: 1 earlier step", () => {
    expect(open(many(7)).textContent).toContain("1 earlier step");
    expect(document.body.textContent).not.toContain("1 earlier steps");
  });
  it("more: N earlier steps", () => {
    expect(open(many(9)).textContent).toContain("3 earlier steps");
  });
});

// Your message of several lines reads its first line and "…", as an answer does; the whole message opens under it.
describe("Timeline, your message of several lines", () => {
  it("reads its first line and …", () => {
    const host = open([row({ kind: "user_message", summary: "You: Check invoice INV-2291.", text: "Check invoice INV-2291.\nUse the March rates." })]);
    expect(line(host).textContent).toBe("Check invoice INV-2291.…");
  });
  it("a one-line message reads as it is", () => {
    const host = open([row({ kind: "user_message", summary: "You: Check invoice INV-2291.", text: "Check invoice INV-2291." })]);
    expect(line(host).textContent).toBe("Check invoice INV-2291.");
  });
  it("a workflow run's input keeps its field list", () => {
    const host = open([row({ kind: "user_message", summary: "You: {\"invoice\":\"INV-2291\",\"rate\":\"March\"}", text: "{\"invoice\":\"INV-2291\",\"rate\":\"March\"}" })]);
    expect(line(host).textContent).toBe("invoice: INV-2291 · rate: March");
  });
});
