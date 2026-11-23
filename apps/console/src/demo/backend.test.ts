import { describe, expect, it, vi } from "vitest";
import { ClientError, createClient, follow } from "@/lib/client";
import { createDemoFetch, DEMO_REFUSAL, demoCapabilities } from "./backend";
import { AGENTS, heroes, history } from "./tale";
import { createWorld } from "./world";

const OPENED = Date.parse("2026-11-18T15:00:00.000Z");

/** A demo client over a server that answers only what the demo leaves to it, recording each request it gets. */
function demo(now = { ms: OPENED }) {
  const asked: string[] = [];
  const real = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://server.invalid").pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v2/capabilities") return Response.json({ harnesses: [{ id: "pi", available: false, reason: "pi needs a key.", needs: ["key"], default_model: null }], models: { ready: false, needs: "key" }, tools: [{ name: "browser", available: false, reason: "it needs a key" }], secrets: [{ name: "model:OPENAI_API_KEY", set: true }], switches: { X: { on: true } }, features: { triggers: { routes: false } } });
    if (path === "/v2/templates") return Response.json({ templates: [{ id: "kyb", bundled: true }, { id: "ours", bundled: false }] });
    return Response.json({ signed_in: true });
  });
  const world = createWorld({ opened: OPENED, clock: () => now.ms });
  return { v2: createClient({ fetch: createDemoFetch({ real: real as unknown as typeof fetch, world }) }), asked, now, world };
}

