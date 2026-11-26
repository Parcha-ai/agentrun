import { ArrowRight, Play } from "lucide-react";
import { useState } from "react";
import { SettingsSection, settingsBodyClass, settingsIntroClass, settingsPageClass } from "@/components/Settings";
import { Banner, Button, Switch } from "@/components/ui";
import { type Client, problemOf } from "@/lib/client";
import { uuid } from "@/lib/idempotency";

/** A stop on the tour: a page to open, or an agent to start a run of now (so the run plays live as the person watches). */
type Stop = { title: string; shows: string } & ({ href: string } | { start: string });

/** The tour, by what each group shows off. Every stop names a run, an agent or a page of the demo's story (demo/tale). */
export const TOUR: { title: string; note: string; stops: Stop[] }[] = [
  {
    title: "Runs you steer",
    note: "An agent stops where you told it to, and goes on when you answer.",
    stops: [
      { title: "Mission Control", shows: "A month of nine agents: what ran, what it cost, and the four things waiting for you.", href: "#/" },
      { title: "Approve a tool call", shows: "The Refund desk wants to email a buyer. It waits for your Allow or Deny, then finishes.", href: "#/runs/demo-run-refund-approval" },
      { title: "Answer an agent's question", shows: "Two sources disagree on a date. The risk brief asks you which to use, then writes the brief.", href: "#/runs/demo-run-brief-question" },
      { title: "Watch a run live", shows: "Starts a support ticket's triage now: each thought, tool call and result as it happens.", start: "support-triage" },
      { title: "A run stopped at its spend cap", shows: "A 4,100-line pull request hit the reviewer's $1.50 cap. Nothing was posted.", href: "#/runs/demo-run-review-capped" },
    ],
  },
  {
    title: "Workflows and decisions",
    note: "Typed steps, with a probability on every judgment and a person where the model is unsure.",
    stops: [
      { title: "Watch a workflow run live", shows: "Starts a batch of 20 certificates now: four at a time, with one bad PDF and one check to review.", start: "certificate-review" },
      { title: "A decision that was unsure", shows: "A merchant's certificate and its registry record disagree on a date, so the route sends it to a person.", href: "#/runs/demo-run-kyb-review" },
      { title: "Four models that disagree", shows: "A jury of decision models splits on a storefront's bear spray. See each juror's answer and its evidence.", href: "#/runs/demo-run-jury" },
    ],
  },
  {
    title: "Learning",
    note: "An agent that turns what it keeps doing into a workflow, and proves it before it serves.",
    stops: [
      { title: "An agent that got cheaper", shows: "The Refund desk learned a workflow from its own runs. See the cost per run before and after it took over.", href: "#/agents/refund-desk/learning" },
      { title: "A learned workflow doing the work", shows: "One call runs six steps, two of them on a small model. Open the call to see each step.", href: "#/runs/demo-run-refund-approval" },
      { title: "The same job, before it learned", shows: "Nineteen days ago the agent did each step itself, at about eight times the cost.", href: "#/runs/demo-run-refund-by-agent" },
      { title: "Learning Dojo", shows: "Every agent's learning in one place, and the one workflow that waits for your OK.", href: "#/dojo" },
    ],
  },
  {
    title: "Automation and results",
    note: "Runs that start by themselves, and what they leave behind.",
    stops: [
      { title: "Triggers", shows: "Two schedules and three webhooks start these agents. Pause one, or press Run now.", href: "#/triggers" },
      { title: "A report with its files", shows: "Last week's risk brief: five items, each with its source, and the sources as a CSV.", href: "#/runs/demo-run-brief-done" },
      { title: "Every run", shows: "The month's runs, filtered by status: completed, failed, waiting for you.", href: "#/runs" },
      { title: "Start a run yourself", shows: "The API playground, with each demo agent and the request that starts it.", href: "#/playground" },
    ],
  },
  {
    title: "Your agents",
    note: "The agents you already have, and new ones.",
    stops: [
      { title: "Connected agents", shows: "Nine agents: seven that run on the server, and a developer's own Claude Code architect and Codex code reviewer, connected and ready.", href: "#/agents" },
      { title: "A connected Claude Code agent", shows: "The Architect runs as it is set up on its developer's machine: its project, its skills, its MCP servers.", href: "#/agents/architect" },
      { title: "Build an agent", shows: "Name an agent, set its instructions, and choose its tools. In the demo it is kept in this page and runs as a stand-in.", href: "#/agents/new" },
    ],
  },
];

