import type { MessageFeatures } from "@/lib/runState";
// Typed access to the recorded responses in this folder (see README.md). Recorded by the dev kit; never hand-edited.
import type { Recorded, Run, RunFile, RunFiles, TimelinePage } from "@/lib/v2";

const files = import.meta.glob<Recorded<unknown>>("./*.json", { eager: true, import: "default" });

export function recorded<T>(name: string): Recorded<T> {
  const hit = files[`./${name}.json`];
  if (!hit) throw new Error(`no recorded fixture ${name}`);
  return hit as Recorded<T>;
}

export type RunFixture = { run: Run; page: TimelinePage; files: RunFile[]; agentName: string };

const agents = (recorded<{ agents: { agent_id: string; definition: { name?: string } }[] }>("agents.list").body.agents);
export const agentName = (id: string) => agents.find((a) => a.agent_id === id)?.definition.name ?? id;

/** A recorded run with its timeline and files, by its fixture name (`run.completed.idle.1`, `run.with-files`, ...). */
export function runFixture(name: string): RunFixture {
  const run = recorded<Run>(name).body;
  return { run, page: recorded<TimelinePage>(`${name}.timeline`).body, files: recorded<RunFiles>(`${name}.files`).body.files, agentName: agentName(run.agent_id) };
}

/** The bytes of the one recorded file (`run.with-files.file`), as text. */
export const recordedFileText = () => recorded<string>("run.with-files.file").body;

/** Every recorded run fixture's name (without `.timeline`/`.files`/`.file`). */
export const runNames = Object.keys(files)
  .map((k) => k.slice(2, -5))
  .filter((n) => /^run\.[a-z_]+\.[a-z]+\.\d+$/.test(n) || n === "run.with-files");

/** The first recorded run whose error has this code (failed runs: run_failed, spend_cap_reached, escalated). */
export function failedWith(code: string, message?: RegExp): RunFixture {
  const name = runNames.find((n) => {
    const e = recorded<Run>(n).body.error;
    return e?.code === code && (!message || message.test(e.message));
  });
  if (!name) throw new Error(`no recorded failed run with ${code}`);
  return runFixture(name);
}

/** The recorded server's `features.messages`. */
export const messageFeatures = recorded<{ features: { messages: MessageFeatures } }>("capabilities").body.features.messages;

import { type Agent, toolOffers } from "@/lib/agentForm";
import type { EditorCaps, Revision } from "@/components/AgentEditor";

/** The recorded agents (`agents.list`, and archived), each agent's revisions, and the server's editor capabilities. */
export const agentsList = () => recorded<{ agents: Agent[] }>("agents.list").body.agents;
export const archivedAgents = () => recorded<{ agents: Agent[] }>("agents.list.archived").body.agents;
export const agentFixture = (slug: string) => recorded<Agent>(`agent.${slug}`).body;
export const revisionsOf = (slug: string) => recorded<{ revisions: Revision[] }>(`agent.${slug}.revisions`).body.revisions;
const capsBody = recorded<{ harnesses: EditorCaps["harnesses"]; tools: unknown; features: { thinking: string[] }; models: { default?: string } }>("capabilities").body;
export const editorCaps: EditorCaps = { harnesses: capsBody.harnesses, tools: toolOffers(capsBody.tools), thinking: capsBody.features.thinking, defaultModel: capsBody.models.default };
