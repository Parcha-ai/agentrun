import { Bot, Pi, Workflow } from "lucide-react";
import claudeIcon from "@/assets/coding-agents/claude-code-cli.svg";
import codexIcon from "@/assets/coding-agents/codex-cli.svg";
import eveIcon from "@/assets/harnesses/eve.svg";
import { cn } from "@/lib/utils";
import { type Agent, harnessLabel } from "@/lib/agentForm";
import { backendSdkOf } from "@/lib/backendSdk";
import { cliLearningOf } from "@/lib/cliLearning";
import { nativeReadinessOf } from "@/lib/native";

/** The runtime an agent's icon shows, the same wherever the agent is drawn (its card on the list, its page's top bar): a
 *  workflow's own; else the CLI, backend SDK or native runtime it runs in; else its harness, pi when it names none. */
export function agentHarness(agent: Pick<Agent, "kind" | "definition"> & Parameters<typeof nativeReadinessOf>[0]): string {
  if (agent.kind === "workflow") return "workflow";
  return cliLearningOf(agent.definition)?.runtime ?? backendSdkOf(agent.definition)?.runtime ?? nativeReadinessOf(agent)?.runtime ?? agent.definition.harness ?? "pi";
}

/** Runtime identity, independent of the model provider and the user's handoff preference. With `label` (the runtime's
 *  name, "Pi" or "Claude Code") the icon stands for those words: a screen reader reads the name, and hovering shows it.
 *  Without one it is decoration beside a label that says the same. */
export function HarnessIcon({ harness, className, label }: { harness?: string; className?: string; label?: string }) {
  const src = harness === "claude" || harness === "claude-code" || harness === "claude-agent" || harness === "claude-agent-sdk" ? claudeIcon
    : harness === "codex" || harness === "codex-sdk" ? codexIcon
    : harness === "eve" ? eveIcon : undefined;
  const classes = cn("size-5 shrink-0", className);
  const Icon = harness === "workflow" ? Workflow : harness === "pi" ? Pi : Bot;
  const drawn = src ? <img src={src} alt="" aria-hidden width={20} height={20} className={cn(classes, "object-contain")} />
    : <Icon className={cn(classes, "text-muted-foreground")} aria-hidden />;
  if (!label) return drawn;
  return <span role="img" aria-label={label} title={label} data-harness={harness} className="inline-flex shrink-0">{drawn}</span>;
}

/** A harness or runtime named in a fact or a line: its icon, then its name ("Claude", "Codex SDK"). The icon is the
 *  name's picture, so a screen reader reads the name once. */
export function HarnessName({ harness, name, className }: { harness: string; name?: string; className?: string }) {
  return <span data-harness={harness} className={cn("inline-flex min-w-0 items-center gap-1.5 align-middle", className)}><HarnessIcon harness={harness} className="size-4" />{name ?? harnessLabel(harness)}</span>;
}

/** A template's harnesses as a row of icons, each named as the Harness step names it ("Claude" for claude-agent). */
export function HarnessIcons({ ids }: { ids: readonly string[] }) {
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{ids.map((id) => <HarnessIcon key={id} harness={id} label={harnessLabel(id)} className="size-4" />)}</span>;
}

/** The icon in front of a template's card, as an agent's card has its harness's: the harness it prefers first, named
 *  with the others it runs on. An empty list (any harness), or a marketplace list that does not say (`undefined`), draws
 *  the plain icon, named so. */
export function TemplateHarnessIcon({ harness, className }: { harness: readonly string[] | undefined; className?: string }) {
  const label = harness === undefined ? "Harness not listed" : harness.length ? `Harness: ${harness.map(harnessLabel).join(", ")}` : "Any harness";
  return <HarnessIcon harness={harness?.[0]} label={label} className={className} />;
}
