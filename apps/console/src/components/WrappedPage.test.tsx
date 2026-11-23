import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrappedPage } from "./WrappedPage";
import { route } from "@/App";
import { ClientError, type Client } from "@/lib/client";
import type { Wrapped } from "@/lib/v2";

// Wrapped over GET /v2/wrapped: the year's five plain sections from the numbers the server counted, an empty year said
// in a sentence, a server that refuses (it is not this machine's) said as a problem, and the year buttons going to the
// address of the year beside.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const YEAR: Wrapped = {
  year: 2025, sessions: 12, turns: 40, requests: 300, tokens: { input: 1_000_000, output: 200_000, cache_read: 5_000_000, cache_write: 100_000 },
  cost_usd: 42.5, unpriced_requests: 3,
  days: [{ day: "2025-03-02", requests: 100, tokens: 4_000_000 }, { day: "2025-03-03", requests: 200, tokens: 2_300_000 }],
  hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 120 : h === 9 ? 80 : 4)), weekdays: [0, 200, 100, 0, 0, 0, 0], active_ms: 7_200_000,
  harnesses: [{ harness: "claude-agent", sessions: 10, requests: 250, tokens: 6_000_000 }, { harness: "pi", sessions: 2, requests: 50, tokens: 300_000 }],
  models: [{ model: "anthropic/claude-sonnet", requests: 250, tokens: 6_000_000, cost_usd: 40 }, { model: "openai/gpt", requests: 50, tokens: 300_000, cost_usd: 2.5 }],
  sources: [{ source: "claude-code", sessions: 10, requests: 250 }, { source: "codex", sessions: 2, requests: 50 }],
  imported: [{ source: "claude-code", runs: 7 }],
};

async function mount(wrapped: () => Promise<Wrapped>, go = vi.fn(), year?: number) {
  const v2 = { wrapped: vi.fn(wrapped) } as unknown as Client;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(WrappedPage, { v2, year, go })); });
  return { go, v2 };
}

describe("WrappedPage", () => {
  it("asks for its year and shows each section from the server's numbers", async () => {
    const { v2 } = await mount(async () => YEAR, vi.fn(), 2025);
    expect((v2.wrapped as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(2025);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Wrapped 2025");
    expect(text).toContain("6.3M tokens");
    expect(text).toContain("12 sessions · 40 prompts · 300 model requests · $42.50 + 3 requests with no known price");
    expect(text).toContain("Busiest day: 2025-03-02");
    for (const name of ["Your year in tokens", "Harnesses and models", "When you work", "Imported"]) expect(text).toContain(name);
    expect(text).toContain("claude-agent");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("2.0 h at work");
    expect(document.querySelectorAll('[aria-label="Requests by hour of the day"] > div')).toHaveLength(24);
    expect(document.querySelectorAll('[aria-label="Requests by day of the week"] > div')).toHaveLength(7);
  });

  it("links a source's imported runs to the runs list of that source, and says when none are imported", async () => {
    await mount(async () => YEAR);
    const link = document.querySelector<HTMLAnchorElement>('a[href="#/runs?source=claude-code"]');
    expect(link?.textContent).toBe("7 imported as runs");
    expect(document.body.textContent).toContain("codex: 2 sessions read");
    expect(document.body.textContent).toContain("none imported as runs yet");
  });

  it("says a year with no sessions in a sentence", async () => {
    await mount(async () => ({ ...YEAR, requests: 0 }), vi.fn(), 2024);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("No coding agent sessions under this machine's home in 2024.");
  });

  it("shows a refusal as a problem with a retry", async () => {
    let calls = 0;
    await mount(async () => { calls += 1; throw new ClientError(403, "forbidden", "wrapped reads this machine's own session files"); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Your year could not be read");
    expect(calls).toBe(1);
  });

  it("goes to the year before, and not past this year", async () => {
    const now = new Date().getFullYear();
    const { go } = await mount(async () => YEAR);
    const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
    expect(button("Next year").disabled).toBe(true);
    await act(async () => { button("Previous year").click(); });
    expect(go).toHaveBeenCalledWith(`#/wrapped?year=${now - 1}`);
  });

  it("is the address #/wrapped, with a four-digit year when it names one", () => {
    expect(route("#/wrapped")).toEqual({ section: "wrapped" });
    expect(route("#/wrapped?year=2025")).toEqual({ section: "wrapped", year: 2025 });
    expect(route("#/wrapped?year=25")).toEqual({ section: "wrapped" });
  });
});
