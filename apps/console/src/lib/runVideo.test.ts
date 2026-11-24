import { describe, expect, it } from "vitest";
import { steps } from "./timeline";
import { recordingStart, stepAt, stepCall, videoClock, videoSteps } from "./runVideo";
import type { TimelineRow } from "./v2";

// A recording's steps: the run's timeline put on the video's clock. The server never says when a recording began on the
// run read, so the start is the time of the timeline row that names the file ("Recording the desktop's screen into
// recordings/desktop.mp4."), and a step's place on the video is when it happened less that. A tool's call row is dated
// when the model's turn began, so a tool step is placed when it ran: its first computer call's start, else its result.
let seq = 0;
const row = (kind: TimelineRow["kind"], summary: string, timestamp: string, more: Partial<TimelineRow> = {}): TimelineRow => ({
  id: `r${(seq += 1)}`, seq, kind, summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null,
  tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...more,
} as TimelineRow);
const at = (s: number) => new Date(Date.parse("2026-11-05T09:00:00Z") + s * 1000).toISOString();

const RUN = [
  row("user_message", "You: Find the cheapest nonstop.", at(-30)),
  row("phase", "The desktop is ready: Linux (amd64), from E2B.", at(-2)),
  row("phase", "Recording the desktop's screen into recordings/desktop.mp4.", at(0)),
  row("tool_use", "computer_act", at(3), { tool_name: "computer_act", tool_use_id: "t1" }),
  row("tool_result", "Opened Chrome: ok", at(5), { tool_name: "computer_act", tool_use_id: "t1", tool_status: "success" }),
  row("thinking", "Thinking: Six results, two of them nonstop.", at(12)),
  row("phase", "You took over the desktop", at(20)),
  row("phase", "You handed the desktop back", at(31)),
  row("final_answer", "Skyline 214, $238.", at(40)),
  row("usage", "Cost so far: $0.12", at(41)),
  row("phase", "Recording the desktop's screen into recordings/desktop-2.mp4.", at(100)),
  row("tool_use", "computer_observe", at(104), { tool_name: "computer_observe", tool_use_id: "t2" }),
  row("tool_result", "Looked at Chrome: ok", at(105), { tool_name: "computer_observe", tool_use_id: "t2", tool_status: "success" }),
];

describe("recordingStart", () => {
  it("is the time of the row that names the file, a first file's and a later one's", () => {
    expect(recordingStart(RUN, "recordings/desktop.mp4")).toBe(Date.parse(at(0)));
    expect(recordingStart(RUN, "recordings/desktop-2.mp4")).toBe(Date.parse(at(100)));
    const changed = [row("phase", "The phone's frames changed from PNG to JPEG: the recording goes on in recordings/phone-2.mp4.", at(50))];
    expect(recordingStart(changed, "recordings/phone-2.mp4")).toBe(Date.parse(at(50)));
  });

  it("is undefined when no row names the file: another file's row, or the row that says it stopped, is not its start", () => {
    expect(recordingStart(RUN, "recordings/phone.mp4")).toBeUndefined();
    const stopped = [row("phase", "The recording of the desktop stopped: the disk is full. recordings/desktop.mp4 keeps what was recorded until then.", at(9))];
    expect(recordingStart(stopped, "recordings/desktop.mp4")).toBeUndefined();
    // Only the server's own line: a message that quotes it is not when the file began.
    expect(recordingStart([row("user_message", "You: it said Recording the desktop's screen into recordings/desktop.mp4.", at(1))], "recordings/desktop.mp4")).toBeUndefined();
  });
});

