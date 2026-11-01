import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { AgentEditor } from "@/components/AgentEditor";
import { RunDetail } from "@/components/RunDetail";
import { RunGraphView } from "@/components/RunGraphView";
import { Shell } from "@/components/Shell";
import { editorCaps, messageFeatures } from "@/fixtures";
import { BATCH_DURATION, BATCH_MID, batchDoneRun, batchMidRun, batchPausedRun, batchRunAt, fixtureFileUrl, juryRun, kybRun } from "@/fixtures/dwf/runs";
import { batchWorkflow, kybWorkflow } from "@/fixtures/dwf/workflows";
import type { Agent } from "@/lib/agentForm";
import type { RunGraph, Selection } from "@/lib/runGraph";
import type { Run } from "@/lib/v2";

// The decision-workflow views over the C4 fixtures (src/fixtures/dwf): synthetic runs, invented companies.
const meta: Meta = { title: "Workflow" };
export default meta;
type Story = StoryObj;

const runOf = (g: RunGraph, title: string): Run => ({
  run_id: g.run.id, agent_id: g.run.agent, agent_version: Number(g.run.revision.replace(/\D/g, "")) || 1, revision: g.run.revision, kind: "workflow",
  status: g.run.status === "working" ? "working" : g.run.status === "completed" ? "completed" : "failed", state: g.run.status === "working" ? "working" : "idle",
  title, created_at: g.run.startedAt, ended_at: g.run.endedAt, result: null, error: null,
  cost: { usd: g.totals.cost_usd, basis: "provider", charge_state: null, cap_usd: null }, archived_at: null,
});

const page = (g: RunGraph, title: string, agent: string, initial: Selection = null) => (
  <Shell active="runs">
    <RunDetail run={runOf(g, title)} agentName={agent} messages={messageFeatures} harnessSteers={false} rows={[]} files={[]}
      graphView={<RunGraphView data={g} fileUrl={fixtureFileUrl} initial={initial} actions={{ onPause: () => {}, onResume: () => {} }} />} />
  </Shell>
);

const MAP = "/root/steps/0";

export const BatchMidFlight: Story = { render: () => page(batchMidRun(), "20 certificates, March intake", "CoI batch review") };
export const BatchItemAltered: Story = { render: () => page(batchMidRun(), "20 certificates, March intake", "CoI batch review", { path: MAP, item: 5 }) };
export const BatchItemNeedsReview: Story = { render: () => page(batchMidRun(), "20 certificates, March intake", "CoI batch review", { path: MAP, item: 9 }) };
export const BatchItems: Story = { render: () => page(batchMidRun(), "20 certificates, March intake", "CoI batch review", { path: MAP }) };
export const BatchJudgeAcrossItems: Story = { render: () => page(batchMidRun(), "20 certificates, March intake", "CoI batch review", { path: `${MAP}/body/steps/1` }) };
export const BatchPaused: Story = { render: () => page(batchPausedRun(), "20 certificates, March intake", "CoI batch review") };
export const BatchDone: Story = { render: () => page(batchDoneRun(), "20 certificates, March intake", "CoI batch review", { path: MAP }) };
export const KybRegistry: Story = { render: () => page(kybRun(), "Corvane Analytics Inc., onboarding", "KYB onboarding", { path: "/root/steps/1/branches/0" }) };
export const KybRoute: Story = { render: () => page(kybRun(), "Corvane Analytics Inc., onboarding", "KYB onboarding", { path: "/root/steps/3" }) };
export const KybCertificate: Story = { render: () => page(kybRun(), "Corvane Analytics Inc., onboarding", "KYB onboarding", { path: "/root/steps/1/branches/1" }) };
export const JuryDisagrees: Story = { render: () => page(juryRun(), "Saltmarsh Outdoor Gear Co., prohibited goods", "Prohibited-goods jury", { path: "/root/steps/1/branches/1" }) };
export const JuryCompared: Story = { render: () => page(juryRun(), "Saltmarsh Outdoor Gear Co., prohibited goods", "Prohibited-goods jury", { path: "/root/steps/1" }) };
export const JuryGraph: Story = { render: () => page(juryRun(), "Saltmarsh Outdoor Gear Co., prohibited goods", "Prohibited-goods jury") };

