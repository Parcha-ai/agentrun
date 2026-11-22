import { describe, expect, it } from "vitest";
import { recordingStart, stepAt, videoClock, videoSteps } from "./runVideo";
import type { TimelineRow } from "./v2";

// A recording's steps: the run's timeline put on the video's clock. The server never says when a recording began on the
// run read, so the start is the time of the timeline row that names the file ("Recording the desktop's screen into
// recordings/desktop.mp4."), and a step's place on the video is its row's time less that.
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
  it("puts each step made while the file was recorded at its time on the video, a tool once at its call", () => {
    const told = videoSteps(RUN, { path: "recordings/desktop.mp4", seconds: 42 });
    expect(told.map((s) => [s.at, s.step.row.summary])).toEqual([
      [0, "Recording the desktop's screen into recordings/desktop.mp4."],
      [3, "Opened Chrome"],
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
    expect(told.map((s) => [s.at, s.step.row.summary])).toEqual([[0, "Recording the desktop's screen into recordings/desktop-2.mp4."], [4, "Looked at Chrome"]]);
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
    expect(stepAt(told, 2.9)).toBe(0);
    expect(stepAt(told, 3)).toBe(1);
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
