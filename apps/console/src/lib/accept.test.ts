import { describe, expect, it } from "vitest";
import { acceptOf, conditionDraftOf, lineOfValue, valueOfLine, whereWords } from "./accept";

// An `in` list is typed a value a line, and read back (an edited rule, the trigger's summary) a line a value: each value
// must come back as itself.
describe("a filter's is-one-of values", () => {
  const values: unknown[] = ["bug", "needs triage", "[agent]", "42", "true", "null", " padded ", "", "a, b", "two\nlines", "\"quoted\"", 42, -1.5, true, false, null, { a: 1 }, [1, "x"]];

  it("each value's line reads back as the value", () => {
    for (const value of values) expect(valueOfLine(lineOfValue(value)), lineOfValue(value)).toEqual(value);
  });

  it("text stays as typed unless it would read as something else", () => {
    expect(values.map(lineOfValue)).toEqual(["bug", "needs triage", "[agent]", "\"42\"", "\"true\"", "\"null\"", "\" padded \"", "\"\"", "\"a, b\"", "\"two\\nlines\"", "\"\\\"quoted\\\"\"", "42", "-1.5", "true", "false", "null", "{\"a\":1}", "[1,\"x\"]"]);
  });

  it("an edited rule's list, sent again unchanged, is the list it was", () => {
    const where = { pointer: "/label", in: values };
    const draft = conditionDraftOf(where);
    expect(acceptOf([{ event: "issue", actions: "", where: [draft] }]).accept).toEqual([{ event: "issue", where: [where] }]);
  });

  it("the summary says each test in the editor's words", () => {
    expect(whereWords({ pointer: "/label", in: ["bug", 42, "42"] })).toBe('/label is one of bug, 42, "42"');
    expect(whereWords({ pointer: "/draft", exists: false })).toBe("/draft is missing");
    expect(whereWords({ pointer: "/assignee", exists: true })).toBe("/assignee exists");
    expect(whereWords({ pointer: "/title", prefix: "[agent]" })).toBe('/title starts with "[agent]"');
  });
});
