import { describe, expect, it } from "vitest";
import { cost, markdown } from "./format";
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
