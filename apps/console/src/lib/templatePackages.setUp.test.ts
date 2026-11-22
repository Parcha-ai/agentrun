import { describe, expect, it } from "vitest";
import { setUpHref } from "./templatePackages";

type Need = Parameters<typeof setUpHref>[0];
const need = (source: Need["source"], toolkit: string): Need => ({ source, toolkit, tools: [], required: true, allow: [], pin: {} }) as unknown as Need;

describe("setUpHref", () => {
  it("links a url need to the first preset of its toolkit: fal opens the key preset, not the sign-in one", () => {
    expect(setUpHref(need("url", "fal"))).toBe("#/settings/mcp?add=fal&preset=fal");
  });
  it("links a url need with no preset to the plain form under the toolkit's name", () => {
    expect(setUpHref(need("url", "acme-docs"))).toBe("#/settings/mcp?add=acme-docs");
  });
});
