import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { RunsList } from "./RunsList";
import { ScheduleChip, ScheduleNames, TriggerReads, useTriggerKnown } from "./ScheduleChip";
import { messageFeatures } from "@/fixtures";
import type { Run, Trigger, TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const run = (trigger: string | null): Run => ({
  run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", agent_id: "triage", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle",
  title: "Qualify the lead.", created_at: "2026-11-05T09:30:01Z", ended_at: "2026-11-05T09:31:00Z", result: null, error: null, cost: null, archived_at: null,
  trigger: trigger ? { id: trigger, firing_key: "fir_1" } : null,
} as unknown as Run);
const mount = (el: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
const reads = (gone: string[], ask: (id: string) => void = () => {}) => ({ gone: new Set(gone), ask });
const chipIn = (host: HTMLElement) => host.querySelector("[data-trigger-chip]");

// A run whose trigger was deleted says so, and links nowhere: its trigger's page would only answer 404. It's said only
// once a read of the triggers made after the run was shown lacks it, so a trigger made since the last read is never
// called deleted.
describe("a run whose trigger was deleted", () => {
  it("reads Trigger deleted, with no link, once a fresh read lacks it", () => {
    const host = mount(createElement(TriggerReads.Provider, { value: reads(["trg_gone"]) }, createElement(ScheduleChip, { run: run("trg_gone") })));
    expect(chipIn(host)?.textContent).toBe("Trigger deleted");
    expect(host.querySelector("a")).toBeNull();
  });

  it("by its kind where the run's page knows it: Schedule deleted", () => {
    const host = mount(createElement(TriggerReads.Provider, { value: reads(["trg_gone"]) }, createElement(ScheduleChip, { run: run("trg_gone"), kind: "schedule" })));
    expect(chipIn(host)?.textContent).toBe("Schedule deleted");
  });

  it("until that read answers, names its id, and asks for the read once", () => {
    const ask = vi.fn();
    const host = mount(createElement(TriggerReads.Provider, { value: reads([], ask) }, createElement(ScheduleChip, { run: run("trg_new") })));
    expect(chipIn(host)?.textContent).toBe("Trigger: trg_new");
    expect(ask).toHaveBeenCalledWith("trg_new");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a known trigger never asks", () => {
    const ask = vi.fn();
    mount(createElement(ScheduleNames.Provider, { value: new Map([["trg_s", { name: "nightly", kind: "schedule" as const }]]) },
      createElement(TriggerReads.Provider, { value: reads([], ask) }, createElement(ScheduleChip, { run: run("trg_s") }))));
    expect(ask).not.toHaveBeenCalled();
  });

  it("on the run's page, the kind comes from the run's own trigger row", () => {
    const rows = [{ id: "u1", seq: 1, kind: "user_message", origin: "trigger", summary: "Schedule nightly: Triage.", text: "Triage.", timestamp: "2026-11-05T09:30:01Z", trigger: { id: "trg_gone", source: "schedule", owner: true } } as unknown as TimelineRow];
    const host = mount(createElement(TriggerReads.Provider, { value: reads(["trg_gone"]) },
      createElement(RunDetail, { run: run("trg_gone"), agentName: "Triage", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {} })));
    expect(chipIn(host.querySelector("header")!)?.textContent).toBe("Schedule deleted");
  });
});

// The app's read of the triggers: the names and kinds, and the ids a fresh read asked for by a chip didn't find.
describe("useTriggerKnown", () => {
  const trigger = (id: string, name: string) => ({ id, name, source: { kind: "schedule", cron: "0 8 * * *" } } as unknown as Trigger);
  // `page`: the app's page; a change reads the list again, as App's route does.
  function Probe({ v2, on, page = "runs" }: { v2: { listTriggers: () => Promise<{ triggers: Trigger[] }> }; on: (got: ReturnType<typeof useTriggerKnown>) => void; page?: string }) {
    on(useTriggerKnown(v2, true, [page]));
    return null;
  }

  it("a fresh read that lacks the asked id calls it gone; one that has it names it", async () => {
    // The app's first read, then every read after a trigger was made in another tab.
    let reads = 0;
    const v2 = { listTriggers: vi.fn(async () => ({ triggers: reads++ === 0 ? [trigger("trg_a", "a")] : [trigger("trg_a", "a"), trigger("trg_new", "new one")] })) };
    let got: ReturnType<typeof useTriggerKnown> | undefined;
    await act(async () => { mount(createElement(Probe, { v2, on: (g) => { got = g; } })); });
    expect(got!.known.get("trg_a")?.name).toBe("a");
    await act(async () => { got!.reads.ask("trg_new"); got!.reads.ask("trg_gone"); });
    expect(got!.known.get("trg_new")?.name).toBe("new one");
    expect(got!.reads.gone.has("trg_new")).toBe(false);
    expect(got!.reads.gone.has("trg_gone")).toBe(true);
  });

  it("asks the server once per id", async () => {
    const v2 = { listTriggers: vi.fn(async () => ({ triggers: [] as Trigger[] })) };
    let got: ReturnType<typeof useTriggerKnown> | undefined;
    await act(async () => { mount(createElement(Probe, { v2, on: (g) => { got = g; } })); });
    const before = v2.listTriggers.mock.calls.length;
    await act(async () => { got!.reads.ask("trg_x"); got!.reads.ask("trg_x"); });
    expect(v2.listTriggers.mock.calls.length - before).toBe(1);
  });

  // A runs page of many runs whose triggers were deleted asks once: one fresh read answers every id waiting on it.
  it("many missing ids share one read", async () => {
    const v2 = { listTriggers: vi.fn(async () => ({ triggers: [] as Trigger[] })) };
    let got: ReturnType<typeof useTriggerKnown> | undefined;
    await act(async () => { mount(createElement(Probe, { v2, on: (g) => { got = g; } })); });
    const before = v2.listTriggers.mock.calls.length;
    await act(async () => { for (let i = 0; i < 50; i++) got!.reads.ask(`trg_${i}`); });
    expect(v2.listTriggers.mock.calls.length - before).toBe(1);
    expect(got!.reads.gone.size).toBe(50);
  });

  // A trigger a fresh read found, deleted later: the next read that lacks it calls it gone, so its runs stop linking to a
  // page that would answer 404.
  it("a trigger found once and deleted later reads gone after the next read", async () => {
    let reads = 0;
    const v2 = { listTriggers: vi.fn(async () => ({ triggers: reads++ === 1 ? [trigger("trg_a", "a"), trigger("trg_new", "new one")] : [trigger("trg_a", "a")] })) };
    let got: ReturnType<typeof useTriggerKnown> | undefined;
    const on = (g: ReturnType<typeof useTriggerKnown>) => { got = g; };
    await act(async () => { mount(createElement(Probe, { v2, on })); });
    await act(async () => { got!.reads.ask("trg_new"); });
    expect(got!.known.get("trg_new")?.name).toBe("new one");
    expect(got!.reads.gone.has("trg_new")).toBe(false);
    await act(async () => { root!.render(createElement(Probe, { v2, on, page: "run" })); });
    expect(got!.known.has("trg_new")).toBe(false);
    expect(got!.reads.gone.has("trg_new")).toBe(true);
  });
});

// On a phone the runs list never widens past the screen: the run's cell takes the room the table leaves it, so a long
// title wraps and a trigger chip truncates inside it.
describe("the runs list on a phone", () => {
  it("the run's cell takes the room the table leaves", () => {
    const host = mount(createElement(RunsList, { runs: [run("trg_1")], agentName: (id: string) => id, onOpen: () => {} }));
    const cell = host.querySelector("tbody tr td:nth-child(2)")!;
    expect(cell.classList.contains("w-full")).toBe(true);
    expect(cell.classList.contains("max-w-0")).toBe(true);
  });
});
