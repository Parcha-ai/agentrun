// Calls the client's types refuse: tsc must fail on each line marked `// error`, and on no other.
import { AgentRun } from "@parcha/agentrun-client";
import { BackendLearningClient } from "@parcha/agentrun-client/learning";

export async function invalidExternalSource(): Promise<void> {
  const client = new BackendLearningClient({ agentId: "platform" });
  await client.begin({ runtime: "external", input: "x", instructions: "y" }); // error
  await client.begin({ runtime: "codex-sdk", platform: "Capy", input: "x", instructions: "y" }); // error
}

export async function consumer(): Promise<void> {
  const client = new AgentRun();
  await client.agents.create({ definitio: { version: 1, name: "a", instructions: "a", skills: [], tools: [] } }); // error
  await client.runs.start("notes", { input: {}, max_cost_usd: "1" }); // error
  await client.runs.message("r1", {}); // error
  await client.runs.get("r1", { limit: 1 }); // error
  const text: string = await client.runs.readFile("r1", "a.md"); // error
  await client.runs.nope("r1"); // error
  void text;
}

import * as workflowEngine from "@parcha/agentrun-dsl";
import { createWorkflowMcpBridge } from "@parcha/agentrun-client/workflows";
export async function wrongWorkflowHost(): Promise<void> {
  await createWorkflowMcpBridge({ tools: [], policy: () => "allow" }); // error
  await createWorkflowMcpBridge({ engine: { inspectWorkflow: workflowEngine.inspectWorkflow, runWorkflow: workflowEngine.runWorkflow }, tools: [], policy: () => "allow" }); // error
}
