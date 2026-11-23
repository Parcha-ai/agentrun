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

/** Whether a template runs free, by its package's own mark: its `free` tag, or a model it prefers or offers as a choice
 *  that is one of this server's free models. */
export function runsFree(t: TemplateView, harnesses: readonly HarnessInfo[] | undefined): boolean {
  if (t.tags.includes("free")) return true;
  const free = new Set(freeModels(harnesses).map((m) => m.id));
  return [t.model?.prefer, ...(t.model?.choices ?? []).map((c) => c.model)].some((id) => !!id && free.has(id));
}

/** The free model "Use free" applies a template on: the free default of the first of its harnesses that has one (with
 *  none named, the shelf's harness). Null where none does. */
export function freeModelFor(t: TemplateView, harnesses: readonly HarnessInfo[] | undefined): string | null {
  for (const h of t.harness?.length ? t.harness : [freeHarness(harnesses) ?? "pi"]) {
    const model = freeDefault(harnesses, h);
    if (model) return model;
  }
  return null;
}

/** A template's Apply screen with the agent's model set (apply's `overrides.model`). */
export const freeApplyHash = (id: string, model: string) => `#/templates/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}`;
