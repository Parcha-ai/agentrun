import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { recorded } from "@/fixtures";
import type { Run } from "@/lib/v2";
import { NO_MESSAGES } from "@/lib/runState";

// A run its cap stopped says why on its page in the server's own words (run.error.message), whatever they are: the
// console adds nothing to them and drops nothing from them.
describe("RunDetail, a run its cap stopped", () => {
  it("shows the server's message as it is", () => {
    const run = recorded<Run>("run.failed.idle.5").body;
    expect(run.error?.code).toBe("spend_cap_reached");
    const message = `${run.error!.message} <and any words the server picks next, as they are>`;
    const html = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, error: { ...run.error!, message } }, agentName: "Agent", messages: NO_MESSAGES, harnessSteers: true, rows: [], files: [] }));
    const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(text).toContain(message);
  });
});
