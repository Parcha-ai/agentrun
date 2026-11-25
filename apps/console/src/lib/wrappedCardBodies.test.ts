import { describe, expect, it } from "vitest";
import { cardCapacity, chartCapacity, renderCard, type CardBody } from "./cardImage";
import { CARD_BODIES, drawnBody, SATISFIED_WAITS, toBody } from "./wrappedCardBodies";
import { type CardWait, WRAPPED_CARDS } from "./wrappedCards";
import type { Wrapped } from "./v2";

// Each Wrapped card as the words and bars it draws: a year in, the exact CardBody out. A card is drawn only when every
// wait it has is met and the year has sessions; no number on a card is one the year does not give.
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
const PRICED: Wrapped = { ...YEAR, unpriced_requests: 0, models: YEAR.models.map((m) => ({ ...m, unpriced_requests: 0 })) };
const UNPRICED: Wrapped = { ...YEAR, cost_usd: 0, unpriced_requests: 300 };
const EMPTY: Wrapped = { ...YEAR, sessions: 0, turns: 0, requests: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0, unpriced_requests: 0, days: [], hours: new Array(24).fill(0), weekdays: new Array(7).fill(0), active_ms: 0, harnesses: [], models: [] };

const card = (id: string) => WRAPPED_CARDS.find((c) => c.id === id)!;
const body = (id: string, data: Wrapped = YEAR) => toBody(card(id), data);
const EYEBROW = "Wrapped 2025";
const HOURS = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, value: h === 14 ? 120 : h === 9 ? 80 : 4 }));
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, i) => ({ label, value: [0, 200, 100, 0, 0, 0, 0][i]! }));

/** `n` harnesses (or models) whose tokens fall by one share each, the first the most. */
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `h${i + 1}`, tokens: (n - i) * 1_000 }));

