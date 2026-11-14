import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunResult } from "@/components/RunResult";
import type { Run } from "@/lib/v2";

describe("RunResult", () => {
  it("reads a workflow output's written report as Markdown and keeps the rest as JSON", () => {
    const run = { result: { output: { report_template: "# Batch\n\n| Document | Verdict |\n| --- | --- |\n| a.pdf | valid |\n| b.pdf | invalid |", tally: { valid: 1 } } } } as unknown as Run;
    const html = renderToStaticMarkup(<RunResult run={run} rows={[]} />);
    expect(html).toContain("report template");
    expect(html).toContain("<h1");
    expect(html).toContain("The rest of the output");
    expect(html).toContain("&quot;tally&quot;");
  });
});

// An agentic run whose agent has an output schema: the Report reads result.output with the schema, never the answer
// text. A string the schema marks `contentMediaType: "text/markdown"` is a Markdown section, at any depth; the rest reads
// as fields. A run whose answer still missed the schema says why, then shows the answer as written.
describe("RunResult, an agentic run with an output schema", () => {
  const SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string" },
      report_markdown: { type: "string", title: "Report", contentMediaType: "text/markdown" },
      items: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, note: { type: "string", contentMediaType: "text/markdown" } } } },
      plain: { type: "string" },
    },
  };
  const output = { verdict: "clear", report_markdown: "# Verdict\n\nNo **red flags**.", items: [{ claim: "Acme launched Pulse", note: "Seen on *two* pages." }], plain: "# not a heading" };
  const agentic = (result: Record<string, unknown>) => ({ kind: "agentic", result }) as unknown as Run;

  it("reads result.output with the schema: the Markdown fields as Markdown, the rest as fields, the answer's text never", () => {
    const run = agentic({ output, final_answer: "Words before the block.\n\n```json\n{\"verdict\": \"stale\"}\n```" });
    const html = renderToStaticMarkup(<RunResult run={run} rows={[]} schema={SCHEMA} />);
    expect(html).toContain("Report");
    expect(html).toMatch(/<h1[^>]*>Verdict<\/h1>/);
    expect(html).toContain("<strong>red flags</strong>");
    expect(html).toContain("<em>two</em>");
    expect(html).toContain("clear");
    expect(html).toContain("# not a heading");
    expect(html).not.toContain("Words before the block.");
    expect(html).not.toContain("stale");
  });

  it("a run whose answer still missed its schema says why, then shows the answer as written", () => {
    const run = agentic({ output: null, output_error: "the answer has no fenced json block", final_answer: "Only prose here." });
    const html = renderToStaticMarkup(<RunResult run={run} rows={[]} schema={SCHEMA} />);
    expect(html).toContain("the answer has no fenced json block");
    expect(html).toContain("Only prose here.");
  });
});
