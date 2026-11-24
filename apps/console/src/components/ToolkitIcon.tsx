import { useState } from "react";
import { providerIconUrl } from "@/components/ProviderIcon";
import type { McpSource } from "@/lib/mcp";

/** A toolkit (a template's MCP need, by its slug) as people know it: its name, and the site whose icon is its, asked of
 *  the same favicon service as a provider's icon (the server's CSP allows that host alone). A toolkit not here is
 *  shown by its slug, in words. */
const TOOLKITS: Record<string, { name: string; site: string }> = {
  fal: { name: "fal", site: "fal.ai" },
  firecrawl: { name: "Firecrawl", site: "firecrawl.dev" },
  github: { name: "GitHub", site: "github.com" },
  gmail: { name: "Gmail", site: "mail.google.com" },
  googlecalendar: { name: "Google Calendar", site: "calendar.google.com" },
  googledrive: { name: "Google Drive", site: "drive.google.com" },
  hubspot: { name: "HubSpot", site: "hubspot.com" },
  linear: { name: "Linear", site: "linear.app" },
  notion: { name: "Notion", site: "notion.so" },
  parallel: { name: "Parallel Search", site: "parallel.ai" },
  salesforce: { name: "Salesforce", site: "salesforce.com" },
  slack: { name: "Slack", site: "slack.com" },
};

export const toolkitName = (toolkit: string) => TOOLKITS[toolkit]?.name ?? toolkit;

/** Where a toolkit's tools come from, after its name: a Composio toolkit says so, a server the owner adds by address
 *  says that, and GitHub's own MCP server needs nothing beside "GitHub". */
const FROM: Record<McpSource, string> = { composio: " through Composio", url: " from an MCP server you add", github: "" };

type Need = { toolkit: string; source: McpSource; required: boolean };

/** One toolkit: its icon, named for a screen reader and on hover (its source, and whether it is optional). When the
 *  icon can't be had (no site here, offline, the host blocked) it is the toolkit's name in words. */
export function ToolkitIcon({ toolkit, source, required }: Need) {
  const [failed, setFailed] = useState(false);
  const known = TOOLKITS[toolkit];
  const name = `${toolkitName(toolkit)}${FROM[source]}`;
  const title = required ? name : `${name}, optional`;
  if (known && !failed) return <img data-toolkit={toolkit} src={providerIconUrl(known.site)} alt={name} title={title} width={16} height={16} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-4 shrink-0 object-contain" />;
  return <span data-toolkit={toolkit} title={title}>{toolkitName(toolkit)}</span>;
}

/** A template's toolkits as a row of icons: those it needs, then those it can do without, which end in "optional". */
export function ToolkitIcons({ needs }: { needs: readonly Need[] }) {
  const required = needs.filter((m) => m.required), optional = needs.filter((m) => !m.required);
  const icons = (list: readonly Need[]) => list.map((m) => <ToolkitIcon key={`${m.source}:${m.toolkit}`} {...m} />);
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
    {icons(required)}
    {required.length > 0 && optional.length > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
    {icons(optional)}
    {optional.length > 0 && <span className="text-muted-foreground">optional</span>}
  </span>;
}
