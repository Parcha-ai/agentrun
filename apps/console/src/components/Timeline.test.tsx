import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (over: Partial<TimelineRow>): TimelineRow => ({
  id: "1", seq: 1, kind: "tool_result", summary: "", text: null, timestamp: "2026-11-01T00:00:00Z", tool_name: null, ...over,
});
const html = (r: TimelineRow) => renderToStaticMarkup(<Timeline rows={[r]} live={false} />);

describe("Timeline, a tool result", () => {
  it("reads as failed when the call failed", () => {
    const h = html(row({ tool_name: "fetch", tool_status: "failed", summary: "fetch failed: timeout" }));
    expect(h).toContain("border-destructive");
    expect(h).toMatch(/>Error</);
  });
  it("does not when it succeeded", () => {
    const h = html(row({ tool_name: "fetch", tool_status: "success", summary: "fetch: ok" }));
    expect(h).not.toContain("border-destructive");
    expect(h).not.toMatch(/>Error</);
  });
});

describe("Timeline, a decision", () => {
  it("is labelled Decision with its own icon, and opens to its sources and refused questions", () => {
    const text = "Registry https://example.com/coi\nrefused: is_sanctioned";
    const r = row({ id: "decision:d1:0", kind: "decision", summary: "coi (jev): is_coi yes 0.92", agent_label: "coi", text, tool_status: null });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    act(() => root!.render(<Timeline rows={[r]} live={false} />));
    expect(el.textContent).toContain("Decision");
    expect(el.textContent).toContain("coi (jev): is_coi yes 0.92");
    expect(el.querySelector(".lucide-scale")).not.toBeNull();
    expect(el.querySelector("pre")).toBeNull();
    act(() => el.querySelector("button")!.click());
    expect(el.querySelector("pre")?.textContent).toBe(text);
  });
});

describe("Timeline, a text block", () => {
  it("is labelled Text, with its own icon, never its kind's name", () => {
    const h = html(row({ id: "t1", kind: "text_block", summary: "Let me check the invoice first.", text: "Let me check the invoice first." }));
    expect(h).toMatch(/>Text</);
    expect(h).not.toContain("text_block");
    expect(h).toContain("lucide-message-square-text");
  });
});

// The timeline tells the run as steps: each tool once, with how long it took and what it saved; a failure repeated in a
// row once, with how many times; the question once; the answer's first line as text, never its markdown.
describe("Timeline, the run told as steps", () => {
  const at = (s: string) => `2026-11-03T16:41:${s}Z`;
  const rows: TimelineRow[] = [
    row({ id: "u", seq: 0, kind: "user_message", summary: "You: Check invoice INV-2291.", timestamp: at("25.551") }),
    row({ id: "a", seq: 1, kind: "tool_use", summary: "Wrote notes.md", timestamp: at("25.569"), tool_name: "write", tool_use_id: "t1" }),
    row({ id: "b", seq: 2, kind: "tool_result", summary: "Wrote notes.md: ok", timestamp: at("25.596"), tool_name: "write", tool_use_id: "t1", tool_status: "success" }),
    row({ id: "c", seq: 3, kind: "phase", summary: "Saved notes.md", timestamp: at("25.596"), path: "notes.md" }),
    row({ id: "d", seq: 4, kind: "final_answer", summary: "## Invoice INV-2291", text: "## Invoice INV-2291\n\nApprove.", timestamp: at("25.637") }),
  ];
  const h = () => renderToStaticMarkup(<Timeline rows={rows} live={false} />);
  it("shows each tool once, with how long it took and the file it saved", () => {
    expect(h().match(/Wrote notes\.md/g)).toHaveLength(1);
    expect(h()).not.toContain(": ok");
    expect(h()).toContain("27 ms");
    expect(h()).toContain("saved notes.md");
    expect(h()).not.toContain("Phase");
  });
  it("shows the answer's first line as text, never its markdown", () => {
    expect(h()).toContain(">Invoice INV-2291<");
    expect(h()).not.toContain("## Invoice");
  });
  it("says a failure repeated in a row once, with how many times", () => {
    const err = (id: string, seq: number, s: string) => row({ id, seq, kind: "error", summary: "Model request failed: 529 overloaded", timestamp: at(s) });
    const out = renderToStaticMarkup(<Timeline rows={[err("e1", 1, "27.356"), err("e2", 2, "29.375"), err("e3", 3, "33.386"), err("e4", 4, "41.398")]} live={false} />);
    expect(out.match(/Model request failed/g)).toHaveLength(1);
    expect(out).toContain("4 times over 14.0 s");
  });
  it("asks the question once", () => {
    const out = renderToStaticMarkup(<Timeline live={false} rows={[
      row({ id: "q1", seq: 1, kind: "tool_use", summary: "Asked you: Which limit applies?", tool_name: "ask_person", tool_use_id: "q" }),
      row({ id: "q2", seq: 2, kind: "tool_result", summary: "Asked you: Which limit applies?", tool_name: "ask_person", tool_use_id: "q", tool_status: "success" }),
      row({ id: "q3", seq: 3, kind: "waiting", summary: "Waiting for you: Which limit applies?" }),
    ]} />);
    expect(out.match(/Which limit applies\?/g)).toHaveLength(1);
  });
});
