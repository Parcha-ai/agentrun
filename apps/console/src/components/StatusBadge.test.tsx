import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewNotice } from "./RunDetail";
import { StatusBadge } from "./StatusBadge";

// A decision workflow that routed its case to a person did its job: serve says completed, with a review. The console
// reads it as needing review, never as a plain completion and never as a failure.
describe("StatusBadge", () => {
  const review = { kind: "coi_review", node: "document_review", reason: "document_checks: looks_altered", at: "2026-10-29T23:30:00Z" };
  it("reads a completed run with a review as Needs review", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { run: { status: "completed", state: "idle", kind: "workflow", review } }));
    expect(html).toContain("Needs review");
    expect(html).not.toContain("Completed");
  });
  it("reads a completed run with no review as Completed", () => {
    for (const r of [null, undefined]) {
      expect(renderToStaticMarkup(createElement(StatusBadge, { run: { status: "completed", state: "idle", kind: "workflow", review: r } }))).toContain("Completed");
    }
  });
});

describe("ReviewNotice", () => {
  it("says the run needs review, its kind, where it was sent for review and why, with no composer", () => {
    const html = renderToStaticMarkup(createElement(ReviewNotice, { review: { kind: "coi_review", node: "document_review", reason: "document_checks: looks_altered", at: "2026-10-29T23:30:00Z" } }));
    expect(html).toContain("Needs review");
    expect(html).toContain("coi_review");
    expect(html).toContain("document_review");
    expect(html).toContain("document_checks: looks_altered");
    expect(html).not.toContain("<textarea");
  });
});

describe("ReviewNotice, a run escalated before the review named its kind and node", () => {
  it("says it needs review and why, and never prints null", () => {
    const html = renderToStaticMarkup(createElement(ReviewNotice, { review: { kind: null, node: null, reason: "document_checks; escalated at document_review", at: "2026-10-29T23:30:00Z" } }));
    expect(html).toContain("Needs review");
    expect(html).toContain("document_checks; escalated at document_review");
    expect(html).not.toContain("null");
    // No dangling separator or empty place where the kind and node would be.
    expect(html).not.toMatch(/·\s*</);
    expect(html).not.toContain("at ,");
  });
});
