import { contextSize, type HarnessInfo, isLocalModel, modelLabel } from "./models";
import type { TemplateView } from "./v2";

// The Free shelf (components/FreeShelf.tsx): what runs for $0 on this server, read from what the console already reads.
// The free models are capabilities' `harnesses[].free_models`; the web tools are capabilities' `tools[]` web_search and
// web_fetch, their `resolves` and `why`; the agents are GET /v2/templates. Nothing here is a second copy of the server's.

/** A free model as the shelf lists it: its id, its words (`qwen3:8b · local (Ollama)`), whether it runs on this machine's
 *  Ollama, and its context window. */
export type ShelfModel = { id: string; label: string; local: boolean; context: string; context_window: number };

/** Every free model this server offers on any harness, once each: the ones on this machine's Ollama first, then the
 *  catalog's, each group in the order the server lists them. Empty before capabilities are read. */
export function freeModels(harnesses: readonly HarnessInfo[] | undefined, routePrefix?: string | null): ShelfModel[] {
  const seen = new Map<string, number>();
  for (const h of harnesses ?? []) for (const m of h.free_models ?? []) if (!seen.has(m.id)) seen.set(m.id, m.context_window);
  const all = [...seen].map(([id, context_window]): ShelfModel => ({ id, label: modelLabel(id, routePrefix).text, local: isLocalModel(id), context: contextSize(context_window), context_window }));
  return [...all.filter((m) => m.local), ...all.filter((m) => !m.local)];
}

/** The model "Use free" puts an agent on, on `harness`: its default model when that one is free, else its first free
 *  model, a local one first. Null where the harness has no free model here. */
export function freeDefault(harnesses: readonly HarnessInfo[] | undefined, harness: string): string | null {
  const h = harnesses?.find((x) => x.id === harness);
  const free = h?.free_models ?? [];
  if (!free.length) return null;
  if (h?.default_model && free.some((m) => m.id === h.default_model)) return h.default_model;
  return (free.find((m) => isLocalModel(m.id)) ?? free[0]).id;
}

/** The harness the shelf's free models run on: the first available one with a free model, pi first. */
export function freeHarness(harnesses: readonly HarnessInfo[] | undefined): string | null {
  const free = (harnesses ?? []).filter((h) => h.available !== false && h.free_models?.length);
  return (free.find((h) => h.id === "pi") ?? free[0])?.id ?? null;
}

/** A web tool as the shelf says it: what it resolves to on the harness (`firecrawl-keyless`, `exa-keyless`, `native`,
 *  `kernel`, `unavailable: …`), and the server's own sentence for why, never reworded. */
export type ShelfTool = { name: string; resolves: string; why: string };
const WEB_TOOLS = ["web_search", "web_fetch"] as const;

/** web_search then web_fetch, as capabilities' `tools` resolve them on `harness`; one it does not resolve there is left
 *  out. */
export function webTools(tools: unknown, harness: string): ShelfTool[] {
  const list = Array.isArray(tools) ? tools as { name?: unknown; resolves?: Record<string, unknown>; why?: Record<string, unknown> }[] : [];
  return WEB_TOOLS.flatMap((name): ShelfTool[] => {
    const t = list.find((x) => x?.name === name);
    const resolves = t?.resolves?.[harness], why = t?.why?.[harness];
    return typeof resolves === "string" && typeof why === "string" ? [{ name, resolves, why }] : [];
  });
}

/** Whether a template asks for nothing that costs money besides its model: no key (`secrets`), no MCP toolkit (`mcp`, or a
 *  tool named `mcp:…`), no Monid endpoint (`monid:…`, booked on the server's Monid key, which apply asks for only where
 *  the server holds none), no browser tool, and no computer but this server's own Docker sandbox or none. A package's
 *  tags are its author's own claim, and "Use free" swaps only the model. */
export function asksNothingPaid(t: TemplateView): boolean {
  if (t.secrets.length || t.mcp.length) return false;
  if ((t.tools ?? []).some((name) => name.startsWith("mcp:") || name.startsWith("monid:") || name.startsWith("browser"))) return false;
  const here = t.computer_here;
  if (!here?.computer) return true;
  if (here.computer.kind === "sandbox") return here.computer.provider === "docker";
  return here.computer.kind === "none" && here.shell === null;
}

/** Whether a template runs free here: it asks for nothing paid besides its model (asksNothingPaid), a `subagent` it grants
 *  runs on free models only, and its package marks it free (its `free` tag) or prefers or offers as a choice one of this
 *  server's free models, a choice that needs no key. A subagent call runs on the package's model for its tier (`fast`,
 *  `strong`), which "Use free" keeps, else the host's for the tier, which the console can't read: both must be named, and
 *  free here. */
export function runsFree(t: TemplateView, harnesses: readonly HarnessInfo[] | undefined): boolean {
  if (!asksNothingPaid(t)) return false;
  const free = new Set(freeModels(harnesses).map((m) => m.id));
  if ((t.tools ?? []).includes("subagent") && ![t.model?.fast, t.model?.strong].every((id) => !!id && free.has(id))) return false;
  if (t.tags.includes("free")) return true;
  return [t.model?.prefer, ...(t.model?.choices ?? []).filter((c) => !c.secrets.length).map((c) => c.model)].some((id) => !!id && free.has(id));
}

/** The harness apply makes a template's agent on, as the server picks it (server.ts, apply): the first of its harnesses
 *  available here, else its first; with none named, the server's default harness (pi). */
export function applyHarness(t: TemplateView, harnesses: readonly HarnessInfo[] | undefined): string {
  if (!t.harness?.length) return "pi";
  return t.harness.find((id) => harnesses?.some((h) => h.id === id && h.available)) ?? t.harness[0]!;
}

/** The free model "Use free" applies a template on: the free default of the harness apply will make its agent on
 *  (applyHarness), so the agent runs what it is given. Null where that harness has none: another harness's free model
 *  would make an agent that can't run it. */
export function freeModelFor(t: TemplateView, harnesses: readonly HarnessInfo[] | undefined): string | null {
  return freeDefault(harnesses, applyHarness(t, harnesses));
}

/** A template's Apply screen with the agent's model set (apply's `overrides.model`). */
export const freeApplyHash = (id: string, model: string) => `#/templates/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}`;
