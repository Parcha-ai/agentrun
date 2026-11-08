import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleChip, ScheduleNames, useScheduleKnown } from "./ScheduleChip";

// What the app knows of its schedules (useScheduleKnown) with the chips that ask about one: a fresh read decides deleted;
// a schedule found once and deleted later is asked about again; and a chip that asked before schedules could be read
// (capabilities not read yet) asks again once they can. Read from the DOM.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function Page({ v2, scheduling, page, ids }: { v2: { listTriggers: () => Promise<{ triggers: { id: string; name: string; source: { kind: string } }[] }> }; scheduling: boolean; page: number; ids: string[] }) {
  const known = useScheduleKnown(v2, scheduling, [page]);
  return createElement(ScheduleNames.Provider, { value: known }, ids.map((id) => createElement("div", { key: `${id}:${page}`, "data-run": id }, createElement(ScheduleChip, { run: { trigger: { id, firing_key: "f" } } }))));
}

describe("useScheduleKnown with its chips", () => {
  it("a schedule found once and deleted since is asked about again, then reads as deleted", async () => {
    let list = [{ id: "trg_x", name: "nightly", source: { kind: "schedule" } }];
    let reads = 0;
    const v2 = { listTriggers: async () => { reads++; return { triggers: list }; } };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Page, { v2, scheduling: true, page: 1, ids: ["trg_x"] })));
    await settle();
    expect(host.textContent).toContain("Schedule: nightly");
    // Deleted on the server; the next page change reads the list without it, and the chip asks again.
    list = [];
    act(() => root!.render(createElement(Page, { v2, scheduling: true, page: 2, ids: ["trg_x"] })));
    await settle();
    expect(host.textContent).toContain("Trigger deleted");
    expect(host.querySelectorAll("a[href^='#/schedules/']")).toHaveLength(0);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("a chip that asked before schedules could be read asks again once they can, and a deleted one reads as deleted", async () => {
    const v2 = { listTriggers: async () => ({ triggers: [] as { id: string; name: string; source: { kind: string } }[] }) };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Page, { v2, scheduling: false, page: 1, ids: ["trg_gone"] })));
    await settle();
    expect(host.textContent).toContain("Trigger: trg_gone");
    act(() => root!.render(createElement(Page, { v2, scheduling: true, page: 1, ids: ["trg_gone"] })));
    await settle();
    expect(host.textContent).toContain("Trigger deleted");
  });
});
