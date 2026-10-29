import { describe, expect, it } from "vitest";
import { latest, pendingQuestion, viewKind } from "./viewing";
import type { RunFile, TimelineRow } from "./v2";

const file = (path: string, content_type: string | null): RunFile => ({ path, size_bytes: 1, modified_at: "2026-10-28T19:33:28.590Z", content_type });
const row = (id: string, kind: string, seq: number): TimelineRow =>
  ({ id, seq, kind, summary: `Waiting for you: ${id}`, text: null, timestamp: "2026-10-28T19:33:16.118Z", tool_name: null });

describe("pendingQuestion", () => {
  const rows = [row("q1", "waiting", 1), row("a1", "user_message", 2)];
  it("is the newest wait while the run is waiting on it", () => {
    expect(pendingQuestion("input_required", "waiting", rows)?.id).toBe("q1");
  });
  it("is the newest of several questions", () => {
    const two = [row("q1", "waiting", 1), row("a1", "user_message", 2), row("q2", "waiting", 3)];
    expect(pendingQuestion("input_required", "waiting", two)?.id).toBe("q2");
  });
  it("is none for a stopped run, even when the timeline still holds an answered question", () => {
    expect(pendingQuestion("input_required", "idle", rows)).toBeNull();
  });
  it("is none for a run that is not input_required", () => {
    expect(pendingQuestion("working", "waiting", rows)).toBeNull();
  });
});

describe("viewKind", () => {
  it("renders Markdown and text, and offers anything else as a download", () => {
    expect(viewKind(file("CHANGELOG.md", "text/markdown; charset=utf-8"))).toBe("markdown");
    expect(viewKind(file("notes.md", null))).toBe("markdown");
    expect(viewKind(file("out.json", "application/json"))).toBe("text");
    expect(viewKind(file("log.txt", "text/plain"))).toBe("text");
    expect(viewKind(file("photo.png", "image/png"))).toBe("download");
  });
  it("treats a type the server does not know (null) as unknown: download only", () => {
    expect(viewKind(file("data.bin", null))).toBe("download");
  });
});

describe("latest", () => {
  it("only the newest read may land; a cancel or a newer read retires the older ones", () => {
    const reads = latest();
    const first = reads.begin();
    const second = reads.begin();
    expect(reads.current(first)).toBe(false);
    expect(reads.current(second)).toBe(true);
    reads.cancel();
    expect(reads.current(second)).toBe(false);
  });
});
