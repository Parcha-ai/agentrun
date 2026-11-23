import { useId, type ReactNode } from "react";
import { tabClass, tabListClass } from "@/components/ui/tabs";

export type SettingsPage = "keys" | "harness-keys" | "tools" | "mcp" | "github" | "email" | "computers" | "workspace" | "webhook" | "slack" | "demo";
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = [{ id: "keys", label: "API Keys" }, { id: "harness-keys", label: "Harness keys" }, { id: "tools", label: "Tools" }, { id: "mcp", label: "MCP servers" }, { id: "github", label: "GitHub" }, { id: "email", label: "Email" }, { id: "computers", label: "Computers" }, { id: "workspace", label: "Workspace" }, { id: "webhook", label: "Webhook" }, { id: "slack", label: "Slack" }, { id: "demo", label: "Demo" }];

/** A Settings page: what the page is (its title and its sentence) above, then its sections, one under another, each a
 *  `SettingsSection`. Anything else in the body (a notice, an error) stands above the sections, full width. */
export const settingsPageClass = "p-5 md:p-8";
export const settingsIntroClass = "mb-6 max-w-prose";
export const settingsBodyClass = "[&>:not(section)]:mb-6";

/** One section of a Settings page, the same on every page: from `xl` a row, with what the section is on the left (its
 *  name, a sentence, and the actions that add to it) and its settings on the right. So every box on every page starts
 *  at one edge and has one width, and a page with one section looks like a page with five. Under `xl`, the name stands
 *  above. `label` names the section for a reader when its title is not the name tests and readers know it by. */
export function SettingsSection({ title, titleId, note, aside, label, children }: { title: ReactNode; titleId?: string; note?: ReactNode; aside?: ReactNode; label?: string; children: ReactNode }) {
  const own = useId();
  const id = titleId ?? own;
  return (
    <section aria-label={label} aria-labelledby={label ? undefined : id} className="border-t py-6 xl:grid xl:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)] xl:items-start xl:gap-x-10">
      <div className="max-xl:mb-3">
        <h2 id={id} className="caps text-small font-semibold">{title}</h2>
        {note && <div className="mt-1.5 space-y-1.5 text-body text-muted-foreground">{note}</div>}
        {aside && <div className="mt-3 flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

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
