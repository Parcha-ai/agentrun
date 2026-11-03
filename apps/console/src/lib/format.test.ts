import { describe, expect, it } from "vitest";
import { bounded, cost, CUT_NOTE, markdown, upTo } from "./format";
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

// The run's cost bound, when the server knows one (requests cut or stopped), reads as the bound: "≤ $x", never a bare "$x".
describe("a cost bounded by cut requests (at_most_usd)", () => {
  const base = (unpriced as { body: { cost: { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null } } }).body.cost;
  it("reads ≤ the bound, rounded up so it never reads below it, never a bare $x and never Unknown", () => {
    expect(base.usd).toBeNull();
    // Under a cent, in $0.0001 steps; from a cent up, in cents, as a known cost is said: each rounded up.
    expect(cost({ ...base, at_most_usd: 0.00123 })).toBe("≤ $0.0013");
    expect(cost({ ...base, at_most_usd: 0.0049 })).toBe("≤ $0.0049");
    expect(cost({ ...base, at_most_usd: 0.01234 })).toBe("≤ $0.02");
    expect(cost({ ...base, at_most_usd: 1.231 })).toBe("≤ $1.24");
    expect(cost({ ...base, at_most_usd: 2 })).toBe("≤ $2.00");
    expect(bounded({ ...base, at_most_usd: 0.5 })).toBe(true);
    expect(upTo(0.00001)).toBe("$0.0001");
    expect(CUT_NOTE).toBe("some requests were cut");
  });
  it("without the field, or with it null, reads as it always did: Unknown", () => {
    expect(cost(base)).toBe("Unknown");
    expect(cost({ ...base, at_most_usd: null })).toBe("Unknown");
    expect(bounded(base)).toBe(false);
  });
  it("a known cost is its figure, whatever a bound beside it says", () => {
    expect(cost({ ...base, usd: 0.5, at_most_usd: 0.9 })).toBe("$0.50 est.");
    expect(bounded({ ...base, usd: 0.5, at_most_usd: 0.9 })).toBe(false);
  });
  it("the runs list says the bound and why, under it", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RunsList } = await import("../components/RunsList");
    const run = (unpriced as unknown as { body: Parameters<typeof RunsList>[0]["runs"] extends (infer R)[] | null ? R : never }).body;
    const html = renderToStaticMarkup(createElement(RunsList, { runs: [{ ...run, cost: { ...run.cost!, at_most_usd: 0.03 } }], agentName: () => "Meeting notes", onOpen: () => {} }));
    expect(html).toContain("≤ $0.03");
    expect(html).toContain(CUT_NOTE);
    expect(html).not.toContain("Unknown");
  });
});
