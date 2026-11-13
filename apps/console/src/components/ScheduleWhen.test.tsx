import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleWhen } from "./ScheduleWhen";
import { optionsOf, pick, picker, valueOf } from "@/test/picker";

// The schedule picker (the Triggers form's and a template's cron parameter's): a shape and its time in words, written as
// the cron line; a line of no shape here stays a typed line, said back in words; a line is only rewritten when edited.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function open(start: string) {
  const lines: string[] = [];
  function Host() {
    const [line, setLine] = useState(start);
    return createElement(ScheduleWhen, { label: "Runs", name: "cron", value: line, onChange: (v: string) => { lines.push(v); setLine(v); } });
  }
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Host)));
  const shape = () => picker(host, "Runs")!;
  const time = () => host.querySelector<HTMLInputElement>('input[type="time"]');
  const line = () => host.querySelector<HTMLInputElement>('input[aria-label="Custom schedule"]');
  const type = async (el: HTMLInputElement | null, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { host, lines, shape, time, line, type };
}

describe("the schedule picker", () => {
  it("shows a weekly line as its day and time, and writes each change as the cron line", async () => {
    const t = open("0 8 * * 1");
    expect(valueOf(t.shape())).toBe("weekly");
    expect(valueOf(picker(t.host, "Day of the week")!)).toBe("1");
    expect(t.time()!.value).toBe("08:00");
    expect(t.line()).toBeNull();
    expect(t.lines).toEqual([]);
    await pick(picker(t.host, "Day of the week")!, "3");
    await t.type(t.time(), "17:45");
    await pick(t.shape(), "daily");
    await pick(t.shape(), "hourly");
    await pick(picker(t.host, "Minutes past the hour")!, "15");
    await pick(t.shape(), "monthly");
    await pick(picker(t.host, "Day of the month")!, "28");
    expect(t.lines).toEqual(["0 8 * * 3", "45 17 * * 3", "45 17 * * *", "45 * * * *", "15 * * * *", "15 9 1 * *", "15 9 28 * *"]);
  });

  it("offers every shape and a custom line, Monday first among the days", async () => {
    const t = open("0 8 * * 1");
    expect((await optionsOf(t.shape())).map((o) => o.text)).toEqual(["Every hour", "Every day", "Every weekday (Monday to Friday)", "Every week", "Every month", "Custom schedule"]);
    expect((await optionsOf(picker(t.host, "Day of the week")!)).map((o) => o.text)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  });

  it("keeps a line of no shape here as a typed line, said back in words, and never rewrites it unasked", async () => {
    const t = open("*/15 9-17 * * 1-5");
    expect(valueOf(t.shape())).toBe("custom");
    expect(t.line()!.value).toBe("*/15 9-17 * * 1-5");
    expect(t.line()!.name).toBe("cron");
    expect(t.host.textContent).toContain("Every 15 minutes, between 09:00 and 17:59, Monday through Friday");
    await t.type(t.line(), "0 6 * * 6");
    // A typed line that has a shape stays typed while it is being typed.
    expect(t.line()!.value).toBe("0 6 * * 6");
    expect(t.host.textContent).toContain("At 06:00, only on Saturday");
    expect(t.lines).toEqual(["0 6 * * 6"]);
  });

  it("switches to a custom line keeping the line it had, and back to a shape from it", async () => {
    const t = open("30 7 * * *");
    await pick(t.shape(), "custom");
    expect(t.line()!.value).toBe("30 7 * * *");
    expect(t.lines).toEqual([]);
    await pick(t.shape(), "weekly");
    expect(t.lines).toEqual(["30 7 * * 1"]);
    expect(t.line()).toBeNull();
  });

  it("with no line yet, asks for one and writes none until a shape is picked", async () => {
    const t = open("");
    expect(valueOf(t.shape())).toBe("");
    expect(t.time()).toBeNull();
    expect(t.lines).toEqual([]);
    await pick(t.shape(), "weekdays");
    expect(t.lines).toEqual(["0 9 * * 1-5"]);
    expect(t.time()!.value).toBe("09:00");
  });
});
