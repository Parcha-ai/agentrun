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
  id: "eval_1", source: "invoice bench, sealed test", n: 200,
  learned: { accuracy: 0.94, ci: [0.902, 0.968], usd_per_job: 0.12 },
  by_hand: { accuracy: 0.81, ci: [0.75, 0.86], usd_per_job: 0.89 },
  learned_revision: "a1b2c3d4e5f6", measured_at: "2026-11-13T04:00:00.000Z", recorded_at: "2026-11-13T05:00:00.000Z",
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
  it("says accuracy against by hand in points with each side's interval, and the cost a job as how many times cheaper", () => {
    expect(headlineOf(RESULT)).toEqual({
      accuracy: "94%", accuracyVs: "81% by hand, +13 points", accuracyCi: "95% interval 90.2% to 96.8% (by hand 75% to 86%)",
      cost: "7.4x cheaper", costVs: "$0.120 a job, $0.890 by hand",
    });
    expect(headlineOf({ ...RESULT, learned: { ...RESULT.learned, accuracy: 0.78, ci: [0.7, 0.8] } }).accuracyVs).toBe("81% by hand, -3 points");
    expect(headlineOf({ ...RESULT, learned: { ...RESULT.learned, usd_per_job: null } })).toMatchObject({ cost: "Not counted", costVs: "The test did not count the cost a job." });
    expect(headlineOf({ ...RESULT, learned: { ...RESULT.learned, usd_per_job: 1.78 } }).cost).toBe("2x the cost");
  });
  it("draws the latest result with its jobs, source and revision, and Not measured yet with none", async () => {
    const host = await mount(createElement(HeldOutCard, { result: RESULT }));
    const text = host.textContent!;
    expect(text).toContain("200 jobs it never learned from · invoice bench, sealed test");
    expect(text).toContain("revision a1b2c3d");
    expect(text).toContain("Accuracy, learned94%81% by hand, +13 points");
    expect(text).toContain("Cost a job7.4x cheaper$0.120 a job, $0.890 by hand");
    act(() => root!.unmount()); document.body.innerHTML = "";
    const none = await mount(createElement(HeldOutCard, { result: null }));
    expect(none.querySelector("[role=status]")!.textContent).toBe(`Not measured yet.${RECORD_HOW}`);
  });
  it("reads the agent's results, shows the newest, and a failed read is a problem card with Try again", async () => {
    let fail = true;
    const v2 = { learningEvals: async () => { if (fail) throw new ClientError(500, "internal", "boom"); return { agent: "a", evals: [RESULT, { ...RESULT, id: "eval_0", n: 50 }] }; } } as unknown as Client;
    const host = await mount(createElement(HeldOutTest, { v2, agentId: "a" }));
    expect(host.querySelector("[role=alert]")!.textContent).toContain("The held-out test could not be read.");
    fail = false;
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=alert] button")!.click(); });
    expect(host.textContent).toContain("200 jobs it never learned from");
  });
  it("quiet (under the tab's empty state) shows nothing until a result is recorded", async () => {
    let evals: LearningEval[] = [];
    const v2 = { learningEvals: async () => ({ agent: "a", evals }) } as unknown as Client;
    const none = await mount(createElement(HeldOutTest, { v2, agentId: "a", quiet: true }));
    expect(none.innerHTML).toBe("");
    act(() => root!.unmount()); document.body.innerHTML = "";
    evals = [RESULT];
    const some = await mount(createElement(HeldOutTest, { v2, agentId: "a", quiet: true }));
    expect(some.querySelector('[data-testid="held-out-test"]')!.textContent).toContain("94%");
  });
});
