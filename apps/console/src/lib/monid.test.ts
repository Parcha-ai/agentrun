import { describe, expect, it } from "vitest";
import { MONID_GRAMMAR, monidGrantOf, monidGrantText, monidNameProblem, splitMonidWarnings } from "./monid";

// The server's grammar, read from its source: the console's copy of a monid grant's shape must be the same.
const SERVER = Object.values(import.meta.glob("../../../../packages/serve/src/tool-names.ts", { query: "?raw", import: "default", eager: true }))[0] as string;
const constant = (name: string) => new RegExp(`const ${name} = "([^"]+)";`).exec(SERVER)?.[1];

describe("monid grant names", () => {
  it("are the server's grammar (packages/serve/src/tool-names.ts)", () => {
    expect(SERVER).toContain("MONID_NAME = new RegExp(`^monid:(${PROVIDER})/(\\\\*|${ENDPOINT})$`)");
    expect(constant("PROVIDER")).toBe(MONID_GRAMMAR.PROVIDER);
    expect(constant("ENDPOINT")).toBe(MONID_GRAMMAR.ENDPOINT);
    // The refusal is in the server's words (MONID_NAME_WORDS).
    const words = /MONID_NAME_WORDS = \(name: string\): string => `\$\{name\}([^`]+)`/.exec(SERVER)?.[1];
    expect(monidNameProblem("monid:x")).toBe(`monid:x${words}`);
  });

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
    const left = { field: "definition.tools[1]", reason: "not_an_option", message: "monid:exa/search is left out of monid:exa/*: ..." };
    const model = { field: "definition.model", reason: "not_set_up_here", message: "No key for openai." };
    const read = { field: "definition.tools[0]", reason: "not_set_up_here", message: "read needs a box." };
    expect(splitMonidWarnings([left, model, read], ["read", "monid:exa/*"])).toEqual({ monid: [{ grant: "monid:exa/*", warning: left }], rest: [model, read] });
  });
});
