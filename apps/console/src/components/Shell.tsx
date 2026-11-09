import { Bot, CalendarClock, History, LayoutDashboard, LayoutTemplate, LogOut, Menu, Monitor, Moon, Settings, Sun, Terminal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConnectionBanner } from "@/components/Connection";
import { cn } from "@/lib/utils";
import { applyTheme, currentTheme, saveTheme, type Theme, THEMES } from "@/lib/theme";

export type Section = "mission" | "playground" | "agents" | "templates" | "runs" | "triggers" | "settings";

// v1's navigation only. Deployments, runners, swarms, teams and billing are not part of this console.
const NAV: { id: Section; label: string; Icon: typeof Bot }[] = [
  { id: "mission", label: "Mission Control", Icon: LayoutDashboard },
  { id: "playground", label: "Playground", Icon: Terminal },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "templates", label: "Templates", Icon: LayoutTemplate },
  { id: "runs", label: "Runs", Icon: History },
  { id: "triggers", label: "Triggers", Icon: CalendarClock },
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

/** The AgentRun shell: a 220px sidebar with the wordmark, the nav (the active item orange with a 2px inset bar),
 *  and sign out at its foot; under 700px a top bar with a menu that opens the nav. Settings shows only when `settings`
 *  (the server has a settings page to open), Triggers only when `triggers` (the server has them). Above every page,
 *  the one banner on the link to the server, while it is away and as it comes back, then `banners` (the page's own: no
 *  model yet, an import, a failed sign-out). They sit outside the page's scrolling main, so a full-height page fills what
 *  is left under them and keeps its footer in view. */
/** `onSignOut`: this browser; `onSignOutEverywhere`: every browser and phone signed in to the server, asked first. */
export function Shell({ active, settings = false, triggers = false, onNavigate, onSignOut, onSignOutEverywhere, banners, children }: { active: Section; settings?: boolean; triggers?: boolean; onNavigate?: (s: Section) => void; onSignOut?: () => void; onSignOutEverywhere?: () => void; banners?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  // The keyboard's place: the confirm opens on Cancel, and Cancel or Escape gives the focus back to its trigger.
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);
  useEffect(() => {
    if (everywhere) cancel.current?.focus();
    else if (reopened.current) trigger.current?.focus();
  }, [everywhere]);
  const closeEverywhere = () => { reopened.current = true; setEverywhere(false); };
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
          {NAV.filter((n) => (n.id !== "settings" || settings) && (n.id !== "triggers" || triggers)).map(({ id, label, Icon }) => (
            <button key={id} type="button" onClick={() => { onNavigate?.(id); setOpen(false); }} aria-current={active === id ? "page" : undefined}
              className={cn("flex items-center gap-2.5 p-3 text-left text-[13px] hover:bg-accent", active === id && "bg-primary/[0.06] text-primary shadow-[inset_2px_0_hsl(var(--primary))]")}>
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <div className="mt-4 md:mt-auto"><ThemeSwitch /></div>
        <button type="button" onClick={onSignOut} className="caps mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-[12px] hover:bg-accent">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
        {onSignOutEverywhere && (everywhere ? (
          <div role="alertdialog" aria-label="Sign out everywhere?" onKeyDown={(e) => { if (e.key === "Escape") closeEverywhere(); }} className="mt-2 space-y-2 border border-destructive/50 px-3 py-2.5 text-[12px]">
            <p>Signs out every browser and phone signed in to this server, this one too.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setEverywhere(false); onSignOutEverywhere(); }} className="caps border border-destructive/60 px-2 py-1 text-[11px] text-destructive-text hover:bg-destructive/10">Sign out everywhere</button>
              <button type="button" ref={cancel} onClick={closeEverywhere} className="caps border px-2 py-1 text-[11px] hover:bg-accent">Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" ref={trigger} onClick={() => setEverywhere(true)} className="mt-1 px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground">Sign out everywhere</button>
        ))}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        {banners}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
