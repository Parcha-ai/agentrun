import { cliRunLabel } from "@/lib/cliLearning";
import type { Run } from "@/lib/v2";

/** A captured prompt and observed correction revision do not establish workflow learning or reuse. */
export function CliLearningRun({ cli, ended }: { cli: NonNullable<Run["cli_learning"]>; ended: boolean }) {
  const rows = [
    ["Original CLI", cliRunLabel(cli.runtime)], ["Session", cli.session_id], ["Prompt window", cli.turn_id],
    ["Model", cli.model ?? "Not reported"], ["Source policy", cli.policy_complete ? "Captured" : !ended ? "Awaiting source policy" : "Incomplete — learning unavailable"],
    ["Task evidence", !ended ? "Awaiting completion" : cli.evidence_complete ? "Complete" : "Incomplete"],
    ["Pinned learning revision", cli.learning_revision ?? "None supplied"],
    ["Guidance in source context", cli.seed_observed ? "Verified" : "Reuse not verified"],
  ];
  return <section className="space-y-3 border bg-card p-4" aria-label="CLI learning evidence">
    <h2 className="text-lg font-semibold">CLI prompt window</h2>
    <dl className="grid gap-3 text-small sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl>
    <p className="text-small text-muted-foreground">Completed prompts are recorded here. Manage your corrections in Learning; this CLI connection does not support learned workflow execution.</p>
  </section>;
}
