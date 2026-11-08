// A consumer of the client as its README shows it: this file must typecheck.
import { AgentRun, AgentRunRefused, AgentRunTimeout, type Run, type TimelinePage } from "@parcha/agentrun-client";

export async function consumer(): Promise<void> {
  const client = new AgentRun({ baseUrl: "https://agentrun.example.com/v2", apiKey: "key" });
  const agent = await client.agents.create({ definition: { id: "notes", version: 1, name: "Notes", instructions: "Write notes.", skills: [], tools: ["write"] } });
  const id: string = agent.agent_id;
  const started = await client.runs.start(id, { input: { content: "Write notes.md." }, max_cost_usd: 0.5 }, { "Idempotency-Key": "start-1" });
  const run: Run = await client.runs.wait(started.run_id, { timeoutMs: 60_000, signal: AbortSignal.timeout(120_000) });
  if (run.status === "input_required" && run.pending?.kind === "question") await client.runs.message(run.run_id, { content: "Europe" });
  if (run.pending?.kind === "budget") await client.runs.raiseCap(run.run_id, { max_cost_usd: 1 });
  const listed = await client.runs.list({ limit: 10 });
  const first: string | undefined = listed.runs[0]?.run_id;
  for await (const page of client.runs.follow(run.run_id)) {
    const timeline: TimelinePage = page;
    void timeline.rows.length;
  }
  const bytes: Uint8Array = await client.runs.readFile(run.run_id, "notes.md");
  const response: Response = await client.runs.readFile(run.run_id, "notes.md", undefined, { stream: true });
  const note: string = (await client.learning.write("notes", "policies.md", "# Policies\n", { "If-None-Match": "*" })).body;
  await client.files.upload("f1", new Uint8Array([1, 2]), { contentType: "image/png" });
  try {
    await client.agents.get("notes");
  } catch (error) {
    if (error instanceof AgentRunRefused) void [error.status, error.code, error.error?.message];
    if (error instanceof AgentRunTimeout) void error.run?.status;
  }
  void [first, bytes, response, note];
}
