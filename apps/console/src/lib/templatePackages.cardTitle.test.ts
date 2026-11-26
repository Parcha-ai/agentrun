import { describe, expect, it } from "vitest";
import { cardTitleOf, inCatalog } from "./templatePackages";
import type { TemplateView } from "./v2";

const named = (display_name: string | null, name = "t") => ({ name, display_name } as TemplateView);

describe("a catalog card's title, as the marketplace's card reads it", () => {
  it("is the display name up to its first parameter, cut at the : or ( before it", () => {
    expect(cardTitleOf(named("Code review: ${parameters.owner}/${parameters.repo}"))).toBe("Code review");
    expect(cardTitleOf(named("KYB due diligence (${parameters.risk_appetite} risk appetite)"))).toBe("KYB due diligence");
    expect(cardTitleOf(named("  Inbound lead researcher "))).toBe("Inbound lead researcher");
    expect(cardTitleOf(named(null, "meeting-notes"))).toBe("meeting-notes");
  });
  it("reads a name that starts with a parameter, or has no : or ( before one, with … in its place", () => {
    expect(cardTitleOf(named("${parameters.topic} digest"))).toBe("… digest");
    expect(cardTitleOf(named("Watch ${parameters.topic}"))).toBe("Watch …");
  });
});

describe("the catalog", () => {
  it("leaves out the bundled scanner the Suggested page runs, and keeps an imported package of that name", () => {
    expect(inCatalog({ bundled: true, name: "agent-scout" })).toBe(false);
    expect(inCatalog({ bundled: false, name: "agent-scout" })).toBe(true);
    expect(inCatalog({ bundled: true, name: "kyb" })).toBe(true);
  });
});
