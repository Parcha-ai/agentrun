import { Brain, CalendarClock, ChevronDown, Code, Hammer, History, LayoutGrid, LayoutTemplate, LogOut, Menu, Monitor, Moon, Settings, Sun } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConnectionBanner } from "@/components/Connection";
import { DojoIcon } from "@/components/DojoIcon";
import { Button, NavItem } from "@/components/ui";
import { cn } from "@/lib/utils";
import { applyTheme, currentTheme, saveTheme, type Theme, THEMES } from "@/lib/theme";

export type Section = "mission" | "playground" | "agents" | "runs" | "dojo" | "templates" | "triggers" | "settings";

const ROUTES: Record<Section, string> = { mission: "#/", playground: "#/playground", agents: "#/agents", runs: "#/runs", dojo: "#/dojo", templates: "#/templates", triggers: "#/triggers", settings: "#/settings/keys" };
const THEME_LABEL: Record<Theme, [string, typeof Brain]> = { system: ["System", Monitor], light: ["Light", Sun], dark: ["Dark", Moon] };

/** System (the OS's), Light or Dark: a pick shows at once and is kept in this browser (lib/theme). */
function ThemeSwitch() {
  // The pick in force: kept in this browser, or held on this page when the storage refused it.
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const pick = (t: Theme) => { saveTheme(t); applyTheme(t); setTheme(t); };
  return (
    <div role="group" aria-label="Theme" className="flex gap-1 border p-1">
      {THEMES.map((t) => {
        const [label, Icon] = THEME_LABEL[t];
        return (
          <Button key={t} variant="ghost" size="sm" aria-label={label} title={label} aria-pressed={theme === t} onClick={() => pick(t)}
            className={cn("flex flex-1 items-center justify-center py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", theme === t && "bg-accent text-foreground")}>
            <Icon className="size-4" aria-hidden />
          </Button>
        );
      })}
    </div>
  );
}

export function Wordmark() {
  return <span className="inline-flex items-center whitespace-nowrap text-lg font-semibold font-mono" aria-label="AgentRun">
    <svg viewBox="0 0 64 64" className="mr-1 size-4 text-primary-text" aria-hidden><path d="M18 12L42 32L18 52" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square" strokeLinejoin="miter" /></svg>
    agent<span className="text-primary-text">.run()</span>
  </span>;
}

export type ShellProps = { active: Section; settings?: boolean; triggers?: boolean; banners?: ReactNode; building?: boolean; onBuild?: () => void; onNavigate?: (s: Section) => void; onSignOut?: () => void; onSignOutEverywhere?: () => void; children: ReactNode };

/** The hosted console's workspace shell, with only destinations this server supports. The logo row aligns with
 * the 48px page toolbar. Agent creation, management and history share the expandable Agents section. */
export function Shell({ active, settings = false, triggers = false, banners, building = false, onBuild, onNavigate, onSignOut, onSignOutEverywhere, children }: ShellProps) {
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
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const agentsActive = active === "agents" || active === "runs" || active === "templates";
  useEffect(() => { if (agentsActive || building) setAgentsExpanded(true); }, [active, building]);
  const navigate = (section: Section) => { if (onNavigate) onNavigate(section); else location.hash = ROUTES[section]; setOpen(false); };
  const build = () => { if (onBuild) onBuild(); else location.hash = "#/agents/new"; setOpen(false); };
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 md:hidden">
        <button type="button" onClick={() => navigate("mission")} aria-label="AgentRun home"><Wordmark /></button>
        <Button size="icon" aria-label="Navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Menu className="size-4" aria-hidden /></Button>
      </header>
      <aside className={cn("shrink-0 flex-col border-r bg-background md:flex md:h-dvh md:overflow-y-auto md:w-sidebar", open ? "flex max-h-[60dvh] overflow-y-auto border-b md:max-h-none" : "hidden")}>
        <div className="hidden h-12 shrink-0 items-center border-b px-4 md:flex">
          <button type="button" onClick={() => navigate("mission")} aria-label="AgentRun home"><Wordmark /></button>
        </div>
        <nav aria-label="Navigation" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3">
          <div className="space-y-0.5">
            <NavItem className="w-full" active={active === "mission"} onClick={() => navigate("mission")}><LayoutGrid className="size-4 shrink-0" aria-hidden />Mission Control</NavItem>
            <NavItem className="w-full" active={active === "playground"} onClick={() => navigate("playground")}><Code className="size-4 shrink-0" aria-hidden />API playground</NavItem>
            <div>
              <NavItem className={cn("w-full", agentsActive && "text-primary-text")} aria-expanded={agentsExpanded} aria-controls="agent-navigation" onClick={() => setAgentsExpanded((value) => !value)}>
                <Brain className="size-4 shrink-0" aria-hidden /><span className="flex-1">Agents</span><ChevronDown className={cn("size-3.5 transition-transform", !agentsExpanded && "-rotate-90")} aria-hidden />
              </NavItem>
              <div id="agent-navigation" hidden={!agentsExpanded} className="space-y-0.5">
                <NavItem className="w-full pl-8" active={building} onClick={build}><Hammer className="size-3.5 shrink-0" aria-hidden />Build</NavItem>
                <NavItem className="w-full pl-8" active={active === "agents" && !building} onClick={() => navigate("agents")}><Brain className="size-3.5 shrink-0" aria-hidden />Connected agents</NavItem>
                <NavItem className="w-full pl-8" active={active === "templates"} onClick={() => navigate("templates")}><LayoutTemplate className="size-3.5 shrink-0" aria-hidden />Templates</NavItem>
                <NavItem className="w-full pl-8" active={active === "runs"} onClick={() => navigate("runs")}><History className="size-3.5 shrink-0" aria-hidden />Runs</NavItem>
              </div>
            </div>
            {triggers && <NavItem className="w-full" active={active === "triggers"} onClick={() => navigate("triggers")}><CalendarClock className="size-4 shrink-0" aria-hidden />Triggers</NavItem>}
            <NavItem className="w-full" active={active === "dojo"} onClick={() => navigate("dojo")}><DojoIcon size={16} className="shrink-0" />Learning Dojo</NavItem>
          </div>
          {settings && <div data-sidebar-account className="mt-auto border-t pb-2 pt-3">
            <NavItem className="w-full" active={active === "settings"} onClick={() => navigate("settings")}><Settings className="size-4 shrink-0" aria-hidden />Settings</NavItem>
          </div>}
        </nav>
        <div className="shrink-0 space-y-2 px-3 pb-4 pt-3">
          <ThemeSwitch />
          <Button onClick={onSignOut} className="w-full justify-start"><LogOut aria-hidden />Sign out</Button>
        {onSignOutEverywhere && (everywhere ? (
          <div role="alertdialog" aria-label="Sign out everywhere?" onKeyDown={(e) => { if (e.key === "Escape") closeEverywhere(); }} className="mt-2 space-y-2 border border-destructive/50 px-3 py-2.5 text-small">
            <p>Signs out every browser and phone signed in to this server, this one too.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="destructive" onClick={() => { setEverywhere(false); onSignOutEverywhere(); }}>Sign out everywhere</Button>
              <Button size="xs" ref={cancel} onClick={closeEverywhere}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" ref={trigger} onClick={() => setEverywhere(true)} className="mt-1 w-full justify-start text-muted-foreground hover:text-foreground">Sign out everywhere</Button>
        ))}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        {banners}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
