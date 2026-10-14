import { runWorkflow, type WorkflowDeps } from "@parcha/agentrun-dsl";
import { demoInput, demoWorkflow, scriptedDemoDeps } from "./demo.js";

/** The bundled scripted workflow, run through the interpreter with fixed answers: no model, no key, no network. */
export async function runScriptedDemo(noEvidence: boolean, print: (line: string) => void): Promise<number> {
  const scripted = scriptedDemoDeps(noEvidence);
  const calls = { effects: 0, judgments: 0, agentSteps: 0 };
  const deps: WorkflowDeps = {
    runEffect: input => { calls.effects++; return scripted.runEffect!(input); },
    runJudge: input => { calls.judgments++; return scripted.runJudge!(input); },
    runNode: input => { calls.agentSteps++; return scripted.runNode!(input); },
  };
  print("AgentRun on Pi · scripted demo, fictional sources, no model calls\n");
  print(`Question: ${demoInput.question}\n`);
  const result = await runWorkflow(demoWorkflow, demoInput, deps);
  const state = result.state as { findings?: { question: string; answer: string }[]; report?: { answer: string } };
  for (const finding of state.findings ?? []) print(`  ${finding.question}\n    ${finding.answer}`);
  print(`\nStatus: ${result.status}`);
  if (result.status === "complete") print(`Answer: ${state.report?.answer ?? ""}`);
  else print(`Escalation: ${result.escalation?.summary ?? ""}`);
  print(`Calls: ${calls.effects} tool, ${calls.judgments} judgment, ${calls.agentSteps} agent step (all scripted)`);
  return result.status === "escalated" && !noEvidence ? 2 : 0;
}
