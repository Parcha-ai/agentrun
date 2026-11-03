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
