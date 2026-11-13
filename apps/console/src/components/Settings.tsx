import type { ReactNode } from "react";
import { tabClass, tabListClass } from "@/components/ui/tabs";

export type SettingsPage = "keys" | "tools" | "mcp" | "github" | "computers" | "workspace" | "webhook";
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = [{ id: "keys", label: "Tool keys" }, { id: "tools", label: "Tools" }, { id: "mcp", label: "MCP servers" }, { id: "github", label: "GitHub" }, { id: "computers", label: "Computers" }, { id: "workspace", label: "Workspace" }, { id: "webhook", label: "Webhook" }];

/** A Settings page across the width it has: from `xl`, what the page is (its title and its sentence) stands in a column
 *  of its own on the left and stays while the settings scroll beside it; under `xl` it is above them. */
export const settingsPageClass = "p-5 md:p-8 xl:grid xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] xl:items-start xl:gap-x-12";
export const settingsIntroClass = "max-xl:mb-6 xl:sticky xl:top-8";
export const settingsBodyClass = "min-w-0 space-y-6";

/** Settings: a tab per page this server offers (`offered`), above the page. One page alone needs no tabs. */
export function Settings({ active, offered, children }: { active: SettingsPage; offered: SettingsPage[]; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {offered.length > 1 && (
        <nav aria-label="Settings" className={tabListClass}>
          {SETTINGS_PAGES.filter((p) => offered.includes(p.id)).map((p) => (
            <a key={p.id} href={`#/settings/${p.id}`} aria-current={active === p.id ? "page" : undefined}
              className={tabClass(active === p.id)}>{p.label}</a>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
