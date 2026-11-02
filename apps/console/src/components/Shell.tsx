import { Bot, History, LayoutDashboard, LogOut, Menu, Settings, Terminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

export type Section = "mission" | "playground" | "agents" | "runs" | "settings";

// v1's navigation only. Deployments, runners, swarms, teams and billing are not part of this console.
const NAV: { id: Section; label: string; Icon: typeof Bot }[] = [
  { id: "mission", label: "Mission Control", Icon: LayoutDashboard },
  { id: "playground", label: "Playground", Icon: Terminal },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "runs", label: "Runs", Icon: History },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function Wordmark() {
  return <span className="whitespace-nowrap font-mono text-[22px] font-semibold" aria-label="AgentRun">agent<span className="text-primary">.run()</span></span>;
}

/** The AgentRun shell: a 220px sidebar with the wordmark, the nav (the active item orange with a 2px inset bar),
 *  and sign out at its foot; under 700px a top bar with a menu that opens the nav. Settings shows only when `settings`
 *  (the server has a settings page to open). */
export function Shell({ active, settings = false, onNavigate, onSignOut, children }: { active: Section; settings?: boolean; onNavigate?: (s: Section) => void; onSignOut?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3 md:hidden">
        <Wordmark />
        <button type="button" className="border p-2" aria-label="Navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Menu className="size-[18px]" aria-hidden /></button>
      </header>
      <aside className={cn("shrink-0 flex-col border-r bg-background px-3 pb-4 pt-6 md:flex md:h-dvh md:w-[220px]", open ? "flex max-h-[60dvh] overflow-y-auto border-b md:max-h-none" : "hidden")}>
        <div className="hidden px-3 pb-[30px] md:block"><Wordmark /></div>
        <nav aria-label="Navigation" className="flex flex-col gap-1">
          {NAV.filter((n) => n.id !== "settings" || settings).map(({ id, label, Icon }) => (
            <button key={id} type="button" onClick={() => { onNavigate?.(id); setOpen(false); }} aria-current={active === id ? "page" : undefined}
              className={cn("flex items-center gap-2.5 p-3 text-left text-[13px] hover:bg-accent", active === id && "bg-primary/[0.06] text-primary shadow-[inset_2px_0_hsl(var(--primary))]")}>
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <button type="button" onClick={onSignOut} className="caps mt-4 flex items-center gap-2.5 border px-3 py-2.5 text-[12px] hover:bg-accent md:mt-auto">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
