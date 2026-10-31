import { describe, expect, it } from "vitest";
import { kybWorkflow } from "@/fixtures/dwf/workflows";
import { lineCol, lintWorkflow, nodeAtOffset, nodeMeta, parseWithSpans, spanOf } from "./workflowDoc";

describe("parseWithSpans", () => {
  it("parses as JSON.parse does, with each value's span by its pointer", () => {
    const text = JSON.stringify(kybWorkflow, null, 2);
    const r = parseWithSpans(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(JSON.parse(text));
    const s = r.spans.get("/root/steps/2/label")!;
    expect(text.slice(s.start, s.end)).toBe('"cross-check"');
    expect(r.spans.get("/root/steps/3/branches/approve/body")).toBeDefined();
  });
  it("names where the JSON breaks", () => {
    const text = '{\n  "v": 2,\n  "name": "x"\n  "root": {}\n}';
    const r = parseWithSpans(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(lineCol(text, r.error.offset)).toEqual({ line: 4, col: 3 });
    expect(r.error.message).toMatch(/expected , or }/);
  });
  it("refuses a trailing comma and a raw line break in a string", () => {
    expect(parseWithSpans('{"a": [1, 2,]}').ok).toBe(false);
    expect(parseWithSpans('{"a": "x\ny"}').ok).toBe(false);
  });
  it("finds the innermost node under an offset, and the nearest span of a pointer", () => {
    const text = JSON.stringify(kybWorkflow, null, 2);
    const r = parseWithSpans(text);
    if (!r.ok) throw new Error("no parse");
    const at = text.indexOf('"cross-check"');
    expect(nodeAtOffset(r.spans, ["/root", "/root/steps/2"], at)).toBe("/root/steps/2");
    expect(spanOf(r.spans, "/root/steps/2/not-there")).toEqual(r.spans.get("/root/steps/2"));
  });
});

describe("nodeMeta", () => {
  it("reads a decision node's provider, model, questions and images from the workflow", () => {
    const m = nodeMeta(kybWorkflow, "/root/steps/1/branches/0");
    expect(m).toMatchObject({ decision: true, provider: "parallel", model: "standard", web: true });
    expect(m.questions!.map((q) => q.id)).toEqual(["registered", "active", "name_matches"]);
    expect(nodeMeta(kybWorkflow, "/root/steps/1/branches/1").images).toEqual(["<cert>"]);
    expect(nodeMeta(kybWorkflow, "/root/steps/3")).toMatchObject({ decision: true, provider: "jev", unsure: { branch: "review", gte: 0.75 } });
    expect(nodeMeta(kybWorkflow, "/root/steps/0")).toEqual({ decision: false, tool: "pdf_pages" });
  });
  it("reads the engine's graph-node questions, and an ask predicate as a decision", () => {
    const m = nodeMeta({ root: { node: "escalate", label: "x", when: { predicate: "ask" } } }, "/root", { questions: [{ id: "holds", type: "noul", instructions: "Is it?" }] });
    expect(m).toMatchObject({ decision: true, provider: "jev", questions: [{ id: "holds", type: "noul", text: "Is it?" }] });
  });
  it("prefers what the graph node carries", () => {
    expect(nodeMeta(kybWorkflow, "/root/steps/2", { provider: "openrouter", model: "liquid/d1" })).toMatchObject({ provider: "openrouter", model: "liquid/d1" });
  });
});

describe("lintWorkflow", () => {
  it("finds nothing in a well-formed workflow", () => {
    expect(lintWorkflow(kybWorkflow)).toEqual([]);
  });
  it("names a missing output", () => {
    const { output: _o, ...w } = kybWorkflow;
    expect(lintWorkflow(w).map((i) => i.message)).toEqual([expect.stringMatching(/needs an output/)]);
  });
  it("names an unknown kind, a missing schema, an unseen image token, an OpenRouter node with no model", () => {
    const w = structuredClone(kybWorkflow) as unknown as { root: { steps: Record<string, unknown>[] } };
    w.root.steps[0] = { node: "fetch", label: "x" };
    w.root.steps[2] = { ...w.root.steps[2], out: "Nope", provider: "openrouter" };
    (w.root.steps[1] as { branches: Record<string, unknown>[] }).branches[1] = { node: "judge", label: "look", state: {}, images: { "<cert>": "{x}" }, out: "CertLook", as: "look" };
    const issues = lintWorkflow(w).map((i) => `${i.path}: ${i.message}`);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/root\/steps\/0\/node: "fetch" is not a node kind/),
      expect.stringMatching(/^\/root\/steps\/2\/out: no schema "Nope"/),
      expect.stringMatching(/^\/root\/steps\/2: an openrouter decision names its model/),
      expect.stringMatching(/^\/root\/steps\/1\/branches\/1\/images\/<cert>: the image token/),
    ]));
  });
});
