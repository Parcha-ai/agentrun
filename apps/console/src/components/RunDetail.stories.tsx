import type { Meta, StoryObj } from "@storybook/react";
import { RunDetail } from "@/components/RunDetail";
import { Shell } from "@/components/Shell";
import { failedWith, recorded, recordedFileText, runFixture, messageFeatures } from "@/fixtures";
import type { Run, RunFile } from "@/lib/v2";

// Every story renders a run AgentRun Server returned (src/fixtures), in the shell, as the console shows it.
const meta: Meta<typeof RunDetail> = { title: "Run detail", component: RunDetail };
export default meta;
type Story = StoryObj<typeof RunDetail>;

const noop = () => {};
const story = (name: string, extra: Partial<React.ComponentProps<typeof RunDetail>> = {}): Story => ({
  render: () => {
    const [code, message] = name.startsWith("failed:") ? name.slice(7).split("|") : [];
    const f = code ? failedWith(code, message ? new RegExp(message) : undefined) : runFixture(name);
    return (
      <Shell active="runs">
        <RunDetail run={f.run} agentName={f.agentName} messages={messageFeatures} rows={f.page.rows} files={f.files} actions={{ onStop: noop, onCancel: noop }} onMessage={noop}
          readFile={async () => recordedFileText()} {...extra} />
      </Shell>
    );
  },
});

const agenticWorking = ["run.working.working.1", "run.working.working.2"].find((n) => recorded<Run>(n).body.kind === "agentic")!;
const workflowWorking = ["run.working.working.1", "run.working.working.2"].find((n) => recorded<Run>(n).body.kind === "workflow")!;

export const Completed: Story = story("run.with-files");
export const CompletedWorkflow: Story = story("run.completed.idle.1");
export const Working: Story = story(agenticWorking);
export const WorkingWorkflow: Story = story(workflowWorking);
export const WorkingAfterRestart: Story = story("run.working.idle.1");
export const Queued: Story = story("run.queued.working.1");
export const InputRequired: Story = story("run.input_required.waiting.1");
export const Stopped: Story = story("run.input_required.idle.1");
export const Cancelled: Story = story("run.cancelled.idle.1");
export const FailedProvider: Story = story("failed:run_failed|503");
export const FailedSpendCap: Story = story("failed:spend_cap_reached");
export const FailedEscalated: Story = story("failed:escalated");
export const Files: Story = story("run.with-files", { tab: "files" });
export const ArtifactOpen: Story = {
  render: () => {
    const f = runFixture("run.with-files");
    return (
      <Shell active="runs">
        <RunDetail run={f.run} agentName={f.agentName} messages={messageFeatures} rows={f.page.rows} files={f.files} tab="files" openFile={f.files[0] as RunFile} readFile={async () => recordedFileText()} />
      </Shell>
    );
  },
};
export const Phone: Story = { ...story("run.input_required.waiting.1"), parameters: { viewport: { defaultViewport: "mobile1" } }, globals: { viewport: { value: "mobile1" } } };
