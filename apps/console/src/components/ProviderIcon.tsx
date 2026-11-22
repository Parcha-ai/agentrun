import { Bot, Brain, Chrome, KeyRound, Monitor, Wrench, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Each provider's public site, by its id as the server names it (key-words.ts, model.ts): where its icon is asked
 *  for. A model provider's is its product's site, whose icon is the one people know (chatgpt.com, claude.ai). */
const SITES = new Map<string, string>(Object.entries({
  anthropic: "claude.ai", openai: "chatgpt.com", openrouter: "openrouter.ai", particle: "particle.ai",
  parallel: "parallel.ai", monid: "monid.ai", browserbase: "browserbase.com", kernel: "kernel.sh", typesafe: "typesafe.ai",
  google: "gemini.google.com", xai: "x.ai", deepseek: "deepseek.com", mistral: "mistral.ai", meta: "meta.ai",
  qwen: "qwen.ai", cohere: "cohere.com", nvidia: "nvidia.com", groq: "groq.com", cerebras: "cerebras.ai",
  "moonshotai": "moonshot.ai", "z-ai": "z.ai", minimax: "minimax.io", amazon: "aws.amazon.com",
  exa: "exa.ai", composio: "composio.dev", github: "github.com", opencode: "opencode.ai", pi: "pi.dev",
  docker: "docker.com", daytona: "daytona.io", modal: "modal.com", e2b: "e2b.dev", agent37: "agent37.com",
  orgo: "orgo.ai", "phone-harness": "phone-harness.com",
}));
const ALIASES = new Map<string, string>(Object.entries({
  claude: "anthropic", "claude-agent": "anthropic", "claude-code": "anthropic", "claude-code-cli": "anthropic", "claude-cli": "anthropic", "claude-agent-sdk": "anthropic",
  codex: "openai", "codex-cli": "openai", "codex-sdk": "openai", "openai-codex": "openai", chatgpt: "openai", jev: "typesafe",
  "google-vertex": "google", "google-gemini-cli": "google", "meta-llama": "meta", "mistralai": "mistral",
  "x-ai": "xai", "amazon-bedrock": "amazon", "local-chrome": "chrome", "exa-keyless": "exa",
}));
const canonical = (id: string): string => ALIASES.get(id.toLowerCase()) ?? id.toLowerCase();

/** Use the named vendor, taking off only the server's stated routing prefix or OpenRouter's outer route. Never infer
 *  a vendor from arbitrary model text: an unqualified/custom model retains a generic model icon. */
export function providerIdForModel(model: string, routePrefix?: string | null): string | undefined {
  let id = model;
  if (routePrefix && id.startsWith(`${routePrefix}/`)) id = id.slice(routePrefix.length + 1);
  if (id.startsWith("openrouter/") && id.slice("openrouter/".length).includes("/")) id = id.slice("openrouter/".length);
  const slash = id.indexOf("/");
  return slash > 0 ? canonical(id.slice(0, slash)) : SITES.has(canonical(id)) ? canonical(id) : undefined;
}

/** Only namespaces that identify their provider. A generic browser/search tool and a custom MCP server don't. */
export function providerIdForTool(tool: string): string | undefined {
  if (tool.startsWith("monid:") || tool.startsWith("monid.")) return "monid";
  if (tool === "decisions.jev") return "typesafe";
  if (tool === "decisions.parallel") return "parallel";
  return undefined;
}

/** The built-in fetch's kernel is unrelated to the hosted Kernel browser provider. */
export const toolProviderId = (provider: string, tool: string): string => provider === "kernel" && tool !== "browser" ? "kernel-fetch" : canonical(provider);
export type ProviderIconKind = "provider" | "model" | "harness" | "tool" | "compute";
const FALLBACK: Record<ProviderIconKind, LucideIcon> = { provider: KeyRound, model: Brain, harness: Bot, tool: Wrench, compute: Monitor };
/** Marks bundled with the console, for when the icon can't be fetched: one 24 by 24 path each, drawn in the text's
 *  colour. From Simple Icons (simpleicons.org, CC0 1.0); the marks stay their owners'. */
const MARKS: Record<string, string> = {
  anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  openrouter: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
};
/** Google's favicon service: the site's own icon at 64 px. The server's CSP allows this host and the
 *  gstatic hosts it redirects to (packages/serve/src/page.ts), and nothing else off its origin. */
export const providerIconUrl = (site: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64`;
/** For the SVG graph's own image elements: only an allowlisted provider produces a remote URL. */
export const providerIconSrc = (id: string): string | undefined => {
  const site = SITES.get(canonical(id));
  return site ? providerIconUrl(site) : undefined;
};

/** A provider's icon beside its name: its site's own, fetched from Google's favicon service with no referrer. When
 *  that fails (offline, the host blocked) it is the provider's bundled mark, else the key; a provider with no site
 *  here asks nothing. Decorative: the name is beside it. */
export function ProviderIcon({ id: inputId, kind = "provider", fallback, className }: { id?: string | null; kind?: ProviderIconKind; fallback?: LucideIcon; className?: string }) {
  const id = inputId ?? "";
  const provider = kind === "model" ? providerIdForModel(id) ?? canonical(id) : kind === "tool" ? providerIdForTool(id) ?? canonical(id) : canonical(id);
  // A picker can change identity without unmounting. Keep a failed load scoped to that provider, so it never hides the
  // next provider's icon (and a late error from the old image cannot mark the new one as failed).
  return <ProviderMark key={provider} id={provider} fallback={fallback ?? FALLBACK[kind]} className={className} />;
}

/** The shared backing also holds bundled runtime and coding-agent marks. */
export function ProviderBadge({ children, className }: { children: ReactNode; className?: string }) {
  return <span aria-hidden className={cn("provider-icon inline-flex size-5 shrink-0 items-center justify-center overflow-hidden border bg-provider-icon-surface p-0.5 text-provider-icon-foreground", className)}>{children}</span>;
}

function ProviderMark({ id, fallback: Fallback, className }: { id: string; fallback: LucideIcon; className?: string }) {
  const [failed, setFailed] = useState(false);
  const site = SITES.get(id), mark = Object.hasOwn(MARKS, id) ? MARKS[id] : undefined;
  return <ProviderBadge className={className}>
    {id === "chrome" ? <Chrome data-provider-mark="chrome" className="!size-full" />
      : site && !failed ? <img data-provider-icon={id} src={providerIconUrl(site)} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-contain" />
      : mark ? <svg data-provider-mark={id} viewBox="0 0 24 24" fill="currentColor" className="!size-full"><path d={mark} /></svg>
      : <Fallback className="!size-full" />}
  </ProviderBadge>;
}
