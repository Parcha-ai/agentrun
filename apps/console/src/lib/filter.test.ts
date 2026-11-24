import { describe, expect, it } from "vitest";
import { matchesFilter } from "./filter";

describe("matchesFilter", () => {
  it("keeps a row when each word of the query, case aside, is in one of its texts", () => {
    expect(matchesFilter("issue comment", "GITHUB_CREATE_AN_ISSUE_COMMENT")).toBe(true);
    expect(matchesFilter("Comment  ISSUE", "Create an issue comment")).toBe(true);
    expect(matchesFilter("octo comment", "octo", "GITHUB_CREATE_AN_ISSUE_COMMENT"), "words across texts").toBe(true);
    expect(matchesFilter("issue star", "GITHUB_LIST_ISSUES", "List issues")).toBe(false);
    expect(matchesFilter("x", undefined, "")).toBe(false);
  });
  it("an empty or blank query keeps every row", () => {
    expect(matchesFilter("", "anything")).toBe(true);
    expect(matchesFilter("   ", undefined)).toBe(true);
  });
});
