import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrappedPage } from "./WrappedPage";
import { noCards, WRAPPED_CARDS, type CardRenderer } from "@/lib/wrappedCards";
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
  cost_usd: 42.5, unpriced_requests: 3, unread_files: 0,
  days: [{ day: "2025-03-02", requests: 100, tokens: 4_000_000 }, { day: "2025-03-03", requests: 200, tokens: 2_300_000 }],
  hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 120 : h === 9 ? 80 : 4)), weekdays: [0, 200, 100, 0, 0, 0, 0], active_ms: 7_200_000,
  harnesses: [{ harness: "claude-agent", sessions: 10, requests: 250, tokens: 6_000_000, sources: ["claude-code"] }, { harness: "pi", sessions: 2, requests: 50, tokens: 300_000, sources: ["gemini", "pi"] }],
  models: [{ model: "anthropic/claude-sonnet", requests: 250, tokens: 6_000_000, cost_usd: 40, unpriced_requests: 3 }, { model: "openai/gpt", requests: 50, tokens: 300_000, cost_usd: 2.5, unpriced_requests: 0 }],
  sources: [{ source: "claude-code", sessions: 10, requests: 250 }, { source: "codex", sessions: 2, requests: 50 }],
  imported: [{ source: "claude-code", runs: 7 }, { source: "gemini", runs: 4 }],
};

