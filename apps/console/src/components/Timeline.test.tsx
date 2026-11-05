import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelinePage, TimelineRow } from "@/lib/v2";
import { recorded } from "@/fixtures";

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

// QA: a browser step read "run" or "snapshot" above what it did: the browser tool's wire name. It reads as the timeline
// library names the tool (the name a run's tool counts show), and every other tool keeps its own name.
describe("Timeline, a browser step", () => {
  it("is labelled with what the browser tool does, not its wire name", () => {
    const acted = html(row({ kind: "tool_use", tool_name: "run", tool_status: "success", summary: "Opened example.com" }));
    expect(acted).toMatch(/>Open or act on a page in the browser</);
    expect(acted).not.toMatch(/>run</);
    const looked = html(row({ kind: "tool_result", tool_name: "snapshot", tool_status: "success", summary: "Looked at the page structure" }));
    expect(looked).toMatch(/>Look at the page structure</);
    expect(looked).not.toMatch(/>snapshot</);
    expect(html(row({ kind: "tool_use", tool_name: "browser_read", summary: "Read the page" }))).toMatch(/>Read the browser&#x27;s page</);
  });
  it("leaves every other tool's name as it is", () => {
    expect(html(row({ kind: "tool_use", tool_name: "write", summary: "Wrote notes.md" }))).toMatch(/>write</);
    expect(html(row({ kind: "tool_use", tool_name: "web_fetch", summary: "Fetched example.com" }))).toMatch(/>web_fetch</);
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
    // The recorded answer has more than its first line: the row says so.
    expect(h()).toContain(">Invoice INV-2291…<");
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
      row({ id: "q2:waiting", seq: 3, kind: "waiting", summary: "Waiting for you: Which limit applies?" }),
    ]} />);
    expect(out.match(/Which limit applies\?/g)).toHaveLength(1);
  });
});

// One row per action (capabilities' timeline.actions): a call is its own row, changing in place as it goes.
describe("Timeline, one row per action", () => {
  const at = (s: string) => `2026-11-03T16:41:${s}Z`;
  const action = (over: Partial<TimelineRow>) => row({ kind: "tool_use", tool_name: "write", ...over });
  const show = (r: TimelineRow[]) => renderToStaticMarkup(<Timeline rows={r} live={false} />);
  it("shows a running action with a spinner and no duration, an ended one with its result and how long it took", () => {
    const h = show([action({ id: "a", summary: "Read a.md", tool_name: "read", tool_status: "running", timestamp: at("25.000") }), action({ id: "b", seq: 2, summary: "Wrote notes.md: ok", tool_status: "success", timestamp: at("25.569"), ended_at: at("25.596") })]);
    expect(h).toContain("Read a.md");
    expect(h).toContain("animate-spin");
    expect(h).toContain("Wrote notes.md: ok");
    expect(h).toContain("27 ms");
    expect(h.match(/ ms</g)).toHaveLength(1);
    expect(h).not.toContain("border-destructive");
  });
  it("opens an action to its input, then its result", () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    act(() => root!.render(<Timeline rows={[action({ id: "c", summary: "Wrote notes.md: ok", tool_status: "success", tool_input_preview: "notes.md", tool_result_preview: "Wrote 816 bytes" })]} live={false} />));
    act(() => el.querySelector("button")!.click());
    expect(el.querySelector("pre")?.textContent).toBe("notes.md\n\n→ Wrote 816 bytes");
  });
  it("reads a failed or interrupted action as failed, and a missing one in grey, never as an error", () => {
    const failed = show([action({ id: "d", summary: "Fetched example.com failed: timeout", tool_name: "web_fetch", tool_status: "failed" })]);
    expect(failed).toContain("border-destructive");
    expect(failed).toMatch(/>Error</);
    const cut = show([action({ id: "e", summary: "Ran the tests: interrupted", tool_name: "bash", tool_status: "interrupted" })]);
    expect(cut).toContain("border-destructive");
    expect(cut).toMatch(/>Interrupted</);
    const missing = show([action({ id: "f", summary: "Read AGENTS.md: not found", tool_name: "read", tool_status: "missing" })]);
    expect(missing).not.toContain("border-destructive");
    expect(missing).not.toMatch(/>Error</);
    expect(missing).toContain("text-muted-foreground");
  });
});

// The same pi run in both of the server's shapes (src/fixtures/timeline.*), drawn as the run page draws it.
describe("Timeline, the recorded run in both shapes", () => {
  const rowsOf = (name: string) => recorded<TimelinePage>(name).body.rows;
  const all = (r: TimelineRow[]) => renderToStaticMarkup(<Timeline rows={r} live={false} fold={100} />);
  it("draws each read once in either shape, and the question once", () => {
    for (const name of ["timeline.legacy.completed", "timeline.actions.completed"]) {
      const h = all(rowsOf(name));
      expect(h.match(/Read invoices\/inv-2\.md/g), name).toHaveLength(1);
      expect(h.match(/The invoices carry no currency/g), name).toHaveLength(1);
    }
  });
  it("draws the action shape's miss in grey, its failed write in red, and its interrupted write as interrupted", () => {
    const h = all(rowsOf("timeline.actions.completed"));
    expect(h).toContain("Read AGENTS.md: not found");
    expect(h).toMatch(/>Interrupted</);
    expect(h.match(/>Error</g)).toHaveLength(1);
    // The interrupted write ran to the run's end: 8 s.
    expect(h).toContain("8.0 s");
  });
});
