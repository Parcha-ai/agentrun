import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Settings' pages, a tab each, over the one open (`page`): Tool keys and Webhook, each only where the server has its
 *  routes. With one page there are no tabs. */
export function SettingsPages({ page, keys, webhook, children }: { page: "keys" | "webhook"; keys: boolean; webhook: boolean; children: ReactNode }) {
  const tabs = [...(keys ? [{ id: "keys", label: "Tool keys", href: "#/settings/keys" }] : []), ...(webhook ? [{ id: "webhook", label: "Webhook", href: "#/settings/webhook" }] : [])];
  return (
    <div className="flex h-full flex-col">
      {tabs.length > 1 && (
        <nav aria-label="Settings" className="flex gap-1 border-b px-5 md:px-8">
          {tabs.map((t) => (
            <a key={t.id} href={t.href} aria-current={t.id === page ? "page" : undefined}
              className={cn("caps border-b-2 px-3 py-2.5 text-[12px]", t.id === page ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
            </a>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