async function mount(wrapped: () => Promise<Wrapped>, go = vi.fn(), year?: number, cards?: CardRenderer) {
  const v2 = { wrapped: vi.fn(wrapped) } as unknown as Client;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(WrappedPage, { v2, year, go, cards })); });
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
    // A harness by the name the console gives it, not its id.
    expect(text).toContain("Claude");
    expect(text).not.toContain("claude-agent");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("2.0 h at work");
    expect(document.querySelectorAll('[aria-label="Requests by hour of the day"] > li')).toHaveLength(24);
    expect(document.querySelectorAll('[aria-label="Requests by day of the week"] > li')).toHaveLength(7);
  });

  it("gives each chart's counts as text a screen reader reads, and hides the bars from it", async () => {
    await mount(async () => YEAR, vi.fn(), 2025);
    const hours = document.querySelector('ul.sr-only[aria-label="Requests by hour of the day"]');
    expect(hours?.children[14]?.textContent).toBe("14:00: 120");
    expect(document.querySelector('ul.sr-only[aria-label="Tokens by month"]')?.children[2]?.textContent).toBe("Mar: 6,300,000");
    expect(document.querySelector('[role="img"]')).toBeNull();
    expect(document.querySelectorAll('[aria-hidden="true"][class*="items-end"]').length).toBe(3);
  });

  it("says a model's cost counts priced requests only on the model with unpriced requests, and no price at all on one with none priced", async () => {
    const models = { ...YEAR, models: [...YEAR.models, { model: "fx/unlisted", requests: 4, tokens: 1_000, cost_usd: 0, unpriced_requests: 4 }] };
    await mount(async () => models, vi.fn(), 2025);
    const row = (model: string) => [...document.querySelectorAll('[aria-label="Models"] > li')].find((li) => li.textContent?.includes(model))!.textContent;
    expect(row("anthropic/claude-sonnet")).toContain("$40.00 priced only");
    expect(row("openai/gpt")).toContain("$2.50");
    expect(row("openai/gpt")).not.toContain("priced only");
    expect(row("fx/unlisted")).toContain("no known price");
    expect(row("fx/unlisted")).not.toContain("$0.00");
  });

  it("lists a source that is only imported (its session files are gone), also in a year with no requests", async () => {
    await mount(async () => ({ ...YEAR, sources: [], imported: [{ source: "codex", runs: 3 }] }), vi.fn(), 2025);
    expect(document.body.textContent).toContain("codex: no session files read in this year");
    expect(document.querySelector('a[href="#/runs?source=codex"]')?.textContent).toBe("3 imported as runs");
    document.body.innerHTML = "";
    await mount(async () => ({ ...YEAR, requests: 0, sources: [], imported: [{ source: "codex", runs: 3 }] }), vi.fn(), 2024);
    expect(document.body.textContent).toContain("No coding agent sessions under this machine's home in 2024.");
    expect(document.querySelector('a[href="#/runs?source=codex"]')).not.toBeNull();
  });

  it("links a source's imported runs to the runs list of that source, and says when none are imported", async () => {
    await mount(async () => YEAR);
    const link = document.querySelector<HTMLAnchorElement>('[aria-labelledby="w-imported"] a[href="#/runs?source=claude-code"]');
    expect(link?.textContent).toBe("7 imported as runs");
    expect(document.body.textContent).toContain("codex: 2 sessions read");
    expect(document.body.textContent).toContain("none imported as runs yet");
  });

  it("warns when session files could not be read, beside the totals and in an empty year, and says nothing when none failed", async () => {
    await mount(async () => ({ ...YEAR, unread_files: 2 }), vi.fn(), 2025);
    expect(document.querySelector('[data-unread]')?.textContent).toBe("2 session files could not be read, so these numbers may be incomplete.");
    expect(document.body.textContent).toContain("6.3M tokens");
    document.body.innerHTML = "";
    await mount(async () => ({ ...YEAR, requests: 0, unread_files: 1 }), vi.fn(), 2024);
    expect(document.querySelector('[data-unread]')?.textContent).toBe("1 session file could not be read, so these numbers may be incomplete.");
    expect(document.body.textContent).toContain("No readable coding agent sessions");
    document.body.innerHTML = "";
    await mount(async () => YEAR, vi.fn(), 2025);
    expect(document.querySelector('[data-unread]')).toBeNull();
  });

  it("links each harness's numbers to the runs of every source behind it: one source, several, and a source with no imported runs", async () => {
    await mount(async () => YEAR);
    const row = (harness: string) => [...document.querySelectorAll('[aria-label="Harnesses"] > li')].find((li) => li.textContent?.includes(harness))!;
    const hrefs = (harness: string) => [...row(harness).querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs("Claude")).toEqual(["#/runs?source=claude-code"]);
    expect(row("Claude").textContent).toContain("claude-code: 7 runs");
    expect(hrefs("Pi")).toEqual(["#/runs?source=gemini"]);
    expect(row("Pi").textContent).toContain("gemini: 4 runs");
    expect(row("Pi").textContent).toContain("pi: not imported yet");
    expect(row("Pi").textContent).toContain("agentrun-serve import");
  });

  it("keeps the totals, models, days and hours as plain numbers: no link to a filter that does not exist", async () => {
    await mount(async () => YEAR);
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.every((h) => h?.startsWith("#/runs?source="))).toBe(true);
    expect(document.querySelectorAll('[aria-label="Models"] a')).toHaveLength(0);
  });

  it("registers the nine cards in the prototype's order, each with the body fields it reads and what it waits on", () => {
    expect(WRAPPED_CARDS.map((c) => c.id)).toEqual(["cover", "split", "hours", "cache", "laptop", "leak", "type", "summary", "launch"]);
    const by = Object.fromEntries(WRAPPED_CARDS.map((c) => [c.id, c]));
    for (const c of WRAPPED_CARDS) expect(c.waits).toContain("race-card-renderer");
    for (const id of ["laptop", "type"]) expect(by[id]!.waits).toContain("derived");
    expect(WRAPPED_CARDS.filter((c) => c.waits.includes("derived")).map((c) => c.id)).toEqual(["laptop", "type"]);
    expect(by.leak!.waits).toEqual(expect.arrayContaining(["race-card-renderer", "scrubber-count-mode"]));
    expect(by.launch!.waits).toEqual(expect.arrayContaining(["race-card-renderer", "benchmark"]));
    expect(by.cover!.reads).toEqual(expect.arrayContaining(["tokens", "days"]));
    expect(by.hours!.reads).toEqual(expect.arrayContaining(["hours", "weekdays", "active_ms"]));
    const known = Object.keys(YEAR);
    for (const c of WRAPPED_CARDS) for (const f of c.reads) expect(known).toContain(f);
  });

  it("draws the cover, split, hours and summary cards as images by default, and none of the cards that wait on more", async () => {
    await mount(async () => YEAR, vi.fn(), 2025);
    const alts = [...document.querySelectorAll("[data-cards] img")].map((img) => img.getAttribute("alt") ?? "");
    expect(alts.map((alt) => alt.split(". ")[1])).toEqual(["Your 2025 in agents", "Where your tokens went", "When your agents work", "2025 in agents"]);
    for (const img of document.querySelectorAll("[data-cards] img")) expect(img.getAttribute("src")?.startsWith("data:image/svg+xml;")).toBe(true);
  });

  it("shows no cards section, and no empty box, when the renderer draws none or the year has no sessions", async () => {
    await mount(async () => YEAR, vi.fn(), 2025, noCards);
    expect(document.querySelector("[data-cards]")).toBeNull();
    expect(document.body.textContent).not.toContain("Cards");
    document.body.innerHTML = "";
    await mount(async () => ({ ...YEAR, sessions: 0 }), vi.fn(), 2025);
    expect(document.body.textContent).toContain("6.3M tokens");
    expect(document.querySelector("[data-cards]")).toBeNull();
  });

  it("calls an injected renderer for each of the nine cards, in order, with the body, and shows what it returns", async () => {
    const seen: string[] = [];
    const bodies: Wrapped[] = [];
    const cards: CardRenderer = (card, data) => { seen.push(card.id); bodies.push(data); return card.id === "cover" || card.id === "launch" ? createElement("p", { key: card.id, "data-fake": card.id }, `fake ${card.id}`) : null; };
    await mount(async () => YEAR, vi.fn(), 2025, cards);
    expect(seen).toEqual(["cover", "split", "hours", "cache", "laptop", "leak", "type", "summary", "launch"]);
    expect(bodies.every((b) => b.year === 2025 && b.requests === 300)).toBe(true);
    expect([...document.querySelectorAll("[data-cards] [data-fake]")].map((e) => e.textContent)).toEqual(["fake cover", "fake launch"]);
  });

  it("says a year with no sessions in a sentence", async () => {
    await mount(async () => ({ ...YEAR, requests: 0 }), vi.fn(), 2024);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("No coding agent sessions under this machine's home in 2024.");
  });

  it("shows a refusal with the server's own reasons as the why, and a next step that fits Wrapped", async () => {
    let calls = 0;
    const said = "wrapped reads this machine's own session files, so only one owner's server on their own machine, reached by a loopback name, answers it. This one takes more than one API token.";
    await mount(async () => { calls += 1; throw new ClientError(403, "forbidden", said); });
    const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("Your year could not be read");
    expect(alert).toContain("This one takes more than one API token.");
    expect(alert).not.toContain("Sign in as the server's owner");
    expect(calls).toBe(1);
  });

  it("keeps reading through a 503 (a long home): the skeleton stays and it asks again after the server's wait, then shows the year", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const busy = () => Object.assign(new ClientError(503, "unavailable", "still being read", true), { retryAfterMs: 5_000 });
      await mount(async () => { calls += 1; if (calls < 3) throw busy(); return YEAR; }, vi.fn(), 2025);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.body.textContent).toContain("Reading your year");
      await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
      expect(calls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(calls).toBe(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(calls).toBe(3);
      expect(document.body.textContent).toContain("6.3M tokens");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking again once the page is gone", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      await mount(async () => { calls += 1; throw Object.assign(new ClientError(503, "unavailable", "still being read", true), { retryAfterMs: 5_000 }); }, vi.fn(), 2025);
      act(() => root?.unmount());
      root = undefined;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