describe("videoSteps", () => {
  it("puts each step made while the file was recorded at its time on the video, a tool once, when its result came", () => {
    const told = videoSteps(RUN, { path: "recordings/desktop.mp4", seconds: 42 });
    expect(told.map((s) => [s.at, s.step.row.summary])).toEqual([
      [0, "Recording the desktop's screen into recordings/desktop.mp4."],
      [5, "Opened Chrome"],
      [12, "Thinking: Six results, two of them nonstop."],
      [20, "You took over the desktop"],
      [31, "You handed the desktop back"],
      [40, "Skyline 214, $238."],
    ]);
  });

  it("leaves out what came before the recording, what came after its length, and the run's cost row", () => {
    const told = videoSteps(RUN, { path: "recordings/desktop.mp4", seconds: 42 });
    const said = told.map((s) => s.step.row.summary);
    expect(said).not.toContain("You: Find the cheapest nonstop.");
    expect(said).not.toContain("Looked at Chrome");
    expect(told.some((s) => s.step.row.kind === "usage")).toBe(false);
  });

  it("gives a later file its own steps, from its own start", () => {
    const told = videoSteps(RUN, { path: "recordings/desktop-2.mp4", seconds: 10 });
    expect(told.map((s) => [s.at, s.step.row.summary])).toEqual([[0, "Recording the desktop's screen into recordings/desktop-2.mp4."], [5, "Looked at Chrome"]]);
  });

  it("places a call that waited on a person's hand-back when it ran, after the take-over, never at its model turn's start", () => {
    // The call's row is dated when the model's turn began (just after the look before it); the person then took the
    // desktop, and the call ran only once it was handed back.
    const held = [
      row("phase", "Recording the desktop's screen into recordings/desktop.mp4.", at(0)),
      row("tool_use", "computer_screenshot", at(0.1), { tool_name: "computer_screenshot", tool_use_id: "h1" }),
      row("tool_result", "Took a screenshot: ok", at(0.2), { tool_name: "computer_screenshot", tool_use_id: "h1", tool_status: "success" }),
      row("phase", "You took over the desktop", at(22)),
      row("tool_use", "computer_screenshot", at(0.3), { tool_name: "computer_screenshot", tool_use_id: "h2" }),
      row("phase", "You handed the desktop back", at(25)),
      row("tool_result", "Took a screenshot: ok", at(25.1), { tool_name: "computer_screenshot", tool_use_id: "h2", tool_status: "success" }),
    ];
    const told = videoSteps(held, { path: "recordings/desktop.mp4", seconds: 30 });
    expect(told.map((s) => [s.at, s.step.row.summary])).toEqual([
      [0, "Recording the desktop's screen into recordings/desktop.mp4."],
      [0.2, "Took a screenshot"],
      [22, "You took over the desktop"],
      [25, "You handed the desktop back"],
      [25.1, "Took a screenshot"],
    ]);
    // In the video's order, the step the video is at is the one a viewer sees there.
    expect(told[stepAt(told, 23)]!.step.row.summary).toBe("You took over the desktop");
    expect(told[stepAt(told, 26)]!.step.row.summary).toBe("Took a screenshot");
  });

  it("places a computer tool at its first call's start, where the server kept its calls", () => {
    const acted = [
      row("phase", "Recording the desktop's screen into recordings/desktop.mp4.", at(0)),
      row("tool_use", "computer_act", at(2), { tool_name: "computer_act", tool_use_id: "k1" }),
      row("tool_result", "Clicked “Sort”, clicked “Price: low to high”: ok", at(14), { tool_name: "computer_act", tool_use_id: "k1", tool_status: "success",
        computer_calls: [{ method: "input.actions", started_at: at(9), ok: true, ms: 800 }, { method: "input.actions", started_at: at(11), ok: true, ms: 900 }] } as Partial<TimelineRow>),
    ];
    expect(videoSteps(acted, { path: "recordings/desktop.mp4", seconds: 30 }).map((s) => s.at)).toEqual([0, 9]);
  });

  it("leaves out a step whose result came after the recording's length, though its call began inside it", () => {
    const late = [
      row("phase", "Recording the desktop's screen into recordings/desktop.mp4.", at(0)),
      row("tool_use", "bash", at(5), { tool_name: "bash", tool_use_id: "z1" }),
      row("tool_result", "ran: ok", at(50), { tool_name: "bash", tool_use_id: "z1", tool_status: "success" }),
    ];
    expect(videoSteps(late, { path: "recordings/desktop.mp4", seconds: 10 }).map((s) => s.step.row.summary)).toEqual(["Recording the desktop's screen into recordings/desktop.mp4."]);
  });

  it("has none when the timeline doesn't say when the recording began", () => {
    expect(videoSteps(RUN.filter((r) => r.kind !== "phase"), { path: "recordings/desktop.mp4", seconds: 42 })).toEqual([]);
    expect(videoSteps([], { path: "recordings/desktop.mp4", seconds: 42 })).toEqual([]);
  });
});

describe("stepAt", () => {
  const told = videoSteps(RUN, { path: "recordings/desktop.mp4", seconds: 42 });
  it("is the last step that began at or before the video's time", () => {
    expect(stepAt(told, 0)).toBe(0);
    expect(stepAt(told, 4.9)).toBe(0);
    expect(stepAt(told, 5)).toBe(1);
    expect(stepAt(told, 25)).toBe(3);
    expect(stepAt(told, 999)).toBe(5);
  });
  it("is -1 before the first step, and with no steps", () => {
    expect(stepAt(told.slice(1), 1)).toBe(-1);
    expect(stepAt([], 10)).toBe(-1);
  });
});

describe("videoClock", () => {
  it("says a time as a player does", () => {
    expect(videoClock(0)).toBe("0:00");
    expect(videoClock(7.9)).toBe("0:07");
    expect(videoClock(158)).toBe("2:38");
    expect(videoClock(760)).toBe("12:40");
    expect(videoClock(3725)).toBe("1:02:05");
    expect(videoClock(-3)).toBe("0:00");
  });
});

describe("the tool call a step is", () => {
  it("is the call's id, from its row or from its result's once the result folded into it; none for a step that is no call", () => {
    const told = steps([
      row("phase", "The desktop is ready.", "2026-11-05T09:00:00Z"),
      row("tool_use", "computer_act", "2026-11-05T09:00:04Z", { tool_name: "computer_act", tool_use_id: "call_a" }),
      row("tool_result", "Opened Chrome: ok", "2026-11-05T09:00:06Z", { tool_name: "computer_act", tool_use_id: "call_a", tool_status: "success" }),
      row("tool_use", "computer_act", "2026-11-05T09:00:08Z", { tool_name: "computer_act", tool_use_id: "call_b" }),
    ]);
    expect(told.map(stepCall)).toEqual([null, "call_a", "call_b"]);
  });
});
