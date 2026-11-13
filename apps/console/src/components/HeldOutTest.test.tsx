import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { headlineOf, HeldOutCard, HeldOutTest, RECORD_HOW } from "./HeldOutTest";
import { ClientError, type Client } from "@/lib/client";
import type { LearningEval } from "@/lib/v2";

// The Learning tab's headline: the latest held-out test recorded for the agent (GET /v2/agents/{id}/learning/evals), an
// invented invoice-sorter's; "Not measured yet" with none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESULT: LearningEval = {
  id: "eval_1", name: "invoice bench, sealed test", label_source: "teacher labels, 87% strict vs people", n: 200, correct: 188,
  accuracy: 0.94, ci: [0.8981, 0.9653], cost_per_task_usd: 0.12, baseline_cost_per_task_usd: 0.89,
  learned_revision: "a1b2c3d4e5f6", recorded_at: "2026-11-13T05:00:00.000Z",
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const mount = async (element: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
};

describe("the held-out headline", () => {
  it("says the server's accuracy with its 95% interval and n, and the cost a task as how many times cheaper than by hand", () => {
    expect(headlineOf(RESULT)).toEqual({
      accuracy: "94%", accuracyVs: "95% interval 89.8% to 96.5%, n=200",
      cost: "7.4x cheaper", costVs: "$0.120 a task vs $0.890 by hand",
    });
    expect(headlineOf({ ...RESULT, baseline_cost_per_task_usd: null })).toMatchObject({ cost: "$0.120", costVs: "$0.120 a task; by hand not counted" });
    expect(headlineOf({ ...RESULT, cost_per_task_usd: null, baseline_cost_per_task_usd: null })).toMatchObject({ cost: "Not counted", costVs: "The test did not count the cost a task." });
    expect(headlineOf({ ...RESULT, cost_per_task_usd: 1.78 }).cost).toBe("2x the cost");
    // A free baseline has no ratio: the dollar figures, never "Infinityx the cost".
    expect(headlineOf({ ...RESULT, baseline_cost_per_task_usd: 0 })).toMatchObject({ cost: "$0.120", costVs: "$0.120 a task vs $0 by hand" });
  });
  it("draws the latest record with its jobs, name, revision and label source, and Not measured yet with none", async () => {
    const host = await mount(createElement(HeldOutCard, { result: RESULT }));
    const text = host.textContent!;
    expect(text).toContain("200 jobs it never learned from · invoice bench, sealed test");
    expect(text).toContain("revision a1b2c3d");
    expect(text).toContain("Held-out accuracy94%95% interval 89.8% to 96.5%, n=200");
    expect(text).toContain("Cost a task7.4x cheaper$0.120 a task vs $0.890 by hand");
    expect(text).toContain("Labels: teacher labels, 87% strict vs people");
    act(() => root!.unmount()); document.body.innerHTML = "";
    const none = await mount(createElement(HeldOutCard, { result: null }));
    expect(none.querySelector("[role=status]")!.textContent).toBe(`Not measured yet.${RECORD_HOW}`);
  });
  it("reads the agent's records, shows the latest, and a failed read is a problem card with Try again", async () => {
    let fail = true;
    const v2 = { learningEvals: async () => { if (fail) throw new ClientError(500, "internal", "boom"); return { agent: "a", latest: RESULT, evals: [RESULT, { ...RESULT, id: "eval_0", n: 50 }] }; } } as unknown as Client;
    const host = await mount(createElement(HeldOutTest, { v2, agentId: "a" }));
    expect(host.querySelector("[role=alert]")!.textContent).toContain("The held-out test could not be read.");
    fail = false;
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=alert] button")!.click(); });
    expect(host.textContent).toContain("200 jobs it never learned from");
  });
  it("quiet (under the tab's empty state) shows nothing until a record exists", async () => {
    let latest: LearningEval | null = null;
    const v2 = { learningEvals: async () => ({ agent: "a", latest, evals: latest ? [latest] : [] }) } as unknown as Client;
    const none = await mount(createElement(HeldOutTest, { v2, agentId: "a", quiet: true }));
    expect(none.innerHTML).toBe("");
    act(() => root!.unmount()); document.body.innerHTML = "";
    latest = RESULT;
    const some = await mount(createElement(HeldOutTest, { v2, agentId: "a", quiet: true }));
    expect(some.querySelector('[data-testid="held-out-test"]')!.textContent).toContain("94%");
  });
});
