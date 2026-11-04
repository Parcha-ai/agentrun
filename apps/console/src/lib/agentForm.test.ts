import { describe, expect, it } from "vitest";
import { createBody, DECISION, decisionProvider, defaultTools, editBody, harnessOptions, reachesWeb, same, sandboxReason, saveError, toolOffers, toolsFor, WORKFLOW } from "./agentForm";
import { DECISION_STARTER } from "./decisionStarter";
import { WORKFLOW_STARTER } from "./workflowStarter";
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

describe("a decision agent", () => {
  it("is offered on create after the harnesses, as a choice and never a harness id: available when the server runs decision workflows, else disabled with why", () => {
    expect(DECISION).toBe("decision");
    expect(harnessOptions(caps.body.harnesses, { available: true }).map((h) => h.id)).toEqual(["pi", "claude-agent", "codex", "decision", "workflow"]);
    expect(harnessOptions(caps.body.harnesses, { available: true }).find((h) => h.id === "decision")).toEqual({ id: "decision", label: "Decision", available: true, reason: undefined });
    const off = harnessOptions([{ id: "pi", available: true }], { available: false }).find((h) => h.id === "decision")!;
    expect([off.id, off.available]).toEqual(["decision", false]);
    expect(off.reason).toMatch(/decision workflows/);
    expect(harnessOptions(caps.body.harnesses).map((h) => h.id)).not.toContain("decision");
  });

  it("is created as a workflow revision from the starter decision workflow: no instructions, harness, thinking or model, and no tools", () => {
    const body = createBody({ name: "Gambling check", description: "Is a payment for gambling?", instructions: "Typed before the choice.", harness: DECISION, tools: ["read"], thinking: "high", model: "faux/faux-1" });
    expect(body).toEqual({ definition: { version: 1, name: "Gambling check", description: "Is a payment for gambling?", workflow: DECISION_STARTER, skills: [], tools: [] } });
    expect(body.definition.workflow).not.toBe(DECISION_STARTER);
    expect(createBody({ name: "D", description: "", instructions: "", harness: DECISION, tools: [] }).definition).not.toHaveProperty("description");
  });

  // Capabilities' workflows as serve lists them (server.ts: adapters, and decisions.providers from decisions.ts).
  const workflows = (available: Record<string, boolean>) => ({
    adapters: ["runNode", "runEffect", ...(Object.values(available).some(Boolean) ? ["runJudge"] : [])],
    decisions: { providers: ["jev", "parallel", "openrouter"].map((id) => (available[id] ? { id, available: true } : { id, available: false, reason: `no key for ${id}` })) },
  });

  it("names the server's decision provider: Jev first, then Parallel; none when the server runs no decision workflows a starter can use", () => {
    expect(decisionProvider(workflows({ jev: true, parallel: true, openrouter: true }))).toBe("jev");
    expect(decisionProvider(workflows({ parallel: true }))).toBe("parallel");
    expect(decisionProvider(workflows({}))).toBeUndefined();
    // OpenRouter needs a model on every node, and where its key is set Jev runs too: alone, it is no starter's provider.
    expect(decisionProvider(workflows({ openrouter: true }))).toBeUndefined();
    expect(decisionProvider({ adapters: ["runNode", "runEffect"] })).toBeUndefined();
    expect(decisionProvider({ adapters: ["runNode", "runJudge"] })).toBe("jev");
    expect(decisionProvider(undefined)).toBeUndefined();
  });

  it("on a server whose only decision provider is Parallel, the starter's judge names parallel, with the decision demos' longer timeout", () => {
    const provider = decisionProvider(workflows({ parallel: true }));
    const made = createBody({ name: "D", description: "", instructions: "", harness: DECISION, tools: [], decisionProvider: provider }).definition.workflow as typeof DECISION_STARTER;
    expect(made.root.steps[0]).toMatchObject({ node: "judge", provider: "parallel", timeoutMs: 120000 });
    expect({ ...made, root: { ...made.root, steps: [DECISION_STARTER.root.steps[0], ...made.root.steps.slice(1)] } }).toEqual(DECISION_STARTER);
    expect(createBody({ name: "D", description: "", instructions: "", harness: DECISION, tools: [], decisionProvider: "jev" }).definition.workflow).toEqual(DECISION_STARTER);
    expect(DECISION_STARTER.root.steps[0]).not.toHaveProperty("provider");
  });

  it("starts from a decision workflow with an example input: a typed question, then a person for an unclear or low-confidence answer", () => {
    const steps = DECISION_STARTER.root.steps.map((s) => s.node);
    expect(steps).toEqual(["judge", "escalate", "escalate", "escalate"]);
    expect(DECISION_STARTER.root.steps.slice(1).map((s) => (s as { when: { predicate: string } }).when.predicate)).toEqual(["field_equals", "not", "lt"]);
    expect(DECISION_STARTER.schemas.Input.examples).toHaveLength(1);
    expect(DECISION_STARTER.root.steps[0]).not.toHaveProperty("provider");
  });

  // A server runs a code node only when its operator allows them (--allow-code-nodes), and refuses the run of a
  // workflow that holds one otherwise: a starter with one would make agents whose every run a default server refuses.
  it("has no code node anywhere, on any provider, so a default server runs it", () => {
    const kinds = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(kinds);
      if (!node || typeof node !== "object") return [];
      const own = typeof (node as { node?: unknown }).node === "string" ? [(node as { node: string }).node] : [];
      return [...own, ...Object.values(node).flatMap(kinds)];
    };
    for (const provider of [undefined, "parallel"]) {
      const workflow = createBody({ name: "D", description: "", instructions: "", harness: DECISION, tools: [], decisionProvider: provider }).definition.workflow;
      const nodes = kinds((workflow as { root: unknown }).root);
      expect(nodes).toContain("judge");
      expect(nodes).not.toContain("code");
      expect(JSON.stringify(workflow)).not.toMatch(/"via":"(?:executor|shell)"/);
    }
  });
});

