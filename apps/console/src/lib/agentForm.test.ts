import { describe, expect, it } from "vitest";
import { createBody, editBody, harnessOptions, saveError } from "./agentForm";
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

  it("sends no note when there is none", () => {
    expect(editBody(a, { name: "Invoice checker 2" }, "  ")).not.toHaveProperty("note");
  });

  it("keeps a workflow's workflow and never gives it a thinking level", () => {
    const body = editBody(w, { description: "Triage, then reply.", thinking: "high" }, "");
    expect(body.definition.workflow).toEqual((workflow.body.definition as { workflow: unknown }).workflow);
    expect(body.definition).not.toHaveProperty("thinking");
  });
});

describe("createBody", () => {
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
