// A consumer of the client as its README shows it: this file must typecheck.
import { AgentRun, AgentRunRefused, AgentRunTimeout, type ImportRemoteTargetBody, type Run, type TimelinePage } from "@parcha/agentrun-client";
import { BackendLearningClient, type BackendLearningStart, type ExternalLearningStart } from "@parcha/agentrun-client/learning";

interface JobStart extends BackendLearningStart { jobId: string }
export async function backendSource(): Promise<void> {
  const sdk = new BackendLearningClient({ agentId: "sdk" });
  const job: JobStart = { runtime: "codex-sdk", input: "Report status", instructions: "Be accurate", jobId: "job-1" };
  await sdk.begin(job);
  const external = new BackendLearningClient({ agentId: "platform" });
  const task: ExternalLearningStart = { runtime: "external", platform: "Capy", input: "Report status", instructions: "Be accurate" };
  await external.begin(task);
}

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
  const corrections: string = (await client.learning.writeCorrections("notes", { text: "- Look in policies/ first.\n" }, { "If-Match": "\"etag-1\"" })).body.text;
  type NativeImport = Extract<ImportRemoteTargetBody, { target: { connected: boolean } }>;
  const nativeTarget = {} as NativeImport["target"];
  const nativeBody: NativeImport = { target_id: "target", target: nativeTarget };
  const nativeConnected: boolean = (await client.connectors.importRemoteTarget("connector", nativeBody)).native.connected;
  await client.files.upload("f1", new Uint8Array([1, 2]), { contentType: "image/png" });
  // What the server serves, in the types with no cast: a workflow agent's definition with no instructions, version or
  // skills; a create's warnings; the archived agents' list; the usage report's unpriced runs.
  const flow = await client.agents.create({ definition: { id: "review", name: "Review", workflow: { start: "check" } } });
  const warned: string[] = (flow.warnings ?? []).map((warning) => `${warning.field}: ${warning.reason}`);
  const instructions: string | undefined = (await client.agents.get("review")).body.definition.instructions;
  const archived: string[] = (await client.agents.list({ archived: true })).agents.map((listed) => listed.agent_id);
  const unpriced: number | undefined = (await client.usage()).unpriced_runs;
  void [warned, instructions, archived, unpriced];
  try {
    await client.agents.get("notes");
  } catch (error) {
    if (error instanceof AgentRunRefused) void [error.status, error.code, error.error?.message];
    if (error instanceof AgentRunTimeout) void error.run?.status;
  }
  void [first, bytes, response, corrections, nativeConnected];
}

// The backend explicitly supplies its interpreter; host adapter request types are inferred without casts.
import * as workflowEngine from "@parcha/agentrun-dsl";
import { createWorkflowMcpBridge } from "@parcha/agentrun-client/workflows";
export async function workflowHost(): Promise<void> {
  const bridge = await createWorkflowMcpBridge({
    engine: workflowEngine, tools: [], policy: () => "allow",
    runNode: async request => {
      const kind: "agent" | "decide" | "extract" | "report" = request.kind;
      const system: string[] = request.system;
      void [kind, system, request.signal];
      return {};
    },
    runJudge: async request => {
      const kind: "judge" | "pick" | "sift" | "route" | "ask" = request.kind;
      void [kind, request.questions, request.signal];
      return { answers: {} };
    },
  });
  await bridge.close();
}
