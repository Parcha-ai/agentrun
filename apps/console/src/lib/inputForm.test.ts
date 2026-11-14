import { describe, expect, it } from "vitest";
import { agentInputOf, fieldIssueWords, fieldLabel, fieldOfIssue, fieldValid, inputOf, placeholderOf, startText } from "./inputForm";

// An agentic agent's input_schema, as the run forms read it: one field for each top-level property other than
// `content` (the run's message), the message box required or not, and the typed input the form sends. A schema the
// fields can't show is typed as JSON instead, whole.
const RESEARCH = {
  type: "object",
  properties: {
    content: { type: "string" },
    company: { type: "string", title: "Company", description: "Who to look into", examples: ["Acme Corp"] },
    limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
    topics: { type: "array", items: { type: "string" }, description: "One topic a line" },
    deep: { type: "boolean" },
    region: { type: "string", enum: ["us", "eu"] },
  },
  required: ["company"],
};

describe("agentInputOf", () => {
  it("is the plain message with no schema, or one that names no field but content", () => {
    expect(agentInputOf(undefined)).toEqual({ kind: "message" });
    expect(agentInputOf({ type: "object", properties: { content: { type: "string" } } })).toEqual({ kind: "message" });
  });

  it("reads each property but content as a field, in the schema's order, and the message as optional when another field is required", () => {
    const read = agentInputOf(RESEARCH);
    expect(read.kind).toBe("fields");
    if (read.kind !== "fields") return;
    expect(read.form.contentRequired).toBe(false);
    expect(read.form.fields.map(([k]) => k)).toEqual(["company", "limit", "topics", "deep", "region"]);
    const fields = Object.fromEntries(read.form.fields);
    expect(fields.company).toMatchObject({ type: "string", required: true, title: "Company", examples: ["Acme Corp"] });
    expect(fields.limit).toMatchObject({ type: "integer", required: false, default: 10, minimum: 1, maximum: 50 });
    expect(fields.topics).toMatchObject({ type: "string", array: true, required: false });
  });

  it("requires the message when the schema lists it, or when it requires no other field", () => {
    const listed = agentInputOf({ ...RESEARCH, required: ["company", "content"] });
    expect(listed.kind === "fields" && listed.form.contentRequired).toBe(true);
    const none = agentInputOf({ ...RESEARCH, required: [] });
    expect(none.kind === "fields" && none.form.contentRequired).toBe(true);
  });

  it("types a schema it can't show as fields as JSON, whole, starting from its required fields' shape", () => {
    const nested = { type: "object", properties: { company: { type: "string" }, filters: { type: "object", properties: { since: { type: "string" } } } }, required: ["company"] };
    const read = agentInputOf(nested);
    expect(read.kind).toBe("json");
    if (read.kind !== "json") return;
    expect(JSON.parse(read.example.text)).toEqual({ company: "" });
    expect(agentInputOf({ type: "object", properties: { rows: { type: "array", items: { type: "object" } } } }).kind).toBe("json");
    expect(agentInputOf({ type: "object", properties: { either: { oneOf: [{ type: "string" }, { type: "number" }] } } }).kind).toBe("json");
  });
});

describe("inputOf", () => {
  const read = agentInputOf(RESEARCH);
  const form = read.kind === "fields" ? read.form : null!;
  it("types each field: numbers as numbers, a list a line at a time, a box as true or false; an empty optional field is not sent", () => {
    expect(inputOf(form, "Look into them.", { company: "Acme", limit: "5", topics: "pricing\n\n hiring \n", deep: "true", region: "" })).toEqual({
      content: "Look into them.", company: "Acme", limit: 5, topics: ["pricing", "hiring"], deep: true,
    });
  });
  it("sends no content for an empty message, and the rest as typed", () => {
    expect(inputOf(form, "  ", { company: "Acme" })).toEqual({ company: "Acme" });
  });
  it("sends text that is no number as typed, for the server to refuse in its own words", () => {
    expect(inputOf(form, "", { company: "Acme", limit: "lots" })).toEqual({ company: "Acme", limit: "lots" });
  });
});

describe("a field's start, label, hint and check", () => {
  const read = agentInputOf(RESEARCH);
  const f = read.kind === "fields" ? Object.fromEntries(read.form.fields) : {};
  it("starts a box at its default, and other fields empty", () => {
    const withDefault = agentInputOf({ type: "object", properties: { deep: { type: "boolean", default: true }, limit: { type: "integer", default: 3 } } });
    expect(withDefault.kind === "fields" && startText(Object.fromEntries(withDefault.form.fields))).toEqual({ deep: "true" });
  });
  it("labels a field by its title, else its key; its hint is its first example, else its default", () => {
    expect(fieldLabel("company", f.company)).toBe("Company");
    expect(fieldLabel("limit", f.limit)).toBe("limit");
    expect(placeholderOf(f.company)).toBe("Acme Corp");
    expect(placeholderOf(f.limit)).toBe("10");
    expect(placeholderOf(f.topics)).toBeUndefined();
  });
  it("checks a value as the server would: required, bounds, choices, and each line of a list", () => {
    expect(fieldValid(f.company, "")).toBe(false);
    expect(fieldValid(f.limit, "")).toBe(true);
    expect(fieldValid(f.limit, "0")).toBe(false);
    expect(fieldValid(f.limit, "51")).toBe(false);
    expect(fieldValid(f.limit, "5")).toBe(true);
    expect(fieldValid(f.region, "us")).toBe(true);
    expect(fieldValid(f.region, "asia")).toBe(false);
    const ints = agentInputOf({ type: "object", properties: { ids: { type: "array", items: { type: "integer" } }, code: { type: "string", minLength: 2, maxLength: 3 } } });
    const g = ints.kind === "fields" ? Object.fromEntries(ints.form.fields) : {};
    expect(fieldValid(g.ids, "1\n2")).toBe(true);
    expect(fieldValid(g.ids, "1\ntwo")).toBe(false);
    expect(fieldValid(g.code, "a")).toBe(false);
    expect(fieldValid(g.code, "abcd")).toBe(false);
    expect(fieldValid(g.code, "abc")).toBe(true);
  });
  it("places a refusal's issue at its field, an item's issue at its list, and says it by the field's label", () => {
    expect(fieldOfIssue("input.company")).toBe("company");
    expect(fieldOfIssue("input.topics.1")).toBe("topics");
    expect(fieldOfIssue("max_cost_usd")).toBeNull();
    expect(fieldIssueWords({ field: "input.company", reason: "missing", message: "input.company is required" }, "company", f.company)).toBe("Company is required.");
    expect(fieldIssueWords({ field: "input.limit", reason: "wrong_type", message: "x" }, "limit", f.limit)).toBe("limit takes a whole number.");
    expect(fieldIssueWords({ field: "input.topics.1", reason: "wrong_type", message: "x" }, "topics", f.topics)).toBe("Each line of topics is text.");
  });
});