describe("demo mode's backend", () => {
  it("answers the console's reads from the story, and asks the server only for the session and its catalogue", async () => {
    const { v2, asked } = demo();
    const agents = await v2.listAgents();
    expect(agents.agents.map((a) => a.agent_id)).toEqual(AGENTS.map((a) => a.id));
    const runs = await v2.listRuns(50);
    expect(runs.runs).toHaveLength(50);
    expect(runs.next_cursor).not.toBeNull();
    await v2.statsOver({});
    await v2.listTriggers();
    await v2.agentLearning("refund-desk");
    await v2.listMcpServers();
    expect(await v2.listSuggestions()).toMatchObject({ github: { connected: false }, suggestions: [] });
    expect(asked).toEqual([]);
    await v2.session();
    await v2.capabilities();
    await v2.listTemplates();
    expect(asked).toEqual(["GET /v2/auth/session", "GET /v2/capabilities", "GET /v2/templates"]);
  });

  it("shows the server's capabilities as ready, without its secrets' names or its switches", async () => {
    const caps = (await demo().v2.capabilities()) as unknown as Record<string, unknown>;
    expect(caps).not.toHaveProperty("secrets");
    expect(caps).not.toHaveProperty("switches");
    expect(caps.harnesses).toEqual([{ id: "pi", available: true, default_model: "anthropic/claude-sonnet-5-5" }]);
    expect(caps.models).toMatchObject({ ready: true, needs: null });
    expect(caps.tools).toEqual([{ name: "browser", available: true }]);
    expect(demoCapabilities({ learning: { pending: true, approve: false, approve_needs: "password" } })).toMatchObject({ features: { learning: "on", triggers: { routes: true } }, learning: { approve: true } });
  });

  it("lists only the templates the server ships with", async () => {
    expect((await demo().v2.listTemplates()).templates.map((t) => t.id)).toEqual(["kyb"]);
  });

  it("refuses a write the tour does not make, saying why, and sends none of it to the server", async () => {
    const { v2, asked } = demo();
    const refused = async (write: Promise<unknown>) => {
      const e = await write.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(ClientError);
      expect((e as ClientError).code).toBe("demo_mode");
      expect((e as ClientError).message).toBe(DEMO_REFUSAL);
    };
    await refused(v2.saveToolKey("openai", { OPENAI_API_KEY: "fake-test-key" }));
    await refused(v2.archiveAgent("refund-desk"));
    await refused(v2.applyTemplate("kyb", {}, "key-0"));
    await refused(v2.saveWebhook("https://hooks.example/x"));
    await refused(v2.deleteTrigger("trg-demo-weekly-brief"));
    await refused(v2.writeCorrections("refund-desk", "x", '"e"'));
    expect(asked).toEqual([]);
  });

  it("makes and edits an agent in the page's memory, and runs it as a stand-in that says so", async () => {
    const { v2, asked, now } = demo();
    const made = await v2.createAgent({ definition: { version: 1, name: "Invoice Matcher", description: "Matches invoices to orders.", instructions: "Match them.", harness: "pi", skills: [], tools: ["read"] } });
    expect(made).toMatchObject({ agent_id: "invoice-matcher", kind: "agentic", revisions: 1, definition: { name: "Invoice Matcher", tools: ["read"] } });
    expect((await v2.listAgents()).agents.at(-1)?.agent_id).toBe("invoice-matcher");
    const edited = await v2.updateDefinition("invoice-matcher", { definition: { description: "Matches each invoice to its order." }, note: "Clearer" }, null);
    expect(edited.agent).toMatchObject({ revisions: 2, definition: { description: "Matches each invoice to its order.", instructions: "Match them." } });
    expect((await v2.listRevisions("invoice-matcher")).revisions.map((r) => [r.version, r.note, r.current])).toEqual([[2, "Clearer", true], [1, null, false]]);
    // A story's agent takes an edit too, and keeps its earlier revisions.
    expect((await v2.updateDefinition("refund-desk", { definition: { description: "Decides refunds." } }, null)).agent.revisions).toBe(4);
    const { run } = await v2.startRun("invoice-matcher", { input: { content: "Match invoice 12" } }, "key-9");
    now.ms += 60_000;
    expect((await v2.getRun(run.run_id)).result?.final_answer).toMatch(/Demo mode calls no model/);
    expect(asked).toEqual([]);
  });

  it("lists connected Claude Code and Codex agents beside the server's own, ready to run", async () => {
    const agents = (await demo().v2.listAgents()).agents.filter((a) => a.definition.native);
    expect(agents.map((a) => [a.definition.name, a.definition.native?.runtime, a.native_status?.state])).toEqual([["Architect", "claude-code", "ready"], ["Code reviewer", "codex", "ready"]]);
    expect((await demo().v2.getNative("architect")).native).toMatchObject({ connected: true, selector: { kind: "agent", name: "architect" } });
  });

  it("shows three agents at different points of their learning", async () => {
    const { v2 } = demo();
    const of = async (id: string) => { const l = await v2.agentLearning(id); return [l.corrections.match(/^- /gm)?.length ?? 0, l.workflows.map((w) => w.status), l.counts.in_progress]; };
    expect(await of("refund-desk")).toEqual([4, ["serving", "pending"], 0]);
    expect(await of("support-triage")).toEqual([3, ["checking"], 1]);
    expect(await of("pr-reviewer")).toEqual([2, [], 0]);
  });

  it("holds a run at its approval until the person allows the call, then finishes it", async () => {
    const { v2, now } = demo();
    const waiting = await v2.getRun("demo-run-refund-approval");
    expect(waiting).toMatchObject({ status: "input_required", state: "waiting", pending: { kind: "approval", tool: "email_send" } });
    const approval = waiting.pending as { id: string };
    await v2.answerApproval("demo-run-refund-approval", approval.id, "allow");
    now.ms += 60_000;
    const done = await v2.getRun("demo-run-refund-approval");
    expect(done).toMatchObject({ status: "completed", pending: null });
    expect(done.result?.final_answer).toMatch(/Mara Ellison/);
    // Answered once: the same answer again finds nothing waiting.
    await expect(v2.answerApproval("demo-run-refund-approval", approval.id, "allow")).rejects.toMatchObject({ status: 409 });
  });

  it("a declined call is not said to have run: the answer says the buyer was not told", async () => {
    const { v2, now } = demo();
    const waiting = await v2.getRun("demo-run-refund-approval");
    await v2.answerApproval("demo-run-refund-approval", (waiting.pending as { id: string }).id, "deny");
    now.ms += 60_000;
    const answer = (await v2.getRun("demo-run-refund-approval")).result?.final_answer ?? "";
    expect(answer).toMatch(/You declined the email, so the buyer has not been told/);
    expect(answer).not.toMatch(/has the decision by email/);
  });

  it("takes an answer to a run's question, and goes on to write its files", async () => {
    const { v2, now } = demo();
    expect((await v2.getRun("demo-run-brief-question")).pending).toMatchObject({ kind: "question" });
    expect((await v2.listFiles("demo-run-brief-question")).files.map((f) => f.path)).toEqual(["inputs/message.md"]);
    await v2.sendMessage("demo-run-brief-question", "Use the bulletin's date.", "key-1");
    now.ms += 5 * 60_000;
    expect((await v2.getRun("demo-run-brief-question")).status).toBe("completed");
    // The files it wrote after the answer are there to open.
    expect((await v2.listFiles("demo-run-brief-question")).files.map((f) => f.path)).toEqual(["inputs/message.md", "brief.md", "sources.csv"]);
    expect(await v2.readFile("demo-run-brief-question", "brief.md")).toMatch(/^# Weekly risk brief/);
    const rows = (await v2.getTimeline("demo-run-brief-question")).rows;
    expect(rows.some((r) => r.kind === "user_message" && r.text === "Use the bulletin's date.")).toBe(true);
  });

  it("plays a started run live: working, its rows arriving, then completed", async () => {
    const { v2, now } = demo();
    const { run, status } = await v2.startRun("support-triage", { input: { content: "Ticket: my payout is late" } }, "key-2");
    expect(status).toBe(202);
    expect(run).toMatchObject({ status: "working", agent_id: "support-triage", title: "Ticket: my payout is late" });
    const first = await v2.getTimeline(run.run_id);
    expect(first.final).toBe(false);
    expect(first.rows[0]).toMatchObject({ kind: "user_message", text: "Ticket: my payout is late" });
    now.ms += 60_000;
    const last = await follow(v2, run.run_id, { minDelayMs: 0 });
    expect(last).toMatchObject({ status: "completed", final: true });
    expect(last.rows.at(-1)?.kind).toBe("usage");
    expect((await v2.listRuns(1)).runs[0].run_id).toBe(run.run_id);
  });

  it("stops a run that is going, and keeps what it did", async () => {
    const { v2, now } = demo();
    const { run } = await v2.startRun("support-triage", { input: {} }, "key-3");
    now.ms += 1_000;
    await v2.cancel(run.run_id);
    now.ms += 60_000;
    expect(await v2.getRun(run.run_id)).toMatchObject({ status: "cancelled", state: "idle" });
  });

  it("gives a workflow run its graph, moving while it runs", async () => {
    const { v2, now } = demo();
    const early = await v2.getRunGraph("demo-run-certificates-live");
    expect(early.run).toMatchObject({ id: "demo-run-certificates-live", agent: "certificate-review", status: "working" });
    now.ms += 10 * 60_000;
    const late = await v2.getRunGraph("demo-run-certificates-live");
    expect(late.run.status).toBe("completed");
    expect(late.decisions.length).toBeGreaterThan(early.decisions.length);
    expect((await v2.getRun("demo-run-certificates-live")).review).not.toBeNull();
  });

  it("a cancelled workflow run's graph stays as it stood, however much later it is read", async () => {
    const { v2, now } = demo();
    now.ms += 4_000;
    await v2.cancel("demo-run-certificates-live");
    const then = await v2.getRunGraph("demo-run-certificates-live");
    now.ms += 60 * 60_000;
    const later = await v2.getRunGraph("demo-run-certificates-live");
    expect(then.run.status).toBe("cancelled");
    expect({ ...later, read_at: null }).toEqual({ ...then, read_at: null });
    expect((await v2.getRun("demo-run-certificates-live")).status).toBe("cancelled");
  });

  it("counts Mission Control's figures from the same runs the lists show", async () => {
    const { v2 } = demo();
    const stats = await v2.statsOver({});
    const all: unknown[] = [];
    for (let cursor: string | null = null; ;) { const p = await v2.listRuns(200, cursor); all.push(...p.runs); cursor = p.next_cursor; if (!cursor) break; }
    expect(stats.runs.total).toBe(all.length);
    expect(stats.per_agent.reduce((n, a) => n + a.runs, 0)).toBe(all.length);
    expect(stats.runs.needs_input).toBe(2);
    expect(stats.analytics.by_day.reduce((n, d) => n + d.runs, 0)).toBe(all.length);
    // A range and an agent narrow the analytics alone; the tiles stay the whole store's.
    const narrowed = await v2.statsOver({ from: new Date(OPENED - 7 * 86_400_000).toISOString(), agent: "refund-desk" });
    expect(narrowed.runs).toEqual(stats.runs);
    expect(narrowed.cost).toEqual(stats.cost);
    expect(narrowed.analytics.totals.runs).toBeLessThan(stats.analytics.totals.runs);
    // An archived run leaves every figure but `archived`.
    await v2.archiveRun("demo-run-brief-done");
    const after = await v2.statsOver({});
    expect([after.runs.total, after.analytics.totals.runs, after.archived?.runs]).toEqual([all.length - 1, all.length - 1, 1]);
  });

  it("shows the Refund desk's cost falling once its learned workflow serves", async () => {
    const cost = await demo().v2.learningCost("refund-desk");
    expect(cost.summary.takeover).not.toBeNull();
    expect(cost.summary.times_cheaper).toBeGreaterThan(5);
    expect(cost.bill.break_even).not.toBeNull();
    expect((await demo().v2.learningCost("support-triage")).runs).toEqual([]);
  });
});

describe("the demo's story", () => {
  // The demo is shown to anyone: it holds no real person's address, no real host, and nothing shaped like a key.
  const text = JSON.stringify([AGENTS, heroes(), history(OPENED)]);
  it("uses only invented addresses and hosts", () => {
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.filter((e) => !e.endsWith(".example"))).toEqual([]);
    const hosts = [...text.matchAll(/https?:\/\/([\w.-]+)/g)].map((m) => m[1]);
    expect(hosts.filter((h) => !h.endsWith(".example"))).toEqual([]);
  });
  it("holds nothing shaped like a credential", () => {
    expect(text).not.toMatch(/\b(sk|pk|ar|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}|api[_-]?key|password|secret|bearer /i);
  });
  it("is the same at every load", () => {
    expect(JSON.stringify(history(OPENED))).toBe(JSON.stringify(history(OPENED)));
  });
});
