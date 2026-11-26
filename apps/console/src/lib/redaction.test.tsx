import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { markdown } from "@/lib/format";
import type { TimelineRow } from "@/lib/v2";
import { Redactions } from "./redaction";

// The scrubber's markers (serve's secret-cut.ts: `[redacted:<rule>]`, a dump's `[redacted:<rule> N lines]`) read as a chip
// wherever the console draws text, their words as the server sent them, so what a person copies is what was served.
describe("redaction markers", () => {
  it("Redactions draws each marker as a chip and the rest as text", () => {
    const html = renderToStaticMarkup(<Redactions text={"key [redacted:sk-key], then\n[redacted:env-dump 4 lines] and [redacted] and [redacted:Bad Rule]"} />);
    expect(html).toBe('key <span class="redaction" data-rule="sk-key">[redacted:sk-key]</span>, then\n<span class="redaction" data-rule="env-dump">[redacted:env-dump 4 lines]</span> and [redacted] and [redacted:Bad Rule]');
  });

  it("markdown() draws them as chips too, in prose and in code, and keeps HTML out", () => {
    const html = markdown("Mail [redacted:email] now.\n\n`PGPASSWORD=[redacted:secret-assign]`\n\n<b>[redacted:x]</b>");
    expect(html).toContain('Mail <span class="redaction" data-rule="email">[redacted:email]</span> now.');
    expect(html).toContain('<code>PGPASSWORD=<span class="redaction" data-rule="secret-assign">[redacted:secret-assign]</span></code>');
    expect(html).not.toContain("<script");
  });

  it("a Timeline step's line draws its markers as chips", () => {
    const row = { id: "r1", kind: "text_block", timestamp: "2026-11-23T10:00:00.000Z", created_at: "2026-11-23T10:00:00.000Z", summary: "The host [redacted:private-ip] answered", text: "The host [redacted:private-ip] answered" } as TimelineRow;
    const html = renderToStaticMarkup(<Timeline rows={[row]} live={false} ended />);
    expect(html).toContain('<span class="redaction" data-rule="private-ip">[redacted:private-ip]</span>');
  });
});
