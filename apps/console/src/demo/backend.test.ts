import { describe, expect, it, vi } from "vitest";
import { editBody } from "@/lib/agentForm";
import { ClientError, createClient, follow } from "@/lib/client";
import { createDemoFetch, DEMO_REFUSAL, demoCapabilities } from "./backend";
import { AGENTS, heroes, history } from "./tale";
import { demoUpload } from "./mode";
import { CORRECTION_MS, createWorld } from "./world";

const OPENED = Date.parse("2026-11-18T15:00:00.000Z");

/** A demo client over a server that answers only what the demo leaves to it, recording each request it gets. */
function demo(now = { ms: OPENED }) {
  const asked: string[] = [];
  const real = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://server.invalid").pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v2/capabilities") return Response.json({ harnesses: [{ id: "pi", available: false, reason: "pi needs a key.", needs: ["key"], default_model: null }], models: { ready: false, needs: "key" }, tools: [{ name: "browser", available: false, reason: "it needs a key" }], secrets: [{ name: "model:OPENAI_API_KEY", set: true }], switches: { X: { on: true } }, features: { triggers: { routes: false } } });
    if (path === "/v2/marketplace/templates") return Response.json({ url: "https://marketplace.example", state: "read", read_at: "2026-11-24T00:00:00.000Z", templates: [{ name: "kyb", title: "KYB", tags: [], needs: [], page_url: "https://marketplace.example/templates/kyb/", here: "kyb" }, { name: "ours", title: "Ours", tags: [], needs: [], page_url: "https://marketplace.example/templates/ours/", here: "ours" }, { name: "brief", title: "Brief", tags: [], needs: [], page_url: "https://marketplace.example/templates/brief/" }] });
    if (path === "/v2/templates") return Response.json({ templates: [{ id: "kyb", bundled: true, model: { tier: "balanced", choices: [{ id: "codex", label: "Codex", model: "openai/gpt-6.1-sol", harness: "codex", warning: null, note: null, secrets: [] }] } }, { id: "ours", bundled: false }] });
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
    expect(await v2.listSuggestions()).toMatchObject({ github: { connected: true }, repositories: [{ repo: "larkspur/marketplace", scan: { status: "completed" } }] });
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

  it("lists the marketplace's templates as the server read them, each marked here only for a template it ships with", async () => {
    const list = await demo().v2.listMarketplaceTemplates();
    expect(list.templates.map((t) => [t.name, t.here ?? null])).toEqual([["kyb", "kyb"], ["ours", null], ["brief", null]]);
  });

  it("refuses a write to the server's own settings, which demo mode hides, and sends none of it to the server", async () => {
    const { v2, asked } = demo();
    const refused = async (write: Promise<unknown>) => {
      const e = await write.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(ClientError);
      expect((e as ClientError).code).toBe("demo_mode");
      expect((e as ClientError).message).toBe(DEMO_REFUSAL);
    };
    await refused(v2.saveToolKey("openai", { OPENAI_API_KEY: "fake-test-key" }));
    await refused(v2.saveWebhook("https://hooks.example/x"));
    expect(asked).toEqual([]);
  });

  it("makes and edits an agent in the page's memory, and runs it as a stand-in that says so", async () => {
    const { v2, asked, now } = demo();
    const made = await v2.createAgent({ definition: { version: 1, name: "Invoice Matcher", description: "Matches invoices to orders.", instructions: "Match them.", harness: "pi", skills: [], tools: ["read"] } });
    expect(made).toMatchObject({ agent_id: "invoice-matcher", kind: "agentic", revisions: 1, definition: { name: "Invoice Matcher", tools: ["read"] } });
    expect((await v2.listAgents()).agents.at(-1)?.agent_id).toBe("invoice-matcher");
    const edited = await v2.updateDefinition("invoice-matcher", { definition: { ...made.definition, description: "Matches each invoice to its order." }, note: "Clearer" }, null);
    expect(edited.agent).toMatchObject({ revisions: 2, definition: { description: "Matches each invoice to its order.", instructions: "Match them." } });
    expect((await v2.listRevisions("invoice-matcher")).revisions.map((r) => [r.version, r.note, r.current])).toEqual([[2, "Clearer", true], [1, null, false]]);
    // A story's agent takes an edit too, and keeps its earlier revisions.
    expect((await v2.updateDefinition("refund-desk", { definition: { ...(await v2.getAgent("refund-desk")).agent.definition, description: "Decides refunds." } }, null)).agent.revisions).toBe(4);
    const { run } = await v2.startRun("invoice-matcher", { input: { content: "Match invoice 12" } }, "key-9");
    now.ms += 60_000;
    expect((await v2.getRun(run.run_id)).result?.final_answer).toMatch(/Demo mode calls no model/);
    expect(asked).toEqual([]);
  });

  it("keeps complete skill files by revision and refuses stale edits without touching the server", async () => {
    const { v2, asked } = demo();
    const files = { "review/SKILL.md": "Review the change.", "review/rules.md": "Keep the evidence." };
    const made = await v2.createAgent({ definition: { version: 1, name: "Skill demo", instructions: "Review.", skills: ["review"], tools: [] }, skills: files });
    expect(await v2.getRevisionSkills(made.agent_id, made.revision!)).toEqual({ revision: made.revision, skills: files });
    const saved = await v2.updateDefinition(made.agent_id, { definition: made.definition, skills: { ...files, "review/SKILL.md": "Read the rules first." } }, made.home_etag);
    expect((await v2.getRevisionSkills(made.agent_id, saved.agent.revision!)).skills).toEqual({ ...files, "review/SKILL.md": "Read the rules first." });
    expect((await v2.getRevisionSkills(made.agent_id, made.revision!)).skills).toEqual(files);
    await expect(v2.updateDefinition(made.agent_id, { definition: made.definition, skills: {} }, made.home_etag)).rejects.toMatchObject({ status: 412 });
    await expect(v2.getRevisionSkills("refund-desk", made.revision!)).rejects.toMatchObject({ status: 404 });
    await v2.setCurrent(made.agent_id, made.revision!);
    const renamed = await v2.updateDefinition(made.agent_id, { definition: { ...made.definition, description: "Keep the current files." } }, made.home_etag);
    expect((await v2.getRevisionSkills(made.agent_id, renamed.agent.revision!)).skills).toEqual(files);
    const empty = await v2.updateDefinition(made.agent_id, { definition: { ...renamed.agent.definition, skills: [] }, skills: {} }, renamed.etag);
    expect((await v2.getRevisionSkills(made.agent_id, empty.agent.revision!)).skills).toEqual({});
    expect(asked).toEqual([]);
  });

  it("clears removed optional settings after saving and reopening, while preserving the original revision", async () => {
    const { v2, asked, now } = demo();
    const made = await v2.createAgent({ definition: { version: 1, name: "Reset settings", instructions: "Review.", harness: "pi", model: "test/model", thinking: "high", skills: [], tools: ["read"] } });
    const body = editBody(made, { thinking: undefined, model: "" }, "Use model defaults");
    expect(body.definition).not.toHaveProperty("thinking");
    expect(body.definition).not.toHaveProperty("model");
    await v2.updateDefinition(made.agent_id, body, made.home_etag);
    const reopened = (await v2.getAgent(made.agent_id)).agent;
    expect(reopened.definition).not.toHaveProperty("thinking");
    expect(reopened.definition).not.toHaveProperty("model");
    expect(reopened.definition).toMatchObject({ instructions: "Review.", harness: "pi", tools: ["read"] });
    const { run } = await v2.startRun(made.agent_id, { input: { content: "Review the change." } }, "reset-model");
    now.ms += 60_000;
    expect((await v2.runUsage(run.run_id)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5-5" })]));
    await v2.setCurrent(made.agent_id, made.revision!);
    expect((await v2.getAgent(made.agent_id)).agent.definition).toMatchObject({ thinking: "high", model: "test/model" });
    const restored = await v2.startRun(made.agent_id, { input: { content: "Review again." } }, "restored-model");
    now.ms += 60_000;
    expect((await v2.runUsage(restored.run.run_id)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "test", model: "model" })]));
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

  it("opens each agent's own learning files: a workflow it lists reads as its graph, and its corrections are its own", async () => {
    const { v2 } = demo();
    for (const id of ["refund-desk", "support-triage"]) {
      const learning = await v2.agentLearning(id);
      for (const w of learning.workflows) {
        const graph = JSON.parse((await v2.readLearningFile(id, w.file)).text) as { name: string; root: { node: string } };
        expect(graph).toMatchObject({ name: w.name, root: { node: "chain" } });
        expect((await v2.readLearningFile(id, w.readme)).text).toMatch(new RegExp(`^# ${w.name}`));
      }
      expect((await v2.readLearningFile(id, "corrections.md")).text).toBe(learning.corrections);
    }
    // A file another agent keeps is not this one's.
    await expect(v2.readLearningFile("support-triage", "workflows/refund-decision/workflow.json")).rejects.toMatchObject({ status: 404 });
  });

  it("takes the owner's OK on a workflow that waits for it: one being checked already is refused as the server would, and approves nothing", async () => {
    const { v2 } = demo();
    const pending = async () => (await v2.agentLearning("refund-desk")).workflows.find((w) => w.status === "pending");
    const triage = (await v2.agentLearning("support-triage")).workflows[0];
    await expect(v2.approveWorkflow("support-triage", triage.readme, triage.etag)).rejects.toMatchObject({ status: 409 });
    const waiting = await pending();
    expect(waiting).toBeDefined();
    await v2.approveWorkflow("refund-desk", waiting!.readme, waiting!.etag);
    expect(await pending()).toBeUndefined();
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

// Each write the tour reaches does what the server's would, on the sample data, and none of it reaches the server.
describe("demo mode's writes", () => {
  it("takes a grade of an ended run, as the server does, and keeps it beside the run", async () => {
    const { v2, asked } = demo();
    const graded = await v2.gradeRun("demo-run-refund-by-agent", { correct: true });
    expect(graded).toMatchObject({ run_id: "demo-run-refund-by-agent", correct: true, source: "feedback", feedback: null });
    expect((await v2.runLearning("demo-run-refund-by-agent"))?.graded).toMatchObject({ correct: true, feedback_status: null });
    expect(asked).toEqual([]);
  });

  it("runs a wrong grade's correction round to its end, which the run page sees move (its learning) and settle", async () => {
    const { v2, now } = demo();
    const graded = await v2.gradeRun("demo-run-refund-by-agent", { correct: false, label: "Quote the order number in the note." });
    expect(graded).toMatchObject({ correct: false, feedback: "correction" });
    // The round is under way: the run's learning reads reflecting, so the page reads it again until it settles.
    expect((await v2.getRun("demo-run-refund-by-agent")).learning?.state).toBe("reflecting");
    expect((await v2.runLearning("demo-run-refund-by-agent"))?.graded).toMatchObject({ feedback_status: "running" });
    now.ms += CORRECTION_MS;
    const run = await v2.getRun("demo-run-refund-by-agent");
    expect(run.learning).toMatchObject({ state: "merged", detail: "Kept a correction from your grade: Quote the order number in the note." });
    expect((await v2.runLearning("demo-run-refund-by-agent"))?.graded).toMatchObject({ feedback_status: "ended" });
    expect((await v2.agentLearning("refund-desk")).corrections).toContain("- Quote the order number in the note.");
  });

  it("answers a follow-up to an ended run: the run works again, then ends with its answer", async () => {
    const { v2, now } = demo();
    const sent = await v2.sendMessage("demo-run-refund-by-agent", "Was the shipping refunded too?", "k1");
    expect(sent).toMatchObject({ mode: "follow_up", status: "working" });
    now.ms += 10_000;
    const run = await v2.getRun("demo-run-refund-by-agent");
    expect(run).toMatchObject({ status: "completed", state: "idle" });
    expect(run.result?.final_answer).toMatch(/^On your follow-up/);
    const rows = (await v2.getTimeline("demo-run-refund-by-agent")).rows;
    expect(rows.some((r) => r.kind === "user_message" && r.text === "Was the shipping refunded too?")).toBe(true);
    expect(rows.at(-1)?.kind).toBe("usage");
  });

  it("takes a message while a run works as a steer, shown on its timeline", async () => {
    const { v2 } = demo();
    const { run } = await v2.startRun("support-triage", { input: { content: "Ticket: my parcel is late" } }, "k2");
    expect(await v2.sendMessage(run.run_id, "Mark it urgent", "k3")).toMatchObject({ mode: "steer" });
    expect((await v2.getTimeline(run.run_id)).rows.some((r) => r.text === "Mark it urgent")).toBe(true);
  });

  it("lets a run stopped at its spend cap go on once the cap is raised, and finish", async () => {
    const { v2, now } = demo();
    expect((await v2.getRun("demo-run-review-capped")).stopped_for).toBe("budget");
    expect(await v2.raiseCap("demo-run-review-capped", 3)).toMatchObject({ resumed: true, max_cost_usd: 3, status: "working" });
    now.ms += 10_000;
    const run = await v2.getRun("demo-run-review-capped");
    expect(run).toMatchObject({ status: "completed", error: null, stopped_for: null, cost: { cap_usd: 3 } });
    expect(run.result?.final_answer).toMatch(/^Reviewed PR #2210/);
  });

  it("pauses a workflow run's graph where it stands, and resumes it from there", async () => {
    const { v2, now } = demo();
    now.ms += 3_000;
    expect(await v2.pauseRun("demo-run-certificates-live")).toMatchObject({ paused: true });
    const held = await v2.getRunGraph("demo-run-certificates-live");
    now.ms += 60_000;
    const later = await v2.getRunGraph("demo-run-certificates-live");
    expect(later.run.paused).toBe(true);
    expect({ ...later, read_at: null }).toEqual({ ...held, read_at: null });
    expect(await v2.resumeRun("demo-run-certificates-live")).toMatchObject({ paused: false });
    now.ms += 5_000;
    expect((await v2.getRunGraph("demo-run-certificates-live")).decisions.length).toBeGreaterThan(held.decisions.length);
  });

  it("makes, edits, rotates and deletes a trigger", async () => {
    const { v2 } = demo();
    const made = await v2.createTrigger({ name: "Nightly refunds", source: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: "refund-desk", input: { content: "Clear the queue" } } }, "k4");
    expect(made).toMatchObject({ name: "Nightly refunds", enabled: true, target: { agent_id: "refund-desk" } });
    expect((await v2.listTriggers()).triggers.map((t) => t.id)).toContain(made.id);
    expect(await v2.updateTrigger(made.id, { name: "Nightly refund queue", enabled: false })).toMatchObject({ name: "Nightly refund queue", enabled: false });
    expect((await v2.rotateTriggerSecret("trg-demo-helpdesk-refunds")).signing_secret).toMatch(/^whsec_demo_/);
    expect(await v2.deleteTrigger(made.id)).toMatchObject({ deleted: true });
    expect((await v2.listTriggers()).triggers.map((t) => t.id)).not.toContain(made.id);
  });

  it("keeps an agent's edits: its corrections, a workflow retired and restored, an earlier revision made current, an archive", async () => {
    const { v2 } = demo();
    const before = await v2.corrections("refund-desk");
    await v2.writeCorrections("refund-desk", `${before.text}- Always quote the order number.\n`, before.etag);
    expect((await v2.corrections("refund-desk")).text).toMatch(/Always quote the order number/);
    const serving = (await v2.agentLearning("refund-desk")).workflows.find((w) => w.status === "serving")!;
    await v2.retireWorkflow("refund-desk", serving.readme, serving.etag);
    expect((await v2.agentLearning("refund-desk")).workflows.find((w) => w.name === serving.name)?.status).toBe("retired");
    const retired = (await v2.agentLearning("refund-desk")).workflows.find((w) => w.name === serving.name)!;
    await v2.restoreWorkflow("refund-desk", retired.readme, retired.etag);
    expect((await v2.agentLearning("refund-desk")).workflows.find((w) => w.name === serving.name)?.status).toBe("serving");
    const revisions = (await v2.listRevisions("refund-desk")).revisions;
    const first = revisions.at(-1)!;
    await v2.setCurrent("refund-desk", first.revision);
    expect((await v2.listRevisions("refund-desk")).revisions.find((r) => r.current)?.version).toBe(first.version);
    await v2.archiveAgent("pr-reviewer");
    expect((await v2.listAgents({ archived: true })).agents.map((a) => a.agent_id)).toEqual(["pr-reviewer"]);
    expect((await v2.listAgents()).agents.map((a) => a.agent_id)).not.toContain("pr-reviewer");
    await v2.unarchiveAgent("pr-reviewer");
    expect((await v2.listAgents({ archived: true })).agents).toEqual([]);
  });

  it("applies a bundled template: makes its agent in the page, reading only the catalogue from the server", async () => {
    const { v2, asked } = demo();
    const applied = await v2.applyTemplate("kyb", {}, "k5");
    expect(applied).toMatchObject({ template: "kyb", agent_change: "made", triggers: [] });
    expect((await v2.listAgents()).agents.map((a) => a.agent_id)).toContain(applied.agent_id);
    expect(asked).toEqual(["GET /v2/templates"]);
  });

  it("suggests agents from the sample repository: create one, discard and restore another, scan again", async () => {
    const { v2, now } = demo();
    const [first, second] = (await v2.listSuggestions()).suggestions;
    expect((await v2.getSuggestion(first.id)).files.length).toBeGreaterThan(0);
    const created = await v2.createSuggestedAgent(first.id);
    expect(created).toMatchObject({ status: "created", created: { branch: `agentrun/${first.key}` } });
    expect((await v2.listAgents()).agents.map((a) => a.agent_id)).toContain(created.created!.agent_id);
    expect(await v2.discardSuggestion(second.id)).toMatchObject({ status: "discarded" });
    expect(await v2.restoreSuggestion(second.id)).toMatchObject({ status: "open" });
    expect(await v2.scanRepository("larkspur/marketplace")).toMatchObject({ status: "running", already_running: false });
    expect((await v2.listSuggestions()).repositories[0].scan.status).toBe("running");
    now.ms += 10_000;
    expect((await v2.listSuggestions()).repositories[0]).toMatchObject({ scan: { status: "completed" }, counts: { created: 1, open: 2 } });
  });

  it("connects a Claude Code setup found on the demo's laptop as an agent, and enrolls a connector", async () => {
    const { v2 } = demo();
    const found = await v2.discoverNative("~/code/larkspur-web");
    expect(found.targets.map((t) => t.runtime)).toEqual(["claude-code", "codex"]);
    const { agent, native } = await v2.connectNative({ project: "~/code/larkspur-web", runtime: "claude-code", selector: { kind: "project" } });
    expect(native).toMatchObject({ runtime: "claude-code", state: "ready", connected: true });
    expect((await v2.getAgent(agent.agent_id)).agent.native_status).toMatchObject({ project: "~/code/larkspur-web" });
    expect(await v2.enrollConnector("Build laptop")).toMatchObject({ workspace_id: "local" });
  });

  it("disconnects a connected agent, which then starts no run, and connects the same setup again", async () => {
    const { v2 } = demo();
    const { agent } = await v2.connectNative({ project: "~/code/larkspur-web", runtime: "codex", selector: { kind: "project" } });
    expect((await v2.disconnectNative(agent.agent_id)).native).toMatchObject({ connected: false });
    expect((await v2.getAgent(agent.agent_id)).agent.native_status).toMatchObject({ connected: false });
    await expect(v2.startRun(agent.agent_id, { input: { content: "Fix the build" } }, "k6")).rejects.toMatchObject({ status: 409 });
    const again = await v2.connectNative({ project: "~/code/larkspur-web", runtime: "codex", selector: { kind: "project" } });
    expect(again).toMatchObject({ agent: { agent_id: agent.agent_id }, native: { connected: true } });
  });

  it("makes an edit saved after an earlier revision was made current the current one", async () => {
    const { v2 } = demo();
    const first = (await v2.listRevisions("refund-desk")).revisions.at(-1)!;
    await v2.setCurrent("refund-desk", first.revision);
    await v2.updateDefinition("refund-desk", { definition: { ...(await v2.getAgent("refund-desk")).agent.definition, description: "Decides refunds, quoting the policy line." } }, null);
    const revisions = (await v2.listRevisions("refund-desk")).revisions;
    expect(revisions[0]).toMatchObject({ current: true });
    expect((await v2.getAgent("refund-desk")).agent.definition.description).toBe("Decides refunds, quoting the policy line.");
  });

  it("puts a picked file in the inputs/ of the run it starts", async () => {
    const { v2 } = demo();
    const file = await demoUpload(new File(["# Notes\nCall the buyer first.\n"], "notes.md", { type: "text/markdown" }), () => {}, new AbortController().signal);
    const { run } = await v2.startRun("support-triage", { input: { content: "Ticket: my parcel is late" }, file_ids: [file.file_id] }, "k7");
    expect(run.file_ids).toEqual([file.file_id]);
    expect((await v2.listFiles(run.run_id)).files.map((f) => f.path)).toContain("inputs/notes.md");
    expect(await v2.readFile(run.run_id, "inputs/notes.md")).toBe("# Notes\nCall the buyer first.\n");
    await expect(v2.startRun("support-triage", { input: { content: "x" }, file_ids: ["file_demo_gone"] }, "k8")).rejects.toMatchObject({ status: 422 });
  });

  it("links each scan of the sample repository to a run that opens, working while the scan does", async () => {
    const { v2, now } = demo();
    const done = (await v2.listSuggestions()).repositories[0].scan;
    expect(await v2.getRun(done.run_id)).toMatchObject({ agent_id: done.agent_id, status: "completed" });
    const scan = await v2.scanRepository("larkspur/marketplace");
    expect(scan.run_id).not.toBe(done.run_id);
    expect((await v2.getRun(scan.run_id)).status).toBe("working");
    now.ms += 10_000;
    expect((await v2.getRun(scan.run_id)).status).toBe("completed");
    expect((await v2.listSuggestions()).repositories[0].scan).toMatchObject({ run_id: scan.run_id, status: "completed" });
  });

  it("cancels a paused workflow run where its graph stood, however long after its pause", async () => {
    const { v2, now } = demo();
    now.ms += 3_000;
    await v2.pauseRun("demo-run-certificates-live");
    const held = await v2.getRunGraph("demo-run-certificates-live");
    now.ms += 60 * 60_000;
    await v2.cancel("demo-run-certificates-live");
    const run = await v2.getRun("demo-run-certificates-live");
    expect(run).toMatchObject({ status: "cancelled", state: "idle" });
    expect(run.ended_at).toBe(new Date(now.ms).toISOString());
    const graph = await v2.getRunGraph("demo-run-certificates-live");
    expect(graph.run.status).toBe("cancelled");
    expect(graph.decisions).toEqual(held.decisions);
  });

  it("starts a trigger's run now with the input it saved, and says when a schedule fires next", async () => {
    const { v2 } = demo();
    const made = await v2.createTrigger({ name: "Nightly refunds", source: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: "refund-desk", input: { content: "Clear the refund queue" } } }, "k9");
    expect(made.next_at).toBe("2026-11-19T02:00:00.000Z");
    const fired = await v2.fireTrigger(made.id, "k10");
    expect((await v2.getRun(fired.run_id!)).input).toEqual({ content: "Clear the refund queue" });
    // 09:30 in New York is 14:30Z, already gone on Wednesday the 18th at 15:00Z: next on Thursday.
    const moved = await v2.updateTrigger(made.id, { source: { kind: "schedule", cron: "30 9 * * 1-5", timezone: "America/New_York" } });
    expect(moved.next_at).toBe("2026-11-19T14:30:00.000Z");
    expect((await v2.updateTrigger(made.id, { enabled: false })).next_at).toBeNull();
  });

  it("puts two picked files of one name at free names, and never over the run's message", async () => {
    const { v2 } = demo();
    const pick = (text: string, name: string) => demoUpload(new File([text], name, { type: "text/markdown" }), () => {}, new AbortController().signal);
    const ids = [(await pick("first", "notes.md")).file_id, (await pick("second", "notes.md")).file_id, (await pick("mine", "message.md")).file_id];
    const { run } = await v2.startRun("support-triage", { input: { content: "Ticket: my parcel is late" }, file_ids: ids }, "k13");
    expect(await v2.readFile(run.run_id, "inputs/notes.md")).toBe("first");
    expect(await v2.readFile(run.run_id, "inputs/notes-2.md")).toBe("second");
    expect(await v2.readFile(run.run_id, "inputs/message-2.md")).toBe("mine");
    expect(await v2.readFile(run.run_id, "inputs/message.md")).toBe("Ticket: my parcel is late");
  });

  it("says a scan whose run was cancelled was cancelled, not completed", async () => {
    const { v2, now } = demo();
    const scan = await v2.scanRepository("larkspur/marketplace");
    await v2.cancel(scan.run_id);
    now.ms += 10_000;
    expect((await v2.listSuggestions()).repositories[0].scan).toMatchObject({ run_id: scan.run_id, status: "cancelled", found: 0 });
  });

  it("starts each demo from the story as told: a change in one world is not the next one's", async () => {
    const { v2 } = demo();
    await v2.disconnectNative(AGENTS.find((a) => a.native)!.id);
    const fresh = demo().v2;
    expect((await fresh.getAgent(AGENTS.find((a) => a.native)!.id)).agent.native_status).toMatchObject({ connected: true });
  });

  it("applies a template with the install form's choices: a model choice and its harness, and approvals", async () => {
    const { v2 } = demo();
    const chose = await v2.applyTemplate("kyb", { overrides: { choice: "codex", approvals: "never" } }, "k11");
    expect((await v2.getAgent(chose.agent_id)).agent.definition).toMatchObject({ model: "openai/gpt-6.1-sol", harness: "codex", approvals: "never" });
    const own = await v2.applyTemplate("kyb", { overrides: { model: "openai/gpt-6-luna" } }, "k12");
    expect((await v2.getAgent(own.agent_id)).agent.definition).toMatchObject({ model: "openai/gpt-6-luna" });
  });
});
