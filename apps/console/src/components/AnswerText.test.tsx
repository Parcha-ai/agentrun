import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RunChanges } from "@/components/RunChanges";
import { RunResult } from "@/components/RunResult";
import { Timeline } from "@/components/Timeline";
import { markdown } from "@/lib/format";
import type { Run, TimelineRow } from "@/lib/v2";

// What an agent writes reads as it wrote it. An answer asked for in three lines shows three lines (marked joined a
// paragraph's single line breaks into one line), and the timeline's Answer row, which shows the answer's first line, says
// when there is more. A placeholder in angle brackets ("Customer: <name>") is text: marked passed it through as an HTML
// tag, and the sanitizer dropped the tag it didn't know, so "Customer: <name>" read "Customer: ".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const THREE = "Customer: Jane Doe\nAmount: $120\nDecision: approve myself";
const dom = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
// The text as a browser lays it out: a newline in a paragraph's text is a space; a <br> or a block's end starts a line.
const lines = (html: string) => {
  const d = dom(html);
  const walk = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.textContent = (n.textContent ?? "").replace(/\s+/g, " ");
  d.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
  d.querySelectorAll("p, li, h1, h2, h3, pre").forEach((e) => e.append("\n"));
  return (d.textContent ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
};

describe("an answer's line breaks", () => {
  it("a three-line answer reads as three lines in the Report", () => {
    const run = { result: { final_answer: `${THREE}\n\nI'll keep this format.` } } as unknown as Run;
    const html = renderToStaticMarkup(createElement(RunResult, { run, rows: [] }));
    expect(lines(html)).toEqual(["Customer: Jane Doe", "Amount: $120", "Decision: approve myself", "I'll keep this format."]);
  });

  it("lists, code blocks and paragraphs keep their shape", () => {
    const d = dom(markdown("Steps:\n\n- one\n- two\n\n```\na\nb\n```\n\nFirst paragraph.\n\nSecond paragraph."));
    expect([...d.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(d.querySelector("pre code")?.textContent).toBe("a\nb\n");
    expect(d.querySelector("pre br")).toBeNull();
    expect([...d.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Steps:", "First paragraph.", "Second paragraph."]);
  });
});

describe("the timeline's Answer row", () => {
  const answer = (text: string): TimelineRow => ({ id: "a", seq: 9, kind: "final_answer", summary: text.split("\n")[0], text, timestamp: "2026-11-04T20:36:00Z", tool_name: null });
  const title = (r: TimelineRow) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Timeline, { rows: [r], live: false })));
    return host.querySelector("li span.leading-snug")?.textContent ?? "";
  };
  it("shows the first line with … when the answer has more", () => {
    expect(title(answer(THREE))).toContain("Customer: Jane Doe…");
  });
  it("shows a one-line answer as it is, with no …", () => {
    const t = title(answer("The answer is 42."));
    expect(t).toContain("The answer is 42.");
    expect(t).not.toContain("…");
  });
});

describe("text in angle brackets", () => {
  it("reads literally in Markdown: a placeholder is no tag", () => {
    const d = dom(markdown('The summary is three lines: "Customer: <name>" "Amount: $<amount>" and <customer_id>.'));
    expect(d.textContent).toContain('"Customer: <name>" "Amount: $<amount>" and <customer_id>.');
    expect(d.querySelector("name, amount, customer_id")).toBeNull();
  });

  it("on its own line too, where Markdown would read it as an HTML block", () => {
    const d = dom(markdown("<name>\n\nAfter."));
    expect(d.textContent).toContain("<name>");
  });

  it("HTML the sanitizer keeps is still HTML, and what it strips stays stripped", () => {
    const d = dom(markdown('a <b>bold</b> word<br>next <img src=x onerror="alert(1)"> <script>alert(1)</script>'));
    expect(d.querySelector("b")?.textContent).toBe("bold");
    expect(d.querySelector("br")).not.toBeNull();
    expect(d.querySelector("script")).toBeNull();
    expect(d.innerHTML).not.toMatch(/onerror/i);
  });

  it("a <script> an agent wrote reads as the text it wrote: never run, never silently dropped", () => {
    const d = dom(markdown("Paste <script>alert(1)</script> into the page.\n\n<script>\nalert(2)\n</script>"));
    expect(d.querySelector("script")).toBeNull();
    expect(d.textContent).toContain("Paste <script>alert(1)</script> into the page.");
    expect(d.textContent).toContain("alert(2)");
  });

  it("in What it changed (the learning diff), a note's <name> reads literally", () => {
    // Closed at first: its text is in the page once opened.
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunChanges, { got: { state: "read", changes: [{ file: "refund-summary-format.md", said: "Added: Refund summary format", before: null, after: [{ text: '"Customer: <name>"', mark: "added" }, { text: '"Amount: $<amount>"', mark: "added" }] }] }, retry: () => {} })));
    act(() => { host.querySelector("button")!.click(); });
    expect(host.textContent).toContain('"Customer: <name>"');
    expect(host.textContent).toContain('"Amount: $<amount>"');
  });
});