describe("a general workflow agent", () => {
  it("is offered on create after Decision, available on every server, a server with no decision provider included; never when editing", () => {
    expect(WORKFLOW).toBe("workflow");
    for (const available of [true, false]) {
      expect(harnessOptions(caps.body.harnesses, { available }).at(-1)).toEqual({ id: "workflow", label: "Workflow", available: true, reason: undefined });
    }
    expect(harnessOptions(caps.body.harnesses).map((h) => h.id)).not.toContain("workflow");
  });

  it("is created as a workflow revision from the general starter: no instructions, harness, thinking, model or tools, and no decision provider", () => {
    const body = createBody({ name: "Next steps", description: "Says what to do next.", instructions: "Typed before the choice.", harness: WORKFLOW, tools: ["read"], thinking: "high", model: "faux/faux-1" });
    expect(body).toEqual({ definition: { version: 1, name: "Next steps", description: "Says what to do next.", workflow: WORKFLOW_STARTER, skills: [], tools: [] } });
    expect(body.definition.workflow).not.toBe(WORKFLOW_STARTER);
    expect(createBody({ name: "W", description: "", instructions: "", harness: WORKFLOW, tools: [], decisionProvider: "parallel" }).definition.workflow).toEqual(WORKFLOW_STARTER);
  });

  // A default server refuses the run of a workflow with a code node (no --allow-code-nodes), and a decision node needs a
  // decision provider: the general starter has neither, so any server runs it.
  it("has no code node and no decision node: one agent step in a chain, with an example input", () => {
    const kinds = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(kinds);
      if (!node || typeof node !== "object") return [];
      const own = typeof (node as { node?: unknown }).node === "string" ? [(node as { node: string }).node] : [];
      return [...own, ...Object.values(node).flatMap(kinds)];
    };
    const workflow = createBody({ name: "W", description: "", instructions: "", harness: WORKFLOW, tools: [] }).definition.workflow as typeof WORKFLOW_STARTER;
    expect(kinds(workflow.root)).toEqual(["chain", "agent"]);
    expect(JSON.stringify(workflow)).not.toMatch(/"node":"(?:code|judge|escalate)"|"via":"(?:executor|shell)"|"provider"/);
    expect(workflow.schemas.Input.examples).toHaveLength(1);
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

describe("tools by default (tools on, Miguel's rule), and whether the agent reaches the web", () => {
  const offers = toolOffers([
    { name: "read", available: true }, { name: "write", available: true }, { name: "edit", available: true },
    { name: "fetch_page", available: true }, { name: "ask_person", available: true }, { name: "browser", available: false, missing: ["BROWSERBASE_API_KEY"] },
  ]);
  it("takes the server's tools as objects", () => {
    expect(offers.find((t) => t.name === "browser")).toEqual({ name: "browser", available: false, missing: ["BROWSERBASE_API_KEY"] });
  });
  it("a new pi agent starts with every tool the server can run ticked, never one it can't", () => {
    expect(defaultTools("pi", offers)).toEqual(["read", "write", "edit", "fetch_page", "ask_person"]);
  });
  it("on Claude or Codex, only the tools that harness runs here: the server's own rule until it says per harness", () => {
    expect(defaultTools("claude-agent", offers)).toEqual(["read", "write", "edit"]);
    expect(defaultTools("codex", offers)).toEqual(["read", "write", "edit"]);
  });
  it("follows the server when it says which harnesses run each tool", () => {
    const said = toolOffers([{ name: "read", available: true, harnesses: ["pi", "codex"] }, { name: "fetch_page", available: true, harnesses: ["pi", "codex"] }, { name: "ask_person", available: true, harnesses: ["pi"] }]);
    expect(defaultTools("codex", said)).toEqual(["read", "fetch_page"]);
  });
  it("reaches the web with any of fetch_page, web_fetch and web_search, and with none of them does not", () => {
    for (const web of ["fetch_page", "web_fetch", "web_search"]) expect(reachesWeb(["read", web]), web).toBe(true);
    expect(reachesWeb(["read", "write", "ask_person"])).toBe(false);
    expect(reachesWeb([])).toBe(false);
  });
  it("keeps what each tool does, as the server says it", () => {
    expect(toolOffers([{ name: "web_fetch", available: true, summary: "Read one public web page." }])).toEqual([{ name: "web_fetch", available: true, summary: "Read one public web page." }]);
  });
});

describe("toolOffers, a tool object that doesn't say whether it's available", () => {
  it("reads it as available: only an explicit false makes a tool unavailable", () => {
    expect(toolOffers([{ name: "read" }])).toEqual([{ name: "read", available: true }]);
    expect(toolOffers([{ name: "read", available: false }])).toEqual([{ name: "read", available: false }]);
  });
});

describe("call-only tools", () => {
  const offers = toolOffers([
    { name: "read", nodes: true, available: true, harnesses: ["pi", "codex"] },
    { name: "pdf_pages", nodes: false, call_only: true, available: true, harnesses: ["pi"] },
  ]);
  it("keeps what capabilities say of a tool: call_only and nodes", () => {
    expect(offers[1]).toEqual({ name: "pdf_pages", available: true, harnesses: ["pi"], call_only: true, nodes: false });
  });
  it("no harness runs one, so no agent starts with one ticked", () => {
    expect(toolsFor("pi", offers).map((t) => t.name)).toEqual(["read"]);
    expect(defaultTools("pi", offers)).toEqual(["read"]);
  });
});

describe("sandbox-only tools", () => {
  const offers = toolOffers([
    { name: "read", nodes: true, available: true, harnesses: ["pi", "codex"] },
    { name: "bash", nodes: false, sandbox_only: true, available: true, harnesses: ["pi", "codex"] },
  ]);
  it("keeps what capabilities say of a tool: sandbox_only", () => {
    expect(offers[1]).toEqual({ name: "bash", available: true, harnesses: ["pi", "codex"], sandbox_only: true, nodes: false });
  });
  it("lists one for an agent to name, and starts no new agent with it ticked: a new agent's place is the runner", () => {
    expect(toolsFor("codex", offers).map((t) => t.name)).toEqual(["read", "bash"]);
    expect(defaultTools("pi", offers)).toEqual(["read"]);
  });
  it("can be ticked only on an agent whose place is a sandbox: a new agent, or a runner one, says why not", () => {
    for (const place of [undefined, { mode: "runner" }]) expect(sandboxReason(offers[1], place)).toMatch(/^Sandbox-only: it runs in a box/);
    expect(sandboxReason(offers[1], { mode: "sandbox", box: "docker" })).toBeUndefined();
    expect(sandboxReason(offers[0], undefined)).toBeUndefined();
  });
});

// Where an agent runs: a new agent's place goes in its first revision, and a tool's reason from the server is kept.
describe("places in the definition", () => {
  it("createBody carries the place the form picked, and none when it picked none", () => {
    expect(createBody({ name: "A", description: "", instructions: "Do it.", harness: "pi", tools: ["read", "bash"], place: { mode: "sandbox", box: "docker" } }).definition.place).toEqual({ mode: "sandbox", box: "docker" });
    expect(createBody({ name: "A", description: "", instructions: "Do it.", harness: "pi", tools: [] }).definition).not.toHaveProperty("place");
  });
  it("toolOffers keeps a tool's reason, for a tool the server can't run with nothing missing", () => {
    expect(toolOffers([{ name: "bash", available: false, sandbox_only: true, reason: "fixture: no box" }])).toEqual([{ name: "bash", available: false, sandbox_only: true, reason: "fixture: no box" }]);
  });
});
