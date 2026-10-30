import type { Meta, StoryObj } from "@storybook/react";
import { Playground, type StartResult } from "@/components/Playground";
import { Shell } from "@/components/Shell";
import { agentsList, recorded, revisionsOf } from "@/fixtures";

// Starting runs, on agents and answers AgentRun Server returned (src/fixtures).
const meta: Meta = { title: "Start a run" };
export default meta;
type Story = StoryObj;
const efforts = recorded<{ features: { efforts: string[] } }>("capabilities").body.features.efforts;
const answer = (name: string, ms: number): StartResult => {
  const r = recorded<{ run_id?: string }>(name);
  return { status: r.status, ms, body: r.body, runId: r.status < 300 ? r.body.run_id : undefined };
};
const playground = (agentId: string, result: StartResult | null = null) => (
  <Shell active="playground">
    <Playground agents={agentsList()} revisions={revisionsOf(agentId)} efforts={efforts} origin="http://127.0.0.1:7340" agentId={agentId} result={result} onSend={async () => answer("start.run", 41)} onOpenRun={() => {}} />
  </Shell>
);

export const PlaygroundAgentic: Story = { render: () => playground("meeting-notes") };
export const PlaygroundWorkflow: Story = { render: () => playground("support-triage") };
export const PlaygroundStarted: Story = { render: () => playground("meeting-notes", answer("start.run", 41)) };
export const PlaygroundReplayed: Story = { render: () => playground("meeting-notes", answer("start.run-replay", 12)) };
export const PlaygroundKeyReused: Story = { render: () => playground("meeting-notes", answer("start.run-key-reused", 9)) };
export const PlaygroundWorkflowRefused: Story = { render: () => playground("support-triage", answer("start.workflow-run-bad-input", 14)) };
export const PlaygroundPhone: Story = { render: () => playground("meeting-notes"), globals: { viewport: { value: "mobile1" } } };
