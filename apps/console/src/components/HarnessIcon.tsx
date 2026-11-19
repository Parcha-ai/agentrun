import { Bot, Pi, Workflow } from "lucide-react";
import claudeIcon from "@/assets/coding-agents/claude-code-cli.svg";
import codexIcon from "@/assets/coding-agents/codex-cli.svg";
import eveIcon from "@/assets/harnesses/eve.svg";
import { cn } from "@/lib/utils";

/** Runtime identity, independent of the model provider and the user's handoff preference.
 * The adjacent harness label supplies the accessible name. */
export function HarnessIcon({ harness, className }: { harness?: string; className?: string }) {
  const src = harness === "claude" || harness === "claude-code" || harness === "claude-agent" || harness === "claude-agent-sdk" ? claudeIcon
    : harness === "codex" || harness === "codex-sdk" ? codexIcon
    : harness === "eve" ? eveIcon : undefined;
  const classes = cn("size-5 shrink-0", className);
  if (src) return <img src={src} alt="" aria-hidden width={20} height={20} className={cn(classes, "object-contain")} />;
  const Icon = harness === "workflow" ? Workflow : harness === "pi" ? Pi : Bot;
  return <Icon className={cn(classes, "text-muted-foreground")} aria-hidden />;
}
