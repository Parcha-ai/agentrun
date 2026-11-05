import { Bot, CalendarClock, History, LayoutDashboard, LogOut, Menu, Monitor, Moon, Puzzle, Settings, Sun, Terminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConnectionBanner } from "@/components/Connection";
import { cn } from "@/lib/utils";
import { applyTheme, currentTheme, saveTheme, type Theme, THEMES } from "@/lib/theme";

export type Section = "mission" | "playground" | "agents" | "runs" | "schedules" | "settings";

// v1's navigation only. Deployments, runners, swarms, teams and billing are not part of this console.
const NAV: { id: Section; label: string; Icon: typeof Bot }[] = [
  { id: "mission", label: "Mission Control", Icon: LayoutDashboard },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "runs", label: "Runs", Icon: History },
  { id: "schedules", label: "Schedules", Icon: CalendarClock },
  { id: "playground", label: "API playground", Icon: Terminal },
  { id: "settings", label: "Settings", Icon: Settings },
];

const THEME_LABEL: Record<Theme, [string, typeof Bot]> = { system: ["System", Monitor], light: ["Light", Sun], dark: ["Dark", Moon] };

/** System (the OS's), Light or Dark: a pick shows at once and is kept in this browser (lib/theme). */
function ThemeSwitch() {
  // The pick in force: kept in this browser, or held on this page when the storage refused it.
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const pick = (t: Theme) => { saveTheme(t); applyTheme(t); setTheme(t); };
  return (
    <div role="group" aria-label="Theme" className="flex border">
      {THEMES.map((t) => {
        const [label, Icon] = THEME_LABEL[t];
        return (
          <button key={t} type="button" aria-label={label} title={label} aria-pressed={theme === t} onClick={() => pick(t)}
            className={cn("flex flex-1 items-center justify-center py-2 hover:bg-accent", theme === t && "bg-primary/[0.06] text-primary")}>
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function Wordmark() {
  return <span className="whitespace-nowrap font-mono text-[22px] font-semibold" aria-label="AgentRun">agent<span className="text-primary">.run()</span></span>;
}

/** The AgentRun shell: a 220px sidebar with the wordmark, the nav (the active item has orange text and a tinted background),
 *  and sign out at its foot; under 700px a top bar with a menu that opens the nav. Settings shows only when `settings`
 *  (the server has a settings page to open), Schedules only when `schedules` (the server has them). Connection and page
 *  banners sit outside the scrolling main so a full-height page keeps its footer in view. */
export function Shell({ active, settings = true, schedules = false, agents = true, runs = true, onNavigate, onSignOut, signOutLabel = "Sign out", extensions = [], activeExtension, onExtensionNavigate, banners, children }: { active: Section; settings?: boolean; schedules?: boolean; agents?: boolean; runs?: boolean; onNavigate?: (s: Section) => void; onSignOut?: () => void; signOutLabel?: string; extensions?: readonly { id: string; label: string; path: string }[]; activeExtension?: string; onExtensionNavigate?: (path: string) => void; banners?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3 md:hidden">
        <Wordmark />
        <button type="button" className="border p-2" aria-label="Navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Menu className="size-[18px]" aria-hidden /></button>
      </header>
      {/* It scrolls at every width it shows at: on a short screen (a phone on its side) its foot, Sign out, stays reachable. */}
      <aside className={cn("shrink-0 flex-col border-r bg-background px-3 pb-4 pt-6 md:flex md:h-dvh md:w-[220px] md:overflow-y-auto", open ? "flex max-h-[60dvh] overflow-y-auto border-b md:max-h-none" : "hidden")}>
        <div className="hidden px-3 pb-[30px] md:block"><Wordmark /></div>
        <nav aria-label="Navigation" className="flex flex-col gap-1">
          {NAV.filter((n) => (n.id !== "settings" || settings) && (n.id !== "schedules" || schedules) && (n.id !== "agents" || agents) && (n.id !== "playground" || agents) && (n.id !== "runs" || runs)).map(({ id, label, Icon }) => (
            <button key={id} type="button" onClick={() => { onNavigate?.(id); setOpen(false); }} aria-current={!activeExtension && active === id ? "page" : undefined}
              className={cn("flex items-center gap-2.5 p-3 text-left text-[13px] hover:bg-accent", !activeExtension && active === id && "bg-primary/[0.06] font-semibold text-primary")}>
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
          {extensions.map(({ id, label, path }) => <button key={`extension-${id}`} type="button" onClick={() => { onExtensionNavigate?.(path); setOpen(false); }} aria-current={activeExtension === id ? "page" : undefined}
            className={cn("flex items-center gap-2.5 p-3 text-left text-[13px] hover:bg-accent", activeExtension === id && "bg-primary/[0.06] font-semibold text-primary")}><Puzzle className="size-4" aria-hidden /> {label}</button>)}
        </nav>
        <div className="mt-4 md:mt-auto"><ThemeSwitch /></div>
        {onSignOut && <button type="button" onClick={onSignOut} className="caps mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-[12px] hover:bg-accent">
          <LogOut className="size-4" aria-hidden /> {signOutLabel}
        </button>}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        {banners}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
