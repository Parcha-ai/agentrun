import type { Meta, StoryObj } from "@storybook/react";
import { AgentEditor } from "@/components/AgentEditor";
import { AgentsList } from "@/components/AgentsList";
import { Shell } from "@/components/Shell";
import { agentFixture, agentsList, archivedAgents, editorCaps, recorded, revisionsOf } from "@/fixtures";
import { saveError } from "@/lib/agentForm";
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

export const List: Story = { render: () => page(<AgentsList agents={agentsList()} actions={{ onOpen: noop, onNew: noop, onRuns: noop, onArchive: noop }} />) };
export const ListArchived: Story = { render: () => page(<AgentsList agents={archivedAgents()} archived actions={{ onOpen: noop, onArchive: noop }} />) };
export const ListEmpty: Story = { render: () => page(<AgentsList agents={[]} actions={{ onNew: noop }} />) };
export const ListLoading: Story = { render: () => page(<AgentsList agents={null} />) };
export const ListError: Story = { render: () => page(<AgentsList agents={null} error={`${recorded<{ error: { code: string; message: string } }>("error.unauthenticated").body.error.code}: ${recorded<{ error: { message: string } }>("error.unauthenticated").body.error.message}`} />) };
export const NewAgent: Story = { render: () => page(<AgentEditor agent={null} caps={editorCaps} onSave={async () => null} onBack={noop} />) };
export const EditContext: Story = { render: () => editor("invoice-checker") };
export const EditTools: Story = { render: () => editor("invoice-checker", { step: "tools" }) };
export const EditHarness: Story = { render: () => editor("invoice-checker", { step: "settings" }) };
export const EditHistory: Story = { render: () => editor("invoice-checker", { step: "history" }) };
export const EditConflict: Story = { render: () => editor("invoice-checker", { problem: asProblem("write.definition-put-stale") }) };
export const EditInvalidHarness: Story = { render: () => editor("invoice-checker", { step: "settings", problem: asProblem("write.definition-invalid-harness") }) };
export const EditWorkflow: Story = { render: () => editor("support-triage") };
export const Phone: Story = { render: () => editor("invoice-checker", { step: "settings" }), globals: { viewport: { value: "mobile1" } } };
