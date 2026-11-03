import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

let seq = 0;
const row = (over: Partial<TimelineRow>): TimelineRow => ({
  id: `r${++seq}`, seq, kind: "tool_use", summary: "", text: null, timestamp: "2026-11-03T21:00:00Z", tool_name: null, tool_status: "success", ...over,
});
const html = (rows: TimelineRow[]) => renderToStaticMarkup(<Timeline rows={rows} live={false} fold={50} />);

// A step's line is the server's words, and those carry Markdown: a model's thinking in bold, a command in backticks.
// Bold and code show as such, never as their marks; nothing else in the text is markup.
describe("Timeline, a step's words", () => {
  it("shows a thinking step's bold as bold, without its asterisks", () => {
    const h = html([row({ kind: "thinking", summary: "Thinking: **Verifying current date…**", text: "**Verifying current date…**\n\nThe run needs today's date.", tool_status: null })]);
    expect(h).toContain("<strong");
    expect(h).toMatch(/<strong[^>]*>Verifying current date…<\/strong>/);
    expect(h).not.toContain("**Verifying");
  });

  it("shows a command in backticks as code, without the backticks", () => {
    const h = html([row({ tool_name: "bash", summary: "Ran `python3 -m unittest -v`", tool_input_preview: "python3 -m unittest -v" })]);
    expect(h).toMatch(/Ran <code[^>]*>python3 -m unittest -v<\/code>/);
    expect(h).not.toContain("`");
  });

  it("shows a command inside bold as code too, and bold inside a command as typed", () => {
    const h = html([
      row({ kind: "thinking", summary: "Thinking: **Run `python3 -m unittest` first**", tool_status: null }),
      row({ tool_name: "bash", summary: "Ran `grep -n '**' notes.md`" }),
    ]);
    expect(h).toMatch(/<strong[^>]*>Run <code[^>]*>python3 -m unittest<\/code> first<\/strong>/);
    expect(h).toMatch(/Ran <code[^>]*>grep -n &#x27;\*\*&#x27; notes.md<\/code>/);
    expect(h).not.toContain("`");
  });

  it("leaves everything else as text: HTML stays text, and a name with underscores keeps them", () => {
    const h = html([
      row({ tool_name: "write", summary: "Wrote pkg/__init__.py", path: "pkg/__init__.py" }),
      row({ kind: "thinking", summary: "Thinking: maybe <b>this</b> or a lone ** mark", tool_status: null }),
    ]);
    expect(h).toContain("Wrote pkg/__init__.py");
    expect(h).toContain("&lt;b&gt;this&lt;/b&gt;");
    expect(h).not.toContain("<b>");
    expect(h).toContain("a lone ** mark");
  });
});

// A tool step's label is a word a person reads, from either of the server's shapes (one row per action, or a call and
// its result); the tool's own id stays in what the step opens to.
describe("Timeline, a tool step's label", () => {
  const labelOf = (tool_name: string, extra: Partial<TimelineRow> = {}) => {
    const el = document.createElement("div");
    document.body.append(el);
    const r = createRoot(el);
    act(() => r.render(<Timeline rows={[row({ tool_name, summary: "did it", tool_input_preview: "{}", ...extra })]} live={false} />));
    const label = el.querySelector("li button span span")?.firstChild?.textContent ?? "";
    act(() => r.unmount());
    return label;
  };

  it("names the common tools in words, whatever the harness calls them", () => {
    for (const [id, word] of [
      ["web_fetch", "Fetch"], ["WebFetch", "Fetch"], ["web_search", "Search"], ["WebSearch", "Search"],
      ["bash", "Shell"], ["Bash", "Shell"], ["shell", "Shell"], ["read", "Read"], ["Read", "Read"], ["write", "Write"],
      ["edit", "Edit"], ["apply_patch", "Edit"], ["mcp__hands__read", "Read"], ["glob", "Find files"], ["grep", "Search files"],
    ] as const) expect(labelOf(id), id).toBe(word);
  });

  // An imported session's tool names are whatever its harness wrote: one named like an Object property (`__proto__`,
  // `constructor`) is a name like any other, never the lookup's own prototype (which React can't render).
  it("reads a tool named like an object property as words, and the timeline still renders", () => {
    expect(labelOf("__proto__")).toBe("Proto");
    expect(labelOf("constructor")).toBe("Constructor");
    expect(labelOf("toString")).toBe("To string");
    expect(labelOf("hasOwnProperty")).toBe("Has own property");
  });

  it("makes words of any other id, and says the same for a result row of the older shape", () => {
    expect(labelOf("browser_release")).toBe("Browser release");
    expect(labelOf("runsGet")).toBe("Runs get");
    expect(labelOf("mcp__agentrun_serve__runs_get")).toBe("Runs get");
    expect(labelOf("web_fetch", { kind: "tool_result", tool_status: null })).toBe("Fetch");
  });

  it("keeps the tool's own id in what the step opens to", () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    act(() => root!.render(<Timeline rows={[row({ tool_name: "web_fetch", summary: "Fetched python.org", tool_input_preview: "https://python.org" })]} live={false} />));
    expect(el.textContent).not.toContain("web_fetch");
    act(() => el.querySelector<HTMLButtonElement>("li button")!.click());
    expect(el.textContent).toContain("web_fetch");
    expect(el.textContent).toContain("https://python.org");
  });
});

// An answer the agent left empty is said, not shown as a blank step.
describe("Timeline, an empty answer", () => {
  it("says the agent finished without writing one", () => {
    const h = html([row({ kind: "final_answer", summary: "", text: "", tool_status: null })]);
    expect(h).toContain("The agent finished without writing an answer.");
  });
});