/** Settings → Demo: the switch, and while it is on, the tour. `v2` is the demo's client while demo mode is on, so a
 *  stop that starts a run starts it in the demo. */
export function DemoPage({ on, loading, onChange, v2, go }: { on: boolean; loading?: boolean; onChange: (on: boolean) => void; v2: Client; go: (hash: string) => void }) {
  const [starting, setStarting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async (agentId: string) => {
    setStarting(agentId); setProblem(null);
    try { const r = await v2.startRun(agentId, { input: {} }, uuid()); go(`#/runs/${encodeURIComponent(r.run.run_id)}`); }
    catch (e) { setProblem(problemOf(e)); }
    finally { setStarting(null); }
  };
  return (
    // Scrolls in its own box, as every Settings page does, so the Settings tabs above it stay in view.
    <div className="h-full overflow-auto">
    <div className={settingsPageClass}>
      <div className={settingsIntroClass}>
        <p className="caps text-label text-muted-foreground">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold">Demo</h1>
        <p className="mt-2 text-lead text-muted-foreground">See AgentRun at work without setting anything up. Demo mode fills the console with a sample company's agents and a month of their runs.</p>
      </div>
      <div className={settingsBodyClass}>
        {problem && <Banner tone="error" title="The run did not start">{problem}</Banner>}
        <SettingsSection title="Demo mode" titleId="demo-mode-title" note={<p>In this browser only. Your server, its agents and its runs are not changed, and nobody else sees the demo.</p>}>
          <div className="flex items-start gap-3 border p-4">
            <Switch checked={on} busy={loading} onChange={onChange} labelledBy="demo-mode-title" className="mt-0.5" />
            <div className="min-w-0 space-y-1.5 text-body">
              <p className="font-semibold">{on ? "On: the console shows sample data" : "Off: the console shows your server"}</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Every agent, run, person and company in the demo is invented. None of your data is in it.</li>
                <li>What you do in the demo stays in this page: no run starts on your server, no model is called, and nothing is spent.</li>
                <li>You can answer questions, approve calls, start and stop runs, and build or edit an agent. The server's own settings are hidden.</li>
                <li>Reload the page to start the story again.</li>
              </ul>
            </div>
          </div>
        </SettingsSection>
        {on && TOUR.map((group) => (
          <SettingsSection key={group.title} title={group.title} note={<p>{group.note}</p>}>
            <ul className="divide-y border">
              {group.stops.map((stop) => {
                const body = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-prose font-semibold">{stop.title}</span>
                      <span className="mt-0.5 block text-body text-muted-foreground">{stop.shows}</span>
                    </span>
                    {"start" in stop ? <Play className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  </>
                );
                return (
                  <li key={stop.title}>
                    {"start" in stop
                      ? <button type="button" disabled={starting !== null} onClick={() => void start(stop.start)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent disabled:opacity-45">{body}</button>
                      : <a href={stop.href} className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent">{body}</a>}
                  </li>
                );
              })}
            </ul>
          </SettingsSection>
        ))}
      </div>
    </div>
    </div>
  );
}

/** The strip across the top of every page while demo mode is on: what the person is looking at, and the way out. */
export function DemoBar({ onOff }: { onOff: () => void }) {
  return (
    <Banner bar tone="info" data-demo-bar actions={<><Button size="xs" onClick={() => { location.hash = "#/settings/demo"; }}>Tour</Button><Button size="xs" onClick={onOff}>Turn off</Button></>}>
      <span className="font-semibold">Demo mode.</span> Sample data: nothing here is from your server, and nothing you do here changes it.
    </Banner>
  );
}
