import { describe, expect, it } from "vitest";
import { needsOf } from "./templatePackages";

type View = Parameters<typeof needsOf>[0];
const view = (budget: View["budget"]): View => ({ secrets: [], mcp: [], triggers: [], budget, harness: null, model: null }) as unknown as View;

describe("needsOf: a template's budget", () => {
  it("says its limit on free-model requests beside its dollar cap", () => {
    expect(needsOf(view({ per_run_usd: 0.5, max_requests: 20 }))).toEqual([["Budget", "$0.50 a run"], ["Free-model requests", "at most 20 a run"]]);
  });
  it("says no request limit when the package sets none", () => {
    expect(needsOf(view({ per_run_usd: 0.5 }))).toEqual([["Budget", "$0.50 a run"]]);
  });
});
