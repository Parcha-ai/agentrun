import { describe, expect, it } from "vitest";
import { cost } from "./format";
import unpriced from "../fixtures/run.working.working.1.json";

// An unknown cost is never $0: the server sends usd null for a run it has not priced, and the console says so.
describe("cost", () => {
  it("reads a missing cost or a null usd as Unpriced, never a zero", () => {
    expect(cost(null)).toBe("Unpriced");
    expect(cost(undefined)).toBe("Unpriced");
    expect(cost({ usd: null, basis: "estimate", charge_state: null, cap_usd: null })).toBe("Unpriced");
    expect(cost({ usd: null, basis: "estimate", charge_state: null, cap_usd: null })).not.toMatch(/\$0/);
  });

  it("reads the recorded unpriced run as Unpriced", () => {
    const c = (unpriced as { body: { cost: { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null } } }).body.cost;
    expect(c.usd).toBeNull();
    expect(cost(c)).toBe("Unpriced");
  });

  it("marks a local estimate as one, and shows a real zero only when the server priced it zero", () => {
    expect(cost({ usd: 0.004043, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$0.0040 est.");
    expect(cost({ usd: 1.5, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$1.50 est.");
    expect(cost({ usd: 0, basis: "billed", charge_state: null, cap_usd: null })).toBe("$0.0000");
  });
});
