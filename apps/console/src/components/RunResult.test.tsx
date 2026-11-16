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

  it("follows the schema's local $refs: a Markdown field, and a nested object's own, behind a reference", () => {
    const schema = {
      type: "object",
      $defs: { report: { type: "string", title: "Report", contentMediaType: "text/markdown" }, item: { type: "object", properties: { note: { $ref: "#/$defs/report" } } }, text: { type: "string" } },
      properties: {
        report: { $ref: "#/$defs/report" },
        items: { type: "array", items: { $ref: "#/$defs/item" } },
        // Annotations beside a reference are the field's own, over the target's.
        summary: { $ref: "#/$defs/text", title: "Summary", contentMediaType: "text/markdown" },
        // Properties beside a reference add to the target's, never replace them.
        wrapped: { $ref: "#/$defs/item", properties: { extra: { type: "string" } } },
      },
    };
    const run = agentic({ output: { report: "# Verdict\n\nNo **red flags**.", items: [{ note: "Seen on *two* pages." }], summary: "All **clear**.", wrapped: { note: "Also *wrapped*.", extra: "plain" } } });
    const html = renderToStaticMarkup(<RunResult run={run} rows={[]} schema={schema} />);
    expect(html).toContain("Report");
    expect(html).toMatch(/<h1[^>]*>Verdict<\/h1>/);
    expect(html).toContain("<em>two</em>");
    expect(html).toContain("Summary");
    expect(html).toContain("<strong>clear</strong>");
    expect(html).toContain("<em>wrapped</em>");
  });

  it("reads an output that is not an object with its schema too: a list of Markdown strings as Markdown", () => {
    const schema = { type: "array", items: { type: "string", contentMediaType: "text/markdown" } };
    const html = renderToStaticMarkup(<RunResult run={agentic({ output: ["# One", "Two **bold**"] })} rows={[]} schema={schema} />);
    expect(html).toMatch(/<h1[^>]*>One<\/h1>/);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("a run whose answer still missed its schema says why, then shows the answer as written", () => {
    const run = agentic({ output: null, output_error: "the answer has no fenced json block", final_answer: "Only prose here." });
    const html = renderToStaticMarkup(<RunResult run={run} rows={[]} schema={SCHEMA} />);
    expect(html).toContain("the answer has no fenced json block");
    expect(html).toContain("Only prose here.");
  });
});
