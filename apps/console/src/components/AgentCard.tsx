import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Chip } from "@/components/ui/chip";
import { buttonVariants } from "@/components/ui/button";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { cn } from "@/lib/utils";

/** The same title, body and footer for every agent; each source supplies only the actions it supports. `harnessName`
 *  names the runtime its icon draws: the icon says it, in place of a chip in words. */
export function AgentCardFrame({ name, icon: Icon, harness, harnessName, badges, description, children, facts, actions, href, onOpen, archived }: {
  name: string; icon: LucideIcon; harness?: string; harnessName?: string; badges?: ReactNode; description?: ReactNode; children?: ReactNode;
  facts?: ReactNode; actions?: ReactNode; href?: string; onOpen?: () => void; archived?: boolean;
}) {
  const heading = <>
    <span data-agent-card-icon className="flex h-6 shrink-0 items-center">{harness ? <HarnessIcon harness={harness} label={harnessName} /> : <Icon className="size-4 text-muted-foreground" aria-hidden />}</span>
    <span className="min-w-0 flex-1">
      <span className="flex min-h-6 flex-wrap items-center gap-2"><span className="break-words text-base font-semibold">{name}</span>{badges}</span>
      {description && <span className="mt-2 line-clamp-2 block text-lead leading-relaxed text-muted-foreground">{description}</span>}
    </span>
  </>;
  return <li className={cn("flex flex-col border p-5 transition-colors hover:border-border-strong", archived && "opacity-70")}>
    {href ? <a href={href} className="flex min-w-0 items-start gap-2.5 text-left">{heading}</a>
      : <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={onOpen}>{heading}</button>}
    {children && <div className="mt-3 space-y-1 text-small text-muted-foreground">{children}</div>}
    <div data-testid="agent-card-footer" className="mt-auto flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 pt-5">
      <div data-testid="agent-card-chips" className="flex min-w-0 flex-auto flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5">{facts}</div>
      <div data-testid="agent-card-actions" className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>
    </div>
  </li>;
}

export type AgentLearningState = "on" | "off" | "setup_required" | "unknown" | "unsupported";

/** Cards show status. Setup and settings are available only in the agent detail page. */
export function AgentCardLearning({ state, href, prompt, reason, awaitingActivation, serverDisabled, controls = false }: { state: AgentLearningState; href?: string; prompt?: string; reason?: string; awaitingActivation?: boolean; serverDisabled?: boolean; controls?: boolean }) {
  const words = awaitingActivation && state === "unknown" ? "Awaiting activation" : { on: "Learning on", off: "Learning off", setup_required: "Learning not set up", unknown: "Learning unknown", unsupported: "Learning unavailable" }[state];
  if (!controls) return <Chip tone={state === "on" ? "success" : "muted"} title={reason}>{words}</Chip>;
  return <>
    {state === "on" && href ? <a href={href} className={cn(buttonVariants({ size: "xs", variant: "outline" }), "border-success/50 text-success-text")}>{words}</a>
      : <Chip tone={state === "on" ? "success" : "muted"} title={reason}>{words}</Chip>}
    {state === "off" && href && <a href={href} className={buttonVariants({ size: "xs", variant: "outline" })}>{serverDisabled ? "Learning settings" : "Enable learning"}</a>}
    {(state === "setup_required" || state === "unknown") && <>
      {href && <a href={href} className={buttonVariants({ size: "xs", variant: "outline" })}>Learning settings</a>}
      {prompt && <CodingAgentAction label={awaitingActivation ? "Verify learning" : state === "unknown" ? "Set up learning" : "Enable learning"} prompt={prompt} />}
    </>}
  </>;
}
