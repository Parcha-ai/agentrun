import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SettingsPage = "keys" | "tools" | "mcp" | "github" | "computers" | "workspace" | "webhook";
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = [{ id: "keys", label: "Tool keys" }, { id: "tools", label: "Tools" }, { id: "mcp", label: "MCP servers" }, { id: "github", label: "GitHub" }, { id: "computers", label: "Computers" }, { id: "workspace", label: "Workspace" }, { id: "webhook", label: "Webhook" }];

/** Settings: a tab per page this server offers (`offered`), above the page. One page alone needs no tabs. */
export function Settings({ active, offered, children }: { active: SettingsPage; offered: SettingsPage[]; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {offered.length > 1 && (
        <nav aria-label="Settings" className="flex shrink-0 gap-1 border-b px-6">
          {SETTINGS_PAGES.filter((p) => offered.includes(p.id)).map((p) => (
            <a key={p.id} href={`#/settings/${p.id}`} aria-current={active === p.id ? "page" : undefined}
              className={cn("caps -mb-px border-b-2 px-3 py-3 text-small", active === p.id ? "border-primary text-primary-text" : "border-transparent text-muted-foreground hover:text-foreground")}>{p.label}</a>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
