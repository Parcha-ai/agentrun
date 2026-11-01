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
