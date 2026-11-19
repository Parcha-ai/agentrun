import { describe, expect, it } from "vitest";
import type { SaveWarning } from "./agentForm";
import { monidGrantOf, monidGrantText, monidNameProblem, splitMonidWarnings } from "./monid";

describe("monid grant names", () => {
  it("read a named endpoint, a provider's wildcard, and refuse what is neither", () => {
    expect(monidGrantOf("monid:keenable/v1/search")).toEqual({ provider: "keenable", endpoint: "v1/search" });
    expect(monidGrantOf("monid:api.strale.io/people/{id}")).toEqual({ provider: "api.strale.io", endpoint: "people/{id}" });
    expect(monidGrantOf("monid:exa/*")).toEqual({ provider: "exa", endpoint: null });
    for (const bad of ["monid:Exa/*", "monid:exa", "monid:exa/", "monid:exa//x", "monid:/search", "monid.run", "mcp:fake/add"]) expect(monidGrantOf(bad), bad).toBeUndefined();
    expect(monidNameProblem("monid:exa/*")).toBeUndefined();
  });

  it("take a typed name with or without its monid: prefix", () => {
    expect(monidGrantText("  keenable/v1/search ")).toBe("monid:keenable/v1/search");
    expect(monidGrantText("monid:exa/*")).toBe("monid:exa/*");
    expect(monidGrantText("   ")).toBe("");
  });

  it("split a save's warnings: those at a monid grant, and the rest", () => {
    const left: SaveWarning = { field: "definition.tools[1]", reason: "priced_by_usage", message: "monid:exa/search is priced by usage: ..." };
    const model: SaveWarning = { field: "definition.model", reason: "not_set_up_here", message: "No key for openai." };
    const read: SaveWarning = { field: "definition.tools[0]", reason: "not_set_up_here", message: "read needs a box." };
    expect(splitMonidWarnings([left, model, read], ["read", "monid:exa/*"])).toEqual({ monid: [{ grant: "monid:exa/*", warning: left }], rest: [model, read] });
  });
});
