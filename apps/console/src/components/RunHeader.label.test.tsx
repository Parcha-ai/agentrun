import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run's short label (the run page's header and the Playground's run panel, which is the same header) tells apart two
// runs started in the same second. Run ids are UUIDv7s: their leading digits are the start time, the same for runs
// started within about a minute, so the label is the random tail.
const run = (run_id: string): Run => ({
  run_id, agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Name three primes above 100.",
  created_at: "2026-11-04T21:14:00Z", ended_at: "2026-11-04T21:14:03Z", result: null, error: null, cost: null, archived_at: null,
} as Run);
const crumb = (id: string) => {
  const html = renderToStaticMarkup(createElement(RunHeader, { run: run(id), agentName: "QA pi hand" }));
  return /<nav[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

describe("a run's short label", () => {
  it("differs for two runs started in the same second", () => {
    const [a, b] = [crumb("01a1a869-ce4e-7cf5-abf8-c5407893934a"), crumb("01a1a869-ce4e-7d11-9a02-3f6b0e21d7c5")];
    expect(a).toMatch(/^QA pi hand \/ Run \S+$/);
    expect(a).not.toBe(b);
  });
});