describe("the cards drawn now", () => {
  it("draws cover, split, hours and summary, and keeps every card with a wait not met hidden", () => {
    expect([...SATISFIED_WAITS]).toEqual(["race-card-renderer"]);
    expect(WRAPPED_CARDS.filter((c) => drawnBody(c, YEAR) !== null).map((c) => c.id)).toEqual(["cover", "split", "hours", "summary"]);
  });

  it("gates by the waits met, not by id: a card draws once every wait of its is met, and none draws with the renderer's unmet", () => {
    const bodies = Object.fromEntries(WRAPPED_CARDS.map((c) => [c.id, (): CardBody => ({ title: c.id })]));
    const drawn = (satisfied: ReadonlySet<CardWait>) => WRAPPED_CARDS.filter((c) => drawnBody(c, YEAR, satisfied, bodies) !== null).map((c) => c.id);
    expect(drawn(SATISFIED_WAITS)).toEqual(["cover", "split", "hours", "summary"]);
    expect(drawn(new Set<CardWait>(["race-card-renderer", "derived"]))).toEqual(["cover", "split", "hours", "laptop", "type", "summary"]);
    expect(drawn(new Set<CardWait>(["race-card-renderer", "cache-analyzer", "scrubber-count-mode", "benchmark", "derived"]))).toEqual(WRAPPED_CARDS.map((c) => c.id));
    expect(drawn(new Set<CardWait>(["cache-analyzer", "scrubber-count-mode", "benchmark", "derived"]))).toEqual([]);
  });

  it("has no body for a card whose rules the year cannot give (cache, laptop, leak, type, launch)", () => {
    expect(Object.keys(CARD_BODIES).sort()).toEqual(["cover", "hours", "split", "summary"]);
    for (const id of ["cache", "laptop", "leak", "type", "launch"]) expect(drawnBody(card(id), YEAR, new Set<CardWait>(["race-card-renderer", "cache-analyzer", "scrubber-count-mode", "benchmark", "derived"]))).toBeNull();
  });

  it("draws no card for an empty year: no sessions, or no requests", () => {
    for (const c of WRAPPED_CARDS) {
      expect(toBody(c, EMPTY), c.id).toBeNull();
      expect(toBody(c, { ...YEAR, sessions: 0 }), c.id).toBeNull();
      expect(toBody(c, { ...YEAR, requests: 0 }), c.id).toBeNull();
    }
  });

  it("reads only the fields each card says it reads", () => {
    for (const [id, map] of Object.entries(CARD_BODIES)) {
      const read = new Set<string>();
      const data = new Proxy(YEAR, { get: (target, key) => { if (typeof key === "string") read.add(key); return Reflect.get(target, key); } });
      expect(map(data), id).not.toBeNull();
      for (const key of read) expect(card(id).reads, `${id} reads ${key}`).toContain(key);
    }
  });

  it("draws every word and bar of each body: no row, bar or value is cut or left out", () => {
    const big: Wrapped = { ...YEAR, sessions: 123_456, turns: 9_876_543, requests: 12_345_678, cost_usd: 1_234_567.89, unpriced_requests: 1_234_567, unread_files: 12_345, days: Array.from({ length: 366 }, (_, i) => ({ day: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`, requests: 1, tokens: 1 })), active_ms: 9_876_543_210 };
    for (const data of [YEAR, PRICED, UNPRICED, big]) {
      for (const id of Object.keys(CARD_BODIES)) {
        const b = body(id, data)!;
        const capacity = cardCapacity(b);
        expect(capacity.rows, id).toBe(b.rows?.length ?? 0);
        expect(capacity.charts, id).toEqual((b.charts ?? []).map((c) => c.bars.length));
        const texts = [...new DOMParser().parseFromString(renderCard(b).svg, "image/svg+xml").querySelectorAll("text")].map((t) => t.textContent);
        for (const row of b.rows ?? []) expect(texts, `${id}: ${row.value}`).toContain(row.value);
        if (b.figure) expect(texts, id).toContain(b.figure.value);
        if (b.footnote) expect(texts, id).toContain(b.footnote);
      }
    }
  });
});

describe("cover", () => {
  it("says the year's tokens, sessions, prompts, requests, days and list price, and the requests with no known price", () => {
    expect(body("cover")).toEqual({
      eyebrow: EYEBROW,
      title: "Your 2025 in agents",
      figure: { value: "6.3M", unit: "tokens" },
      rows: [
        { label: "Sessions", value: "12" },
        { label: "Prompts", value: "40" },
        { label: "Model requests", value: "300" },
        { label: "Days at work", value: "2" },
        { label: "At list price", value: "$42.50" },
        { label: "No known price", value: "3 requests" },
      ],
    });
  });

  it("leaves out the unpriced row when every request was priced, and says one request in the singular", () => {
    expect(body("cover", PRICED)!.rows!.map((r) => r.label)).toEqual(["Sessions", "Prompts", "Model requests", "Days at work", "At list price"]);
    expect(body("cover", { ...YEAR, unpriced_requests: 1 })!.rows!.at(-1)).toEqual({ label: "No known price", value: "1 request" });
  });

  it("says an unknown price when no request was priced, never $0", () => {
    const rows = body("cover", UNPRICED)!.rows!;
    expect(rows.slice(-2)).toEqual([{ label: "At list price", value: "Unknown" }, { label: "No known price", value: "300 requests" }]);
    expect(rows.map((r) => r.value)).not.toContain("$0.00");
  });

  it("says a free year as $0.00 when every request was priced at nothing", () => {
    expect(body("cover", { ...PRICED, cost_usd: 0 })!.rows!.at(-1)).toEqual({ label: "At list price", value: "$0.00" });
  });

  it("groups thousands in a large year's counts and dollars", () => {
    const rows = body("cover", { ...PRICED, sessions: 3_412, turns: 40_100, requests: 1_234_567, cost_usd: 41_870 })!.rows!;
    expect(rows.map((r) => r.value)).toEqual(["3,412", "40,100", "1,234,567", "2", "$41,870.00"]);
  });

  it("says the numbers may be incomplete when session files could not be read", () => {
    expect(body("cover", { ...YEAR, unread_files: 2 })!.footnote).toBe("2 session files could not be read, so these numbers may be incomplete.");
    expect(body("cover", { ...YEAR, unread_files: 1 })!.footnote).toBe("1 session file could not be read, so these numbers may be incomplete.");
    expect(body("cover")!.footnote).toBeUndefined();
  });
});

describe("split", () => {
  it("says the top harness's share, and each harness's and model's share of their tokens as rows", () => {
    expect(body("split")).toEqual({
      eyebrow: EYEBROW,
      title: "Where your tokens went",
      figure: { value: "95%", unit: "claude-agent" },
      charts: [
        { label: "Harnesses", kind: "rows", bars: [{ label: "claude-agent", value: 6_000_000, text: "95%" }, { label: "pi", value: 300_000, text: "5%" }] },
        { label: "Models", kind: "rows", bars: [{ label: "claude-sonnet", value: 6_000_000, text: "95%" }, { label: "gpt", value: 300_000, text: "5%" }] },
      ],
    });
  });

  it("folds the harnesses and models past what fits into one exact other bar", () => {
    const year: Wrapped = {
      ...YEAR,
      harnesses: many(8).map(({ name, tokens }) => ({ harness: name, sessions: 1, requests: 1, tokens, sources: [] })),
      models: many(7).map(({ name, tokens }) => ({ model: `p/${name}`, requests: 1, tokens, cost_usd: 0, unpriced_requests: 0 })),
    };
    const b = body("split", year)!;
    expect(chartCapacity(b)).toEqual([6, 6]);
    // 8 harnesses, 36K tokens: the first five and the last three as other (3K + 2K + 1K).
    expect(b.charts![0]!.bars).toEqual([
      { label: "h1", value: 8_000, text: "22%" },
      { label: "h2", value: 7_000, text: "19%" },
      { label: "h3", value: 6_000, text: "17%" },
      { label: "h4", value: 5_000, text: "14%" },
      { label: "h5", value: 4_000, text: "11%" },
      { label: "other", value: 6_000, text: "17%" },
    ]);
    expect(b.charts![1]!.bars.map((bar) => [bar.label, bar.value])).toEqual([["h1", 7_000], ["h2", 6_000], ["h3", 5_000], ["h4", 4_000], ["h5", 3_000], ["other", 3_000]]);
    // Exactly as many as fit: no fold.
    const six = body("split", { ...year, harnesses: year.harnesses.slice(0, 6) })!;
    expect(six.charts![0]!.bars.map((bar) => bar.label)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    // A foot line takes a row's room: one fewer fits, and the fold follows.
    const short = body("split", { ...year, unread_files: 1 })!;
    expect(chartCapacity(short)).toEqual([5, 5]);
    expect(short.charts![0]!.bars.map((bar) => [bar.label, bar.value])).toEqual([["h1", 8_000], ["h2", 7_000], ["h3", 6_000], ["h4", 5_000], ["other", 10_000]]);
  });

  it("orders by tokens whatever order the year lists them in", () => {
    const b = body("split", { ...YEAR, harnesses: [...YEAR.harnesses].reverse(), models: [...YEAR.models].reverse() })!;
    expect(b.charts!.map((c) => c.bars.map((bar) => bar.label))).toEqual([["claude-agent", "pi"], ["claude-sonnet", "gpt"]]);
  });

  it("says a share under one percent as <1% and one just short of all as >99%, never 0% or 100%", () => {
    const year: Wrapped = { ...YEAR, harnesses: [{ ...YEAR.harnesses[0]!, tokens: 999_000 }, { ...YEAR.harnesses[1]!, tokens: 1_000 }] };
    expect(body("split", year)!.charts![0]!.bars.map((bar) => bar.text)).toEqual([">99%", "<1%"]);
    expect(body("split", year)!.figure).toEqual({ value: ">99%", unit: "claude-agent" });
  });

  it("keeps a model's provider in its name when another provider's model has the same name", () => {
    const year: Wrapped = { ...YEAR, models: [{ ...YEAR.models[0]! }, { ...YEAR.models[1]!, model: "openrouter/claude-sonnet" }, { ...YEAR.models[1]!, model: "unknown", tokens: 100 }] };
    expect(body("split", year)!.charts![1]!.bars.map((bar) => bar.label)).toEqual(["anthropic/claude-sonnet", "openrouter/claude-sonnet", "unknown"]);
  });

  it("draws nothing when the year's harnesses have no tokens, and no models chart when its models have none", () => {
    expect(body("split", { ...YEAR, harnesses: YEAR.harnesses.map((h) => ({ ...h, tokens: 0 })) })).toBeNull();
    expect(body("split", { ...YEAR, models: [] })!.charts!.map((c) => c.label)).toEqual(["Harnesses"]);
  });
});

describe("hours", () => {
  it("says the busiest hour and weekday, time and days at work, and requests by hour and by weekday as columns", () => {
    expect(body("hours")).toEqual({
      eyebrow: EYEBROW,
      title: "When your agents work",
      figure: { value: "2 pm", unit: "busiest hour" },
      rows: [{ label: "Busiest day", value: "Monday" }, { label: "Time at work", value: "2.0 h" }, { label: "Days at work", value: "2" }],
      charts: [{ label: "Requests by hour", kind: "columns", bars: HOURS }, { label: "Requests by weekday", kind: "columns", bars: WEEKDAYS }],
    });
  });

  it("names midnight and noon, and the first of hours tied for busiest", () => {
    const at = (h: number) => body("hours", { ...YEAR, hours: Array.from({ length: 24 }, (_, i) => (i === h ? 9 : 1)) })!.figure!.value;
    expect([at(0), at(11), at(12), at(23)]).toEqual(["12 am", "11 am", "12 pm", "11 pm"]);
    expect(body("hours", { ...YEAR, hours: Array.from({ length: 24 }, (_, i) => (i === 3 || i === 20 ? 9 : 1)) })!.figure!.value).toBe("3 am");
  });

  it("groups a long year's hours at work", () => {
    expect(body("hours", { ...YEAR, active_ms: 7_849_440_000 })!.rows![1]).toEqual({ label: "Time at work", value: "2,180.4 h" });
  });
});

describe("summary", () => {
  it("puts the year on one card: tokens, list price, days, top harness, top model and busiest hour", () => {
    expect(body("summary")).toEqual({
      eyebrow: EYEBROW,
      title: "2025 in agents",
      figure: { value: "6.3M", unit: "tokens" },
      rows: [
        { label: "At list price", value: "$42.50" },
        { label: "No known price", value: "3 requests" },
        { label: "Days at work", value: "2" },
        { label: "Top harness", value: "95% claude-agent" },
        { label: "Top model", value: "95% claude-sonnet" },
        { label: "Busiest hour", value: "2 pm" },
      ],
    });
  });

  it("says an unknown price when no request was priced, and leaves the unpriced row out when all were", () => {
    expect(body("summary", UNPRICED)!.rows!.slice(0, 2)).toEqual([{ label: "At list price", value: "Unknown" }, { label: "No known price", value: "300 requests" }]);
    expect(body("summary", PRICED)!.rows!.map((r) => r.label)).toEqual(["At list price", "Days at work", "Top harness", "Top model", "Busiest hour"]);
  });

  it("leaves out a top harness or model the year has none of", () => {
    expect(body("summary", { ...PRICED, models: [] })!.rows!.map((r) => r.label)).toEqual(["At list price", "Days at work", "Top harness", "Busiest hour"]);
  });
});
