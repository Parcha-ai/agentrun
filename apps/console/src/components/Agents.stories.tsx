import type { Meta, StoryObj } from "@storybook/react";
import { AgentEditor } from "@/components/AgentEditor";
import { AgentPage } from "@/components/AgentPage";
import { AgentsList } from "@/components/AgentsList";
import { Shell } from "@/components/Shell";
import { agentFixture, agentsList, archivedAgents, editorCaps, recorded, revisionsOf, runFixture, runNames } from "@/fixtures";
import { saveError } from "@/lib/agentForm";
import { ANALYTICS, statsWith } from "@/components/AgentAnalytics.sample";
import { ClientError } from "@/lib/client";

// The agents surface on agents and refusals AgentRun Server returned (src/fixtures), in the shell.
const meta: Meta = { title: "Agents" };
export default meta;
type Story = StoryObj;
const noop = () => {};
const asProblem = (name: string) => {
  const r = recorded<{ error: { code: string; message: string; fields?: { field: string; reason: string; message: string }[] } }>(name);
  return saveError(Object.assign(new ClientError(r.status, r.body.error.code, r.body.error.message), { fields: r.body.error.fields }));
};
const page = (node: React.ReactNode) => <Shell active="agents">{node}</Shell>;
const editor = (slug: string, extra: Partial<React.ComponentProps<typeof AgentEditor>> = {}) =>
  page(<AgentEditor agent={agentFixture(slug)} revisions={revisionsOf(slug)} caps={editorCaps} onSave={async () => null} onMakeCurrent={noop} onArchive={noop} onReload={noop} onBack={noop} {...extra} />);

// A recorded run by its id: every recorded agent's latest run is one, so its page's latest-run panel follows the run's
// recorded timeline and reads its recorded record.
const recordedRun = (id: string) => runNames.map(runFixture).find((f) => f.run.run_id === id)!;

// An agent's page over its recorded agent and runs, with the server's efforts, and stats carrying the sample analytics.
const agentPage = (slug: string, { runs = true, tab }: { runs?: boolean; tab?: "workflow" | "analytics" } = {}) => {
  const v2 = {
    getAgent: async () => ({ agent: agentFixture(slug), etag: null }),
    listAgentRuns: async () => (runs ? recorded<unknown>(`agent.${slug}.runs`).body : { runs: [], next_cursor: null }),
    statsOver: async () => statsWith(ANALYTICS),
    getTimeline: async (id: string) => recordedRun(id).page,
    getRun: async (id: string) => recordedRun(id).run,
  };
  const efforts = recorded<{ features: { efforts: string[] } }>("capabilities").body.features.efforts;
  return page(<AgentPage v2={v2 as never} agentId={slug} defaultModel={editorCaps.defaultModel} efforts={efforts} go={noop} tab={tab} />);
};

export const List: Story = { render: () => page(<AgentsList agents={agentsList()} actions={{ onOpen: noop, onEdit: noop, onNew: noop, onRuns: noop, onArchive: noop }} />) };
export const ListArchived: Story = { render: () => page(<AgentsList agents={archivedAgents()} archived actions={{ onOpen: noop, onEdit: noop, onArchive: noop }} />) };
export const ListEmpty: Story = { render: () => page(<AgentsList agents={[]} actions={{ onNew: noop }} />) };
export const ListLoading: Story = { render: () => page(<AgentsList agents={null} />) };
export const ListError: Story = { render: () => page(<AgentsList agents={null} error={`${recorded<{ error: { code: string; message: string } }>("error.unauthenticated").body.error.code}: ${recorded<{ error: { message: string } }>("error.unauthenticated").body.error.message}`} />) };
export const AgentRuns: Story = { render: () => agentPage("invoice-checker") };
export const AgentNoRuns: Story = { render: () => agentPage("invoice-checker", { runs: false }) };
export const AgentWorkflowGraph: Story = { render: () => agentPage("support-triage", { tab: "workflow" }) };
export const AgentAnalytics: Story = { render: () => agentPage("invoice-checker", { tab: "analytics" }) };
export const NewAgent: Story = { render: () => page(<AgentEditor agent={null} caps={editorCaps} onSave={async () => null} onBack={noop} />) };
export const EditContext: Story = { render: () => editor("invoice-checker") };
export const EditTools: Story = { render: () => editor("invoice-checker", { step: "tools" }) };
export const EditHarness: Story = { render: () => editor("invoice-checker", { step: "settings" }) };
export const EditHistory: Story = { render: () => editor("invoice-checker", { step: "history" }) };
export const EditConflict: Story = { render: () => editor("invoice-checker", { problem: asProblem("write.definition-put-stale") }) };
export const EditInvalidHarness: Story = { render: () => editor("invoice-checker", { step: "settings", problem: asProblem("write.definition-invalid-harness") }) };
export const EditWorkflow: Story = { render: () => editor("support-triage") };
// A save the server took that this host can't run yet: what its answer's warnings said, above the form and at the field.
export const SavedWithWarnings: Story = { render: () => page(<AgentEditor agent={{ ...agentFixture("invoice-checker"), warnings: [{ field: "definition.model", reason: "not_set_up_here", message: "No OpenAI key here for openai/gpt-5: add one in Settings → Model keys, or set OPENAI_API_KEY where AgentRun starts." }] }} revisions={revisionsOf("invoice-checker")} caps={editorCaps} step="settings" onSave={async () => null} onBack={noop} />) };
export const Phone: Story = { render: () => editor("invoice-checker", { step: "settings" }), globals: { viewport: { value: "mobile1" } } };
