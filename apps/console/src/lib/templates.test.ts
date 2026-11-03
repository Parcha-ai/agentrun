import { describe, expect, it } from "vitest";
import { keeper } from "./idempotency";
import { TEMPLATES, templateHarness, templateOffer, tryTemplate } from "./templates";
import { toolOffers } from "./agentForm";

const offers = toolOffers([
  { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "web_fetch", available: true, harnesses: ["pi", "claude-agent", "codex"] },
]);

// The first-run templates: each shows the product doing something different, with no key beyond a model.
describe("TEMPLATES", () => {
  it("are three: a file written, a page read, and a plain answer", () => {
    expect(TEMPLATES.map((t) => [t.name, t.tools])).toEqual([["Hello, AgentRun", ["write"]], ["Summarize a web page", ["web_fetch"]], ["Plan a task", []]]);
    expect(TEMPLATES[0]!.input).toBe("Write hello.md listing three things you could help me with on this machine, then answer in one line.");
  });
});

describe("templateHarness", () => {
  it("is the first available harness the server names a default model for, pi first", () => {
    expect(templateHarness([{ id: "pi", available: true, default_model: "faux/faux-1" }, { id: "codex", available: true, default_model: "openai/gpt-x" }])).toBe("pi");
    expect(templateHarness([{ id: "pi", available: true, default_model: null }, { id: "codex", available: true, default_model: "openai/gpt-x" }])).toBe("codex");
  });
  it("is none when no harness has a model to run: the model step comes first", () => {
    expect(templateHarness([{ id: "pi", available: true, default_model: null }, { id: "claude-agent", available: false, default_model: null }])).toBeNull();
    expect(templateHarness([])).toBeNull();
  });
});

describe("templateOffer", () => {
  it("offers a template whose tools the harness runs here, and says why not otherwise", () => {
    expect(templateOffer(TEMPLATES[1]!, "pi", offers)).toEqual({ ok: true });
    const off = toolOffers([{ name: "write", available: true, harnesses: ["pi"] }, { name: "web_fetch", available: false, missing: ["NETWORK"], harnesses: ["pi"] }]);
    expect(templateOffer(TEMPLATES[1]!, "pi", off)).toEqual({ ok: false, reason: "web_fetch can't run on this server yet" });
    expect(templateOffer(TEMPLATES[2]!, "pi", [])).toEqual({ ok: true });
  });
});

// One click: the template's agent is made once, and each click starts a run of it.
describe("tryTemplate", () => {
  const fake = (existing: { agent_id: string; definition: { name: string }; archived_at: string | null }[] = []) => {
    const calls: string[] = [];
    const v2 = {
      listAgents: async () => ({ agents: existing, next_cursor: null }),
      createAgent: async (body: { definition: { name: string; harness?: string; tools: string[] } }) => { calls.push(`create ${body.definition.name} on ${body.definition.harness} with ${body.definition.tools.join(",") || "no tools"}`); return { agent_id: "made-1" }; },
      startRun: async (id: string, body: { input: { content: string } }) => { calls.push(`run ${id}: ${body.input.content.slice(0, 20)}`); return { run: { run_id: "run-1" }, status: 202 }; },
    };
    return { v2, calls };
  };
  it("makes the agent on the harness given, then runs it, and answers with the run", async () => {
    const { v2, calls } = fake();
    expect(await tryTemplate(v2 as never, TEMPLATES[0]!, "pi")).toBe("run-1");
    expect(calls).toEqual(["create Hello, AgentRun on pi with write", "run made-1: Write hello.md listi"]);
  });
  it("runs the agent again when it already exists, never a second one; an archived one is made anew", async () => {
    const { v2, calls } = fake([{ agent_id: "hello-1", definition: { name: "Hello, AgentRun" }, archived_at: null }]);
    await tryTemplate(v2 as never, TEMPLATES[0]!, "pi");
    expect(calls).toEqual(["run hello-1: Write hello.md listi"]);
    const archived = fake([{ agent_id: "hello-0", definition: { name: "Hello, AgentRun" }, archived_at: "2026-11-01T00:00:00Z" }]);
    await tryTemplate(archived.v2 as never, TEMPLATES[0]!, "pi");
    expect(archived.calls[0]).toBe("create Hello, AgentRun on pi with write");
  });
  // A start whose answer was lost may have started the run: Try it again sends the same key, so the server answers with
  // that run rather than start a second one. Once a start lands, the next click is a new run.
  it("keeps the start's key across a lost answer, and a new one once a start lands", async () => {
    const keys: string[] = [];
    let lose = true;
    const v2 = {
      listAgents: async () => ({ agents: [{ agent_id: "hello-1", definition: { name: "Hello, AgentRun" }, archived_at: null }], next_cursor: null }),
      createAgent: async () => ({ agent_id: "never" }),
      startRun: async (_id: string, _body: unknown, key: string) => { keys.push(key); if (lose) { lose = false; throw new TypeError("Failed to fetch"); } return { run: { run_id: "run-1" }, status: 202 }; },
    };
    const held = keeper();
    await expect(tryTemplate(v2 as never, TEMPLATES[0]!, "pi", held)).rejects.toThrow("Failed to fetch");
    expect(await tryTemplate(v2 as never, TEMPLATES[0]!, "pi", held)).toBe("run-1");
    expect(await tryTemplate(v2 as never, TEMPLATES[0]!, "pi", held)).toBe("run-1");
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});
