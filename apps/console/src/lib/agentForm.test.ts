import { describe, expect, it } from "vitest";
import { createBody, editBody, harnessOptions, same, saveError } from "./agentForm";
import { ClientError } from "./client";
import agent from "../fixtures/agent.invoice-checker.json";
import workflow from "../fixtures/agent.support-triage.json";
import caps from "../fixtures/capabilities.json";
import invalid from "../fixtures/write.definition-invalid-harness.json";
import stale from "../fixtures/write.definition-put-stale.json";

const a = agent.body as never;
const w = workflow.body as never;

describe("editBody", () => {
  it("is the current definition with the edited fields, as the next revision, keeping every field the form does not show", () => {
    const body = editBody(a, { instructions: "Check it twice.", harness: "codex" }, "Twice");
    expect(body.definition).toEqual({ ...agent.body.definition, instructions: "Check it twice.", harness: "codex", version: agent.body.revisions + 1 });
    expect(body.note).toBe("Twice");
    expect(body).not.toHaveProperty("skills");
  });

  it("never changes the name or description: the agent store keeps them from the agent's creation", () => {
    const body = editBody(a, { name: "Renamed", description: "", instructions: "Check it twice." }, "");
    expect(body.definition.name).toBe(agent.body.definition.name);
    expect(body.definition.description).toBe(agent.body.definition.description);
    const bare = editBody({ ...(agent.body as object), definition: { ...agent.body.definition, description: undefined } } as never, { description: "" }, "");
    expect(bare.definition).not.toHaveProperty("description");
  });

  it("numbers a changed definition as the next revision, even when the current one is an earlier revision", () => {
    // serve: a new revision is number revisions + 1 (agents.ts, the commit's checkVersion).
    const earlier = { ...(agent.body as object), revisions: 3, definition: { ...agent.body.definition, version: 1 } } as never;
    expect(editBody(earlier, { instructions: "Again." }, "")).toMatchObject({ unchanged: false, definition: { version: 4 } });
  });

  it("says when nothing changed: the same definition makes no new revision, a note alone included", () => {
    // serve: a definition equal to the current revision makes none, and its version must be the current one.
    const same = editBody(a, { instructions: agent.body.definition.instructions }, "Only a note");
    expect(same.unchanged).toBe(true);
    expect(same.definition.version).toBe(agent.body.definition.version);
    expect(editBody(w, { instructions: "", tools: (workflow.body.definition as { tools: string[] }).tools }, "").unchanged).toBe(true);
  });

  it("is unchanged whatever the order of the definition's keys: the server's order and the form's differ", () => {
    const d = agent.body.definition as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(d).reverse());
    const same = editBody({ ...(agent.body as object), definition: reordered } as never, { instructions: d.instructions as string, tools: d.tools as string[] }, "");
    expect(same.unchanged).toBe(true);
    expect(same.definition.version).toBe(d.version);
  });

  it("sends no note when there is none", () => {
    expect(editBody(a, { name: "Invoice checker 2" }, "  ")).not.toHaveProperty("note");
  });

  it("sends a workflow no instructions, model or thinking: the server refuses them beside a workflow", () => {
    const body = editBody(w, { instructions: "", model: "faux/faux-1", thinking: "high", tools: [] }, "");
    expect(body.definition).not.toHaveProperty("instructions");
    expect(body.definition).not.toHaveProperty("model");
    expect(body.definition).not.toHaveProperty("thinking");
  });

  it("sends no empty model: empty means the server's default", () => {
    expect(editBody(a, { model: "" }, "").definition).not.toHaveProperty("model");
  });

  it("keeps a workflow's workflow and never gives it a thinking level", () => {
    const body = editBody(w, { description: "Triage, then reply.", thinking: "high" }, "");
    expect(body.definition.workflow).toEqual((workflow.body.definition as { workflow: unknown }).workflow);
    expect(body.definition).not.toHaveProperty("thinking");
  });
});

describe("createBody", () => {
  it("keeps the thinking level and model the form chose, and leaves an empty model out", () => {
    const body = createBody({ name: "A", description: "", instructions: "Do it.", harness: "pi", tools: [], thinking: "high", model: "faux/faux-1" });
    expect(body.definition).toMatchObject({ thinking: "high", model: "faux/faux-1" });
    expect(createBody({ name: "A", description: "", instructions: "Do it.", harness: "pi", tools: [], model: "" }).definition).not.toHaveProperty("model");
  });

  it("is a first revision with what the form names, and an empty skill set", () => {
    expect(createBody({ name: "Changelog checker", description: "", instructions: "Read the change.", harness: "pi", tools: ["read"] })).toEqual({
      definition: { version: 1, name: "Changelog checker", instructions: "Read the change.", harness: "pi", skills: [], tools: ["read"] },
    });
  });
});

describe("harnessOptions", () => {
  it("offers pi, Claude and Codex in that order, each available or disabled with the server's reason", () => {
    expect(harnessOptions(caps.body.harnesses)).toEqual([
      { id: "pi", label: "Pi", available: true, reason: undefined },
      { id: "claude-agent", label: "Claude", available: false, reason: "This server does not run claude-agent yet." },
      { id: "codex", label: "Codex", available: false, reason: "This server does not run codex yet." },
    ]);
  });
  it("offers nothing the server does not list", () => {
    expect(harnessOptions([{ id: "pi", available: true }]).map((h) => h.id)).toEqual(["pi"]);
  });
});

describe("saveError", () => {
  const err = (rec: { status: number; body: { error: { code: string; message: string; fields?: unknown } } }) =>
    Object.assign(new ClientError(rec.status, rec.body.error.code, rec.body.error.message), { fields: rec.body.error.fields });
  it("reads a stale If-Match as a conflict: someone saved first", () => {
    expect(saveError(err(stale as never))).toMatchObject({ kind: "conflict" });
  });
  it("reads a 422 as the fields to fix, by field", () => {
    expect(saveError(err(invalid as never))).toEqual({ kind: "invalid", message: invalid.body.error.message, fields: { "definition.harness": "definition.harness is one of pi, claude-agent, codex" } });
  });
});

describe("same", () => {
  it("compares JSON by value whatever the order of its keys, nested objects included, and arrays in order", () => {
    expect(same({ a: 1, b: { c: 1, d: [1, 2] } }, { b: { d: [1, 2], c: 1 }, a: 1 })).toBe(true);
    expect(same({ a: 1, b: { c: 1 } }, { a: 1, b: { c: 2 } })).toBe(false);
    expect(same({ tools: ["read", "write"] }, { tools: ["write", "read"] })).toBe(false);
    expect(same({ a: 1, gone: undefined }, { a: 1 })).toBe(true);
  });
});
