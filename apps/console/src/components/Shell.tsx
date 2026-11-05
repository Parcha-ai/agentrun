import { Brain, ChevronDown, Code, Hammer, History, LayoutGrid, LogOut, Menu, Monitor, Moon, Settings, Sun } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ConnectionBanner } from "@/components/Connection";
import { DojoIcon } from "@/components/DojoIcon";
import { cn } from "@/lib/utils";
import { applyTheme, currentTheme, saveTheme, type Theme, THEMES } from "@/lib/theme";

export type Section = "mission" | "playground" | "agents" | "runs" | "dojo" | "settings";

const ROUTES: Record<Section, string> = { mission: "#/", playground: "#/playground", agents: "#/agents", runs: "#/runs", dojo: "#/dojo", settings: "#/settings/keys" };
const THEME_LABEL: Record<Theme, [string, typeof Brain]> = { system: ["System", Monitor], light: ["Light", Sun], dark: ["Dark", Moon] };

/** System (the OS's), Light or Dark: a pick shows at once and is kept in this browser (lib/theme). */
function ThemeSwitch() {
  // The pick in force: kept in this browser, or held on this page when the storage refused it.
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const pick = (t: Theme) => { saveTheme(t); applyTheme(t); setTheme(t); };
  return (
    <div role="group" aria-label="Theme" className="flex gap-1 rounded-lg border p-1">
      {THEMES.map((t) => {
        const [label, Icon] = THEME_LABEL[t];
        return (
          <button key={t} type="button" aria-label={label} title={label} aria-pressed={theme === t} onClick={() => pick(t)}
            className={cn("flex flex-1 items-center justify-center rounded-md py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", theme === t && "bg-accent text-foreground")}>
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function Wordmark() {
  return <span className="inline-flex items-center whitespace-nowrap text-[17px] font-semibold [font-family:monospace]" aria-label="AgentRun">
    <svg viewBox="0 0 64 64" className="mr-1 size-[17px] text-primary" aria-hidden><path d="M18 12L42 32L18 52" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square" strokeLinejoin="miter" /></svg>
    agent<span className="text-primary">.run()</span>
  </span>;
}

export type ShellProps = { active: Section; settings?: boolean; building?: boolean; onBuild?: () => void; onNavigate?: (s: Section) => void; onSignOut?: () => void; children: ReactNode };

/** The hosted console's workspace shell, with only destinations this server supports. The logo row aligns with
 * the 48px page toolbar. Agent creation, management and history share the expandable Agents section. */
export function Shell({ active, settings = false, building = false, onBuild, onNavigate, onSignOut, children }: ShellProps) {
  const [open, setOpen] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const agentsActive = active === "agents" || active === "runs";
  useEffect(() => { if (agentsActive || building) setAgentsExpanded(true); }, [active, building]);
  const navigate = (section: Section) => { if (onNavigate) onNavigate(section); else location.hash = ROUTES[section]; setOpen(false); };
  const build = () => { if (onBuild) onBuild(); else location.hash = "#/agents/new"; setOpen(false); };
  const navStyle = (selected: boolean, child = false) => cn("flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] leading-5 transition-colors hover:bg-foreground/5", child ? "min-h-8 py-1.5 pl-[34px]" : "min-h-9 py-2", selected && "bg-primary/[0.06] text-primary");
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 md:hidden">
        <button type="button" onClick={() => navigate("mission")} aria-label="AgentRun home"><Wordmark /></button>
        <button type="button" className="rounded-lg border p-2" aria-label="Navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Menu className="size-[18px]" aria-hidden /></button>
      </header>
      <aside className={cn("shrink-0 flex-col border-r bg-background md:flex md:h-dvh md:w-[220px]", open ? "flex max-h-[60dvh] overflow-y-auto border-b md:max-h-none" : "hidden")}>
        <div className="hidden h-12 shrink-0 items-center border-b px-4 md:flex">
          <button type="button" onClick={() => navigate("mission")} aria-label="AgentRun home"><Wordmark /></button>
        </div>
        <nav aria-label="Navigation" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3">
          <div className="space-y-0.5">
            <button type="button" className={navStyle(active === "mission")} aria-current={active === "mission" ? "page" : undefined} onClick={() => navigate("mission")}><LayoutGrid className="size-4 shrink-0" aria-hidden />Mission Control</button>
            <button type="button" className={navStyle(active === "playground")} aria-current={active === "playground" ? "page" : undefined} onClick={() => navigate("playground")}><Code className="size-4 shrink-0" aria-hidden />API playground</button>
            <div>
              <button type="button" className={cn(navStyle(false), agentsActive && "text-primary")} aria-expanded={agentsExpanded} aria-controls="agent-navigation" onClick={() => setAgentsExpanded((value) => !value)}>
                <Brain className="size-4 shrink-0" aria-hidden /><span className="flex-1">Agents</span><ChevronDown className={cn("size-3.5 transition-transform", !agentsExpanded && "-rotate-90")} aria-hidden />
              </button>
              <div id="agent-navigation" hidden={!agentsExpanded} className="space-y-0.5">
                <button type="button" className={navStyle(building, true)} aria-current={building ? "page" : undefined} onClick={build}><Hammer className="size-3.5 shrink-0" aria-hidden />Build</button>
                <button type="button" className={navStyle(active === "agents" && !building, true)} aria-current={active === "agents" && !building ? "page" : undefined} onClick={() => navigate("agents")}><Brain className="size-3.5 shrink-0" aria-hidden />Connected agents</button>
                <button type="button" className={navStyle(active === "runs", true)} aria-current={active === "runs" ? "page" : undefined} onClick={() => navigate("runs")}><History className="size-3.5 shrink-0" aria-hidden />Runs</button>
              </div>
            </div>
            <button type="button" className={navStyle(active === "dojo")} aria-current={active === "dojo" ? "page" : undefined} onClick={() => navigate("dojo")}><DojoIcon size={16} className="shrink-0" />Agent Dojo</button>
          </div>
          {settings && <div data-sidebar-account className="mt-auto border-t pb-2 pt-3">
            <button type="button" className={navStyle(active === "settings")} aria-current={active === "settings" ? "page" : undefined} onClick={() => navigate("settings")}><Settings className="size-4 shrink-0" aria-hidden />Settings</button>
          </div>}
        </nav>
        <div className="shrink-0 space-y-2 px-3 pb-4 pt-3">
          <ThemeSwitch />
          <button type="button" onClick={onSignOut} className="caps flex min-h-9 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-[12px] hover:bg-accent"><LogOut className="size-4" aria-hidden />Sign out</button>
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
