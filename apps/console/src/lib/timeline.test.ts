import { describe, expect, it } from "vitest";
import { applyPage, steps } from "./timeline";
import type { TimelinePage, TimelineRow } from "./v2";
import { recorded } from "@/fixtures";

const row = (id: string, seq: number, summary = id): TimelineRow =>
  ({ id, seq, kind: "thinking", summary, text: null, timestamp: "2026-10-28T19:33:16.118Z", tool_name: null });
const page = (rows: TimelineRow[], extra: Partial<TimelinePage> = {}): TimelinePage => ({
  run_id: "r", status: "working", state: "working", rows, drop: [], reset: false, unchanged: false, final: false,
  has_more: false, next_after: 1, ...extra,
});

describe("applyPage", () => {
  it("appends new rows in seq order", () => {
    expect(applyPage([row("a", 1)], page([row("c", 3), row("b", 2)])).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("never duplicates a row a reconnect sends again; the newer copy wins", () => {
    const out = applyPage([row("a", 1, "old"), row("b", 2)], page([row("a", 1, "new"), row("c", 3)]));
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out[0].summary).toBe("new");
  });

  it("a reset replaces everything held", () => {
    expect(applyPage([row("a", 1), row("b", 2)], page([row("x", 1)], { reset: true })).map((r) => r.id)).toEqual(["x"]);
  });

  it("drops the rows the server names", () => {
    expect(applyPage([row("a", 1), row("b", 2)], page([], { drop: ["a"] })).map((r) => r.id)).toEqual(["b"]);
  });

  it("a page marked unchanged that still carries rows or drops applies them (nothing it sends is lost)", () => {
    expect(applyPage([row("a", 1)], page([row("b", 2)], { unchanged: true })).map((r) => r.id)).toEqual(["a", "b"]);
    expect(applyPage([row("a", 1), row("b", 2)], page([], { unchanged: true, drop: ["a"] })).map((r) => r.id)).toEqual(["b"]);
  });

  it("an unchanged page changes nothing", () => {
    const held = [row("a", 1)];
    expect(applyPage(held, page([], { unchanged: true }))).toBe(held);
  });
});

// A run's rows told as steps: one per tool use (its result folded in, with how long it took and the file it saved), a
// question asked once, repeated failures said once with how many, the cost so far once, at the end.
describe("steps", () => {
  const r = (seq: number, kind: string, summary: string, at: string, over: Partial<TimelineRow> = {}): TimelineRow =>
    ({ id: `r${seq}`, seq, kind, summary, text: null, timestamp: `2026-11-03T16:41:${at}Z`, tool_name: null, ...over });
  const tooled = [
    r(0, "user_message", "You: Check invoice INV-2291 against PO-7781.", "25.551"),
    r(1, "tool_use", "Wrote notes.md", "25.569", { tool_name: "write", tool_use_id: "t1", tool_input_preview: "notes.md" }),
    r(2, "tool_result", "Wrote notes.md: ok", "25.596", { tool_name: "write", tool_use_id: "t1", tool_status: "success", tool_result_preview: "ok" }),
    r(3, "phase", "Saved notes.md", "25.596", { path: "notes.md" }),
    r(4, "tool_use", "Read notes.md", "25.615", { tool_name: "read", tool_use_id: "t2" }),
    r(5, "tool_result", "Read notes.md: ok", "25.627", { tool_name: "read", tool_use_id: "t2", tool_status: "success" }),
    r(6, "final_answer", "## Invoice INV-2291", "25.637", { text: "## Invoice INV-2291\n\n**Verdict:** approve." }),
    r(7, "usage", "Cost so far: $0.0086 over 3 model requests", "25.637"),
  ];
  it("folds each tool's result into its call: one step, its outcome without ': ok', how long it took, the file it saved", () => {
    const s = steps(tooled);
    expect(s.map((x) => [x.row.kind, x.row.summary])).toEqual([
      ["user_message", "You: Check invoice INV-2291 against PO-7781."],
      ["tool_result", "Wrote notes.md"], ["tool_result", "Read notes.md"],
      ["final_answer", "## Invoice INV-2291"], ["usage", "Cost so far: $0.0086 over 3 model requests"],
    ]);
    expect(s[1]).toMatchObject({ ms: 27, saved: "notes.md" });
    expect(s[1]!.detail).toBe("notes.md\n\n→ ok");
    expect(s[2]).toMatchObject({ ms: 12 });
  });
  it("keeps a failed tool's outcome as the server said it, and a call still running as the call", () => {
    const s = steps([r(1, "tool_use", "Fetched example.com", "01.000", { tool_name: "web_fetch", tool_use_id: "a" }), r(2, "tool_result", "Fetched example.com failed: timeout", "04.500", { tool_name: "web_fetch", tool_use_id: "a", tool_status: "failed" }), r(3, "tool_use", "Read a.md", "05.000", { tool_name: "read", tool_use_id: "b" })]);
    expect(s.map((x) => [x.row.kind, x.row.summary, x.row.tool_status ?? null])).toEqual([["tool_result", "Fetched example.com failed: timeout", "failed"], ["tool_use", "Read a.md", null]]);
    expect(s[0]!.ms).toBe(3500);
  });
  it("asks a question once: the ask_person call and its result fold away behind the waiting row", () => {
    const s = steps([
      r(0, "user_message", "You: Check invoice INV-2310.", "26.876"),
      r(1, "tool_use", "Asked you: Which limit applies?", "26.914", { tool_name: "ask_person", tool_use_id: "q" }),
      r(2, "tool_result", "Asked you: Which limit applies?", "26.930", { tool_name: "ask_person", tool_use_id: "q", tool_status: "success" }),
      // The server names a waiting row after the row it stands for: its id plus ":waiting".
      r(3, "waiting", "Waiting for you: Which limit applies?", "26.930", { id: "r2:waiting" }),
      r(4, "usage", "Cost so far: $0.0052 over 1 model request", "26.930"),
    ]);
    expect(s.map((x) => x.row.kind)).toEqual(["user_message", "waiting", "usage"]);
  });
  it("says a failure repeated in a row once, with how many times and until when", () => {
    const err = (seq: number, at: string) => r(seq, "error", "Model request failed: 529 overloaded", at);
    const s = steps([r(0, "user_message", "You: Check invoice INV-2299.", "27.330"), err(1, "27.356"), err(2, "29.375"), err(3, "33.386"), err(4, "41.398"), r(5, "usage", "Cost so far: $0 over 4 model requests", "41.398")]);
    expect(s.map((x) => [x.row.kind, x.times ?? 1])).toEqual([["user_message", 1], ["error", 4], ["usage", 1]]);
    expect(s[1]!.until).toBe("2026-11-03T16:41:41.398Z");
  });
  it("keeps only the last cost so far: each says the run's total until then", () => {
    const s = steps([r(1, "usage", "Cost so far: $0.001 over 1 model request", "01.000"), r(2, "final_answer", "Done.", "02.000"), r(3, "usage", "Cost so far: $0.002 over 2 model requests", "02.000")]);
    expect(s.map((x) => x.row.summary)).toEqual(["Done.", "Cost so far: $0.002 over 2 model requests"]);
  });
});

// One row per action (capabilities' timeline.actions): a call is its own row, so its steps are the rows as served, with
// how long a call took once it ended, a repeated failure once, and the cost so far once.
describe("steps, over one row per action", () => {
  const r = (seq: number, kind: string, summary: string, at: string, over: Partial<TimelineRow> = {}): TimelineRow =>
    ({ id: `r${seq}`, seq, kind, summary, text: null, timestamp: `2026-11-03T16:41:${at}Z`, tool_name: null, ...over });
  it("keeps each action as its own step, whatever its status, with its duration once it ended and nothing while it runs", () => {
    const s = steps([
      r(1, "tool_use", "Wrote notes.md: ok", "25.569", { tool_name: "write", tool_status: "success", path: "notes.md", ended_at: "2026-11-03T16:41:25.596Z", tool_input_preview: "notes.md", tool_result_preview: "816 bytes" }),
      r(2, "tool_use", "Read a.md", "25.615", { tool_name: "read", tool_status: "running", ended_at: null }),
    ]);
    expect(s.map((x) => [x.row.summary, x.row.tool_status, x.ms])).toEqual([["Wrote notes.md: ok", "success", 27], ["Read a.md", "running", undefined]]);
    expect(s[0]!.detail).toBe("notes.md\n\n→ 816 bytes");
    expect(s[0]!.saved).toBeUndefined();
  });
  it("says a failure repeated in a row once, and keeps only the last cost so far", () => {
    const err = (seq: number, at: string) => r(seq, "error", "Model request failed: 529 overloaded", at);
    const s = steps([r(0, "usage", "Cost so far: $0.001 over 1 model request", "20.000"), err(1, "27.356"), err(2, "29.375"), err(3, "41.398"), r(4, "usage", "Total: $0.002 · 2 model requests · 21 s", "41.500")]);
    expect(s.map((x) => [x.row.kind, x.times ?? 1])).toEqual([["error", 3], ["usage", 1]]);
    expect(s[1]!.row.summary).toBe("Total: $0.002 · 2 model requests · 21 s");
  });
});

// The same pi run in both of the server's shapes (src/fixtures/timeline.*): either way a person reads each action once.
describe("steps, over the recorded run in both shapes", () => {
  const rowsOf = (name: string) => recorded<TimelinePage>(name).body.rows;
  const told = (s: ReturnType<typeof steps>) => s.filter((x) => x.row.kind === "tool_use" || x.row.kind === "tool_result").map((x) => x.row.summary.replace(/:\s*ok$/, ""));
  it("tells the settled run's actions once each, in both shapes", () => {
    const legacy = steps(rowsOf("timeline.legacy.completed"));
    const actions = steps(rowsOf("timeline.actions.completed"));
    // The legacy fold: every call once, no result row, no "Saved" row, the question folded behind its waiting row.
    expect(legacy.some((x) => x.row.kind === "phase")).toBe(false);
    expect(told(legacy).filter((t) => t.startsWith("Read invoices/inv-"))).toEqual(["Read invoices/inv-1.md", "Read invoices/inv-2.md", "Read invoices/inv-3.md"]);
    expect(legacy.find((x) => x.row.summary.startsWith("Wrote totals.md") && x.row.tool_status === "success")?.saved).toBe("totals.md");
    // One row per action as served: the same reads, the miss in grey, the interrupted write and its retry.
    expect(told(actions).filter((t) => t.startsWith("Read invoices/inv-"))).toEqual(["Read invoices/inv-1.md", "Read invoices/inv-2.md", "Read invoices/inv-3.md"]);
    expect(actions.map((x) => x.row.tool_status).filter(Boolean)).toEqual(["missing", "success", "success", "success", "success", "success", "failed", "success", "success", "interrupted", "success"]);
    expect(actions.at(-1)!.row.summary).toMatch(/^Total: /);
  });
  it("runs an interrupted write's duration to the run's end, the latest moment the run's rows hold", () => {
    const rows = rowsOf("timeline.actions.completed");
    const cut = steps(rows).find((x) => x.row.tool_status === "interrupted")!;
    const latest = Math.max(...rows.flatMap((r) => [Date.parse(r.timestamp), r.ended_at ? Date.parse(r.ended_at) : 0]));
    expect(Date.parse(cut.row.ended_at!)).toBe(latest);
    expect(cut.ms).toBe(latest - Date.parse(cut.row.timestamp));
    expect(cut.ms).toBe(8000);
  });
  it("gives every ended action its duration, never one before it started", () => {
    const ended = steps(rowsOf("timeline.actions.completed")).filter((x) => x.row.kind === "tool_use");
    expect(ended).toHaveLength(11);
    for (const x of ended) expect(x.ms, x.row.summary).toBeGreaterThanOrEqual(0);
  });
  it("shows the live run's write as running, with no duration yet", () => {
    const live = steps(rowsOf("timeline.actions.working"));
    const write = live.find((x) => x.row.tool_status === "running")!;
    expect(write.row.summary).toBe("Wrote summary.md");
    expect(write.ms).toBeUndefined();
  });
});

// The shapes tell themselves apart by their rows: an older server's call row carries no status (null or absent), so it
// still pairs with its result row; only a call row with a status of its own is its whole story.
describe("steps, an older server's call row with no status of its own", () => {
  const r = (seq: number, kind: string, summary: string, at: string, over: Partial<TimelineRow> = {}): TimelineRow =>
    ({ id: `r${seq}`, seq, kind, summary, text: null, timestamp: `2026-11-03T16:41:${at}Z`, tool_name: null, ...over });
  it("pairs with its result whether its tool_status is null or absent", () => {
    for (const status of [{ tool_status: null }, {}]) {
      const s = steps([
        r(1, "tool_use", "Read notes.md", "25.615", { tool_name: "read", tool_use_id: "t2", ...status }),
        r(2, "tool_result", "Read notes.md: ok", "25.627", { tool_name: "read", tool_use_id: "t2", tool_status: "success" }),
      ]);
      expect(s.map((x) => [x.row.kind, x.row.summary, x.ms]), JSON.stringify(status)).toEqual([["tool_result", "Read notes.md", 12]]);
    }
  });
});

// The fold keeps each thing with its own call: a saved file with the call whose result it follows, a question's rows
// only behind that question's own waiting row, and a retried failure folded only when it is the same failure.
describe("steps, each fold with its own call", () => {
  const r = (seq: number, kind: string, summary: string, at: string, over: Partial<TimelineRow> = {}): TimelineRow =>
    ({ id: `r${seq}`, seq, kind, summary, text: null, timestamp: `2026-11-03T16:41:${at}Z`, tool_name: null, ...over });
  it("credits each saved file to the call whose result it follows, when two calls run before either returns", () => {
    const s = steps([
      r(1, "tool_use", "Wrote a.md", "01.000", { tool_name: "write", tool_use_id: "A" }),
      r(2, "tool_use", "Wrote b.md", "01.100", { tool_name: "write", tool_use_id: "B" }),
      r(3, "tool_result", "Wrote a.md: ok", "02.000", { tool_name: "write", tool_use_id: "A", tool_status: "success" }),
      r(4, "phase", "Saved a.md", "02.000", { path: "a.md" }),
      r(5, "tool_result", "Wrote b.md: ok", "03.000", { tool_name: "write", tool_use_id: "B", tool_status: "success" }),
      r(6, "phase", "Saved b.md", "03.000", { path: "b.md" }),
    ]);
    expect(s.map((x) => [x.row.summary, x.saved])).toEqual([["Wrote a.md", "a.md"], ["Wrote b.md", "b.md"]]);
  });
  it("hides a question's rows only behind its own waiting row, so a later ask that failed still shows", () => {
    const s = steps([
      r(1, "tool_use", "Asked you: Which currency?", "01.000", { id: "1:16:0", tool_name: "ask_person", tool_use_id: "q1" }),
      r(2, "tool_result", "Asked you: Which currency?", "01.100", { id: "1:17", tool_name: "ask_person", tool_use_id: "q1", tool_status: "success" }),
      r(3, "waiting", "Waiting for you: Which currency?", "01.100", { id: "1:17:waiting" }),
      r(4, "user_message", "You: EUR", "05.000"),
      r(5, "tool_use", "Asked you: Which rate?", "06.000", { tool_name: "ask_person", tool_use_id: "q2" }),
      r(6, "tool_result", "Asked you: Which rate? interrupted", "07.000", { tool_name: "ask_person", tool_use_id: "q2", tool_status: "failed" }),
    ]);
    expect(s.map((x) => [x.row.kind, x.row.summary])).toEqual([
      ["waiting", "Waiting for you: Which currency?"], ["user_message", "You: EUR"], ["tool_result", "Asked you: Which rate? interrupted"],
    ]);
  });
  it("folds a repeated failure only when its message, its detail and its agent are the same", () => {
    const err = (seq: number, text: string, agent: string | null = null) => r(seq, "error", "Model request failed: 529 overloaded", `0${seq}.000`, { text, agent_label: agent });
    const s = steps([err(1, "529 overloaded: retry 1"), err(2, "529 overloaded: retry 1"), err(3, "529 overloaded: the region is down"), err(4, "529 overloaded: the region is down", "judge")]);
    expect(s.map((x) => [x.row.text, x.row.agent_label ?? null, x.times ?? 1])).toEqual([
      ["529 overloaded: retry 1", null, 2], ["529 overloaded: the region is down", null, 1], ["529 overloaded: the region is down", "judge", 1],
    ]);
  });
});
