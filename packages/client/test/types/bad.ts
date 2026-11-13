// Calls the client's types refuse: tsc must fail on each line marked `// error`, and on no other.
import { AgentRun } from "@parcha/agentrun-client";

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