/** The batch running on a clock, 1 s a tick as the console polls, paused and resumed by its buttons. */
function LiveBatch() {
  const [t, setT] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setT((x) => (x >= BATCH_DURATION + 4000 ? 0 : x + 1000)), 1000);
    return () => clearInterval(id);
  }, [paused]);
  const g = batchRunAt(Math.min(t, BATCH_DURATION + 1), { paused });
  return (
    <Shell active="runs">
      <RunDetail run={runOf(g, "20 certificates, March intake")} agentName="CoI batch review" messages={messageFeatures} harnessSteers={false} rows={[]} files={[]}
        graphView={<RunGraphView data={g} fileUrl={fixtureFileUrl} actions={{ onPause: () => setPaused(true), onResume: () => setPaused(false) }} />} />
    </Shell>
  );
}
export const BatchLive: Story = { render: () => <LiveBatch /> };
export const BatchStart: Story = { render: () => page(batchRunAt(1800), "20 certificates, March intake", "CoI batch review") };
export const BatchNearEnd: Story = { render: () => page(batchRunAt(BATCH_MID + 6000), "20 certificates, March intake", "CoI batch review") };

// ---- the agent page's Workflow step --------------------------------------------------------------------------------

/** The KYB workflow as its revision 6 had it: no cross-check, a route that trusted a weaker answer. */
const kybRev6 = (() => {
  const w = structuredClone(kybWorkflow) as typeof kybWorkflow;
  w.root.steps.splice(2, 1);
  (w.root.steps[2] as { unsure: { gte: number } }).unsure.gte = 0.6;
  return w;
})();
const workflowAgent = (name: string, workflow: unknown, revision = 6): Agent => ({
  agent_id: `agt_${name.toLowerCase().replace(/\W+/g, "_")}`, kind: "workflow", revision: `rev_${revision}`, revisions: revision, archived_at: null,
  definition: { version: revision, name, description: "Registry, certificate and cross-check, then a judged route.", workflow, skills: [], tools: ["pdf_pages"] },
});
const revisions = (n: number) => Array.from({ length: n }, (_, k) => ({ revision: `rev_${n - k}`, version: n - k, current: k === 0, note: k === 0 ? "Route threshold 0.6" : null, created_at: new Date(Date.UTC(2026, 9, 30 - k, 14)).toISOString() }));
const editor = (agent: Agent, draft?: string) => (
  <Shell active="agents">
    <AgentEditor agent={agent} revisions={revisions(agent.revisions)} caps={editorCaps} draft={draft} onSave={async () => null} />
  </Shell>
);

export const EditorKybDiff: Story = { render: () => editor(workflowAgent("KYB onboarding", kybRev6), JSON.stringify(kybWorkflow, null, 2)) };
export const EditorBatch: Story = { render: () => editor(workflowAgent("CoI batch review", batchWorkflow, 3)) };
export const EditorProblems: Story = {
  render: () => {
    const broken = structuredClone(kybWorkflow) as unknown as { root: { steps: Record<string, unknown>[] } };
    broken.root.steps[1].branches = [{ node: "judge", label: "registry-lookup", provider: "openrouter", state: { company: "{company}" }, out: "Registry", as: "registry" }, { node: "judge", label: "certificate-look", provider: "jev", state: { text: "{cert.text}" }, images: { "<cert>": "{cert.pages.0.image}" }, out: "CertLook", as: "look" }];
    return editor(workflowAgent("KYB onboarding", kybWorkflow, 7), JSON.stringify(broken, null, 2));
  },
};
export const EditorBrokenJson: Story = { render: () => editor(workflowAgent("KYB onboarding", kybWorkflow, 7), JSON.stringify(kybWorkflow, null, 2).replace('"label": "cross-check",', '"label": "cross-check"')) };
