import type { Meta, StoryObj } from "@storybook/react";
import { Composer } from "@/components/Composer";
import { NeedsYou } from "@/components/NeedsYou";
import { RunError } from "@/components/RunError";
import { RunHeader } from "@/components/RunHeader";
import { RunsList } from "@/components/RunsList";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { failedWith, recorded, runFixture, runNames } from "@/fixtures";
import type { ApiError, Run } from "@/lib/v2";

const meta: Meta = { title: "Parts" };
export default meta;
type Story = StoryObj;
const noop = () => {};
const pad = (node: React.ReactNode) => <div className="max-w-4xl space-y-6 p-8">{node}</div>;

/** One badge per status and state the server returned in the recordings. */
export const StatusBadges: Story = {
  render: () => {
    const seen = new Map<string, Run>();
    for (const n of runNames) { const r = recorded<Run>(n).body; seen.set(`${r.status}/${r.state}/${r.kind}`, r); }
    return pad(<ul className="space-y-3">{[...seen].map(([k, r]) => <li key={k} className="flex items-center gap-4"><StatusBadge run={r} /><span className="font-mono text-[12px] text-muted-foreground">{k}</span></li>)}</ul>);
  },
};
export const ShellNav: Story = { render: () => <Shell active="agents"><div className="p-8 text-muted-foreground">Page</div></Shell> };
export const TimelineWorking: Story = { render: () => { const f = runFixture("run.working.working.1"); return pad(<Timeline rows={f.page.rows} live />); } };
export const TimelineCompleted: Story = { render: () => { const f = runFixture("run.with-files"); return pad(<Timeline rows={f.page.rows} live={false} />); } };
export const TimelineInputRequired: Story = { render: () => { const f = runFixture("run.input_required.waiting.1"); return pad(<Timeline rows={f.page.rows} live={false} />); } };
export const TimelineEmpty: Story = { render: () => pad(<Timeline rows={[]} live />) };
export const HeaderWorking: Story = { render: () => { const f = runFixture("run.working.working.1"); return <RunHeader run={f.run} agentName={f.agentName} actions={{ onStop: noop, onCancel: noop }} />; } };
export const HeaderArchived: Story = { render: () => { const f = runFixture("run.completed.idle.1"); return <RunHeader run={{ ...f.run, archived_at: "2026-11-01T07:00:00Z" }} agentName={f.agentName} actions={{ onArchive: noop }} />; } };
export const RunsFiltered: Story = { render: () => <Shell active="runs"><RunsList runs={recorded<{ runs: Run[] }>("runs.list").body.runs.filter((r) => r.status === "completed")} agentName={(id) => id} onOpen={noop} filter={{ status: "completed" }} onFilter={noop} /></Shell> };
export const RunsArchivedEmpty: Story = { render: () => <Shell active="runs"><RunsList runs={[]} agentName={(id) => id} onOpen={noop} filter={{ archived: true }} onFilter={noop} /></Shell> };
export const HeaderStopping: Story = { render: () => { const f = runFixture("run.working.working.1"); return <RunHeader run={f.run} agentName={f.agentName} actions={{ onStop: noop, onCancel: noop, busy: "stop" }} />; } };
export const InputRequiredQuestion: Story = { render: () => { const f = runFixture("run.input_required.waiting.1"); return pad(<NeedsYou waiting={f.page.rows.findLast((r) => r.kind === "waiting") ?? null} />); } };
export const StoppedNote: Story = { render: () => pad(<NeedsYou waiting={null} />) };
export const ComposerModes: Story = { render: () => pad(<><Composer mode="answer" onSend={noop} /><Composer mode="follow_up" onSend={noop} /><Composer mode="steer" onSend={noop} /><Composer mode="follow_up" onSend={noop} sent /></>) };
export const Errors: Story = {
  render: () => pad(<>
    <RunError error={failedWith("run_failed", /503/).run.error!} />
    <RunError error={failedWith("run_failed", /cut off/).run.error!} />
    <RunError error={failedWith("spend_cap_reached").run.error!} />
    <RunError error={failedWith("escalated").run.error!} />
    <RunError title="The server refused the request" error={recorded<{ error: ApiError }>("error.definition-stale-etag").body.error} />
    <RunError title="The server refused the request" error={recorded<{ error: ApiError }>("error.run-not-found").body.error} />
  </>),
};
