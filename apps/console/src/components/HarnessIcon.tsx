import { Bot, Pi, Workflow } from "lucide-react";
import claudeIcon from "@/assets/coding-agents/claude-code-cli.svg";
import codexIcon from "@/assets/coding-agents/codex-cli.svg";
import eveIcon from "@/assets/harnesses/eve.svg";
import { ProviderBadge } from "@/components/ProviderIcon";

/** Runtime identity, independent of the model provider and the user's handoff preference.
 * The adjacent harness label supplies the accessible name. */
export function HarnessIcon({ harness, className }: { harness?: string; className?: string }) {
  const src = harness === "claude" || harness === "claude-code" || harness === "claude-agent" || harness === "claude-agent-sdk" ? claudeIcon
    : harness === "codex" || harness === "codex-sdk" ? codexIcon
    : harness === "eve" ? eveIcon : undefined;
  if (src) return <ProviderBadge className={className}><img src={src} alt="" aria-hidden width={20} height={20} className="size-full object-contain" /></ProviderBadge>;
  const Icon = harness === "workflow" ? Workflow : harness === "pi" ? Pi : Bot;
  return <ProviderBadge className={className}><Icon className="!size-full" aria-hidden /></ProviderBadge>;
}
