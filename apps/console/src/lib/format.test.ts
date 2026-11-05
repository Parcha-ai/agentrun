import { afterEach, describe, expect, it, vi } from "vitest";
import { clock, cost, markdown, runLabel, when } from "./format";
import type { Cost } from "./v2";
import unpriced from "../fixtures/run.working.working.1.json";

// An unknown cost is never $0: the contract says "Null while unknown. A client shows null as unknown, never as $0."
describe("cost", () => {
  it("reads a missing cost or a null usd as Unknown, never a zero", () => {
    expect(cost(null)).toBe("Unknown");
    expect(cost(undefined)).toBe("Unknown");
    expect(cost({ usd: null, basis: "estimate", charge_state: null, cap_usd: null })).toBe("Unknown");
    expect(cost({ usd: null, basis: "estimate", charge_state: null, cap_usd: null })).not.toMatch(/\$0/);
  });

  it("reads the recorded run whose cost is not known as Unknown", () => {
    const c = (unpriced as { body: { cost: { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null } } }).body.cost;
    expect(c.usd).toBeNull();
    expect(cost(c)).toBe("Unknown");
  });

  it("marks a local estimate as one, and shows a real zero only when the server priced it zero", () => {
    expect(cost({ usd: 0.004043, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$0.0040 est.");
    expect(cost({ usd: 1.5, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$1.50 est.");
    expect(cost({ usd: 0, basis: "billed", charge_state: null, cap_usd: null })).toBe("$0.0000");
  });

  it("never rounds a cost the server priced above zero down to $0", () => {
    // A short run on a cheap model: $0.000043 is not $0.0000.
    expect(cost({ usd: 0.000043, basis: "estimate", charge_state: null, cap_usd: null })).toBe("<$0.0001 est.");
    expect(cost({ usd: 0.00004999, basis: "billed", charge_state: null, cap_usd: null })).toBe("<$0.0001");
    expect(cost({ usd: 0.0001, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$0.0001 est.");
  });

  it("says est. for a local estimate and not for a cost the server reports otherwise", () => {
    expect(cost({ usd: 0.25, basis: "estimate", charge_state: null, cap_usd: null })).toContain("est.");
    expect(cost({ usd: 0.25, basis: "billed", charge_state: null, cap_usd: null })).not.toContain("est.");
  });
});

describe("cost where a run is shown", () => {
  it("the run header shows a null cost as Unknown, never $0", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunHeader } = await import("../components/RunHeader");
    const run = (unpriced as unknown as { body: Parameters<typeof RunHeader>[0]["run"] }).body;
    const html = renderToStaticMarkup(createElement(RunHeader, { run, agentName: "Meeting notes" }));
    expect(html).toContain("Unknown");
    expect(html).not.toMatch(/\$0(\.0+)?(?!\.\d*[1-9])/);
  });
  it("the run header shows a workflow run's graph cost when it is given, not the run record's", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunHeader } = await import("../components/RunHeader");
    const run = { ...(unpriced as unknown as { body: Parameters<typeof RunHeader>[0]["run"] }).body, kind: "workflow" as const, cost: { usd: 0, basis: "estimate" } };
    const html = renderToStaticMarkup(createElement(RunHeader, { run: run as never, agentName: "Batch", costText: "$0.0188" }));
    expect(html).toContain("$0.0188");
    expect(html).not.toContain("est.");
  });
});

describe("markdown", () => {
  it("renders a run's Markdown with no script, no event handler and no javascript: link (it is shown as HTML)", () => {
    const html = markdown('<img src=x onerror=alert(1)><script>x</script>[a](javascript:alert(1)) **bold**');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("cost in the runs list", () => {
  it("the runs list shows a null cost as Unknown, never $0", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunsList } = await import("../components/RunsList");
    const run = (unpriced as unknown as { body: Parameters<typeof RunsList>[0]["runs"] extends (infer R)[] | null ? R : never }).body;
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [run], agentName: () => "Meeting notes", onOpen: () => {} }));
    expect(html).toContain("Unknown");
    expect(html).not.toMatch(/\$0(\.0+)?(?!\.\d*[1-9])/);
  });
  it("the run header shows a workflow run's graph cost when it is given, not the run record's", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunHeader } = await import("../components/RunHeader");
    const run = { ...(unpriced as unknown as { body: Parameters<typeof RunHeader>[0]["run"] }).body, kind: "workflow" as const, cost: { usd: 0, basis: "estimate" } };
    const html = renderToStaticMarkup(createElement(RunHeader, { run: run as never, agentName: "Batch", costText: "$0.0188" }));
    expect(html).toContain("$0.0188");
    expect(html).not.toContain("est.");
  });
});

describe("cost, by its basis", () => {
  it("an estimate reads est., a charge reads plainly", () => {
    expect(cost({ usd: 1.5, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$1.50 est.");
    expect(cost({ usd: 1.5, basis: "charge", charge_state: null, cap_usd: null })).toBe("$1.50");
  });
});

// A cost the server can't give whole says what it knows (costsofar/1): the charges priced so far, and how many have no
// price. "Unknown" stays only when the server says neither.
describe("a cost known so far (so_far_usd, unpriced)", () => {
  const unknown = { usd: null, basis: null, charge_state: null, cap_usd: null } as unknown as Cost;
  it("says so far, and how many charges have no price, in place of Unknown", () => {
    expect(cost({ ...unknown, so_far_usd: 0.0123, unpriced: 1 })).toBe("so far $0.0123 · 1 not priced");
    expect(cost({ ...unknown, so_far_usd: 0.0123, unpriced: 3 })).toBe("so far $0.0123 · 3 not priced");
    expect(cost({ ...unknown, so_far_usd: 1.5, unpriced: 2 })).toBe("so far $1.50 · 2 not priced");
    // Up to four places under a dollar, as the usage row says it, with no zeros past the cents.
    expect([0.07, 0.012, 0.5, 0.00004, 0].map((usd) => cost({ ...unknown, so_far_usd: usd, unpriced: 1 }))).toEqual(
      ["so far $0.07 · 1 not priced", "so far $0.012 · 1 not priced", "so far $0.50 · 1 not priced", "so far <$0.0001 · 1 not priced", "so far $0.00 · 1 not priced"]);
  });
  it("says est. when the charges priced so far are a local estimate, as a priced run does", () => {
    expect(cost({ ...unknown, basis: "estimate", so_far_usd: 0.0123, unpriced: 1 })).toBe("so far $0.0123 est. · 1 not priced");
  });
  it("a priced run shows its figure as before, and a null usd with neither field reads Unknown", () => {
    expect(cost({ ...unknown, usd: 0.5, basis: "estimate" })).toBe("$0.50 est.");
    expect(cost(unknown)).toBe("Unknown");
    expect(cost({ ...unknown, so_far_usd: 0.0123 } as Cost)).toBe("Unknown");
    expect(cost({ ...unknown, unpriced: 1 } as Cost)).toBe("Unknown");
  });
  it("the runs list says it too, not Unknown", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunsList } = await import("../components/RunsList");
    const run = (unpriced as unknown as { body: Parameters<typeof RunsList>[0]["runs"] extends (infer R)[] | null ? R : never }).body;
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [{ ...run, cost: { ...run.cost!, usd: null, so_far_usd: 0.0123, unpriced: 1 } }], agentName: () => "Meeting notes", onOpen: () => {} }));
    expect(html).toContain("so far $0.0123");
    expect(html).toContain("1 not priced");
    expect(html).not.toContain("Unknown");
  });
});

// Times read in the viewer's own zone: the browser's, never UTC. A run that started at 20:50:47Z reads 4:50 PM in
// Puerto Rico (UTC-4) and 5:50 AM the next day in Tokyo (UTC+9).
describe("when and clock, in the viewer's zone", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const AT = "2026-11-04T20:50:47Z";
  it("reads a time in Puerto Rico's zone there", () => {
    vi.stubEnv("TZ", "America/Puerto_Rico");
    expect(when(AT)).toBe("Nov 4, 4:50 PM");
    expect(clock(AT)).toBe("04:50 PM");
  });
  it("reads the same instant in Tokyo's zone there, on the next day", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(when(AT)).toBe("Nov 5, 5:50 AM");
    expect(clock(AT)).toBe("05:50 AM");
  });
});

// One short label for a run everywhere: the id's random tail, so runs started in the same second differ.
describe("runLabel", () => {
  it("is the last 8 characters of the id, different for two UUIDv7s of the same millisecond", () => {
    expect(runLabel("01a1a869-ce4e-7cf5-abf8-c5407893934a")).toBe("7893934a");
    expect(runLabel("01a1a869-ce4e-7d11-9a02-3f6b0e21d7c5")).toBe("0e21d7c5");
  });
});
