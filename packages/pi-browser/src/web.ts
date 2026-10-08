// The `web` pi-durable extension: web_fetch and web_search over the host's providers. Sessionless, so both run in
// parallel and rerun after a crash; each result carries its price as pi usage.
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool, type ConversationId, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { WEB_TOOLS } from "./core/contract.js";
import type { Decisions } from "./core/decisions.js";
import type { EvidenceSink } from "./core/evidence.js";
import type { FetchRequest, FetchResult, PriceTable, SearchRequest, SearchResult } from "./core/host.js";
import { createWebTools, type RenderedPage, type WebBackup, type WebOutcome, type WebToolsOptions } from "./core/web.js";

export type WebExtensionOptions = {
  providers: {
    /** Names the source in `via` (`<name>_fetch`, `<name>_search`); default "provider". */
    name?: string;
    fetch?: (request: FetchRequest, signal?: AbortSignal) => Promise<FetchResult>;
    search?: (request: SearchRequest, signal?: AbortSignal) => Promise<SearchResult>;
  };
  evidence: EvidenceSink;
  /** Per use, like `workspace`: the evidence label of a conversation and whether its fetches go through proxies.
   *  Default: label "web", proxies on. */
  scope?: (conversationId: ConversationId) => { label: string; proxies: boolean } | Promise<{ label: string; proxies: boolean }>;
  prices?: Partial<PriceTable>;
  redact?: { values: () => readonly string[] };
  /** The host's fallback fetchers, tried in order when the provider cannot fetch a page. */
  backups?: ReadonlyArray<WebBackup>;
  decisions?: Pick<Decisions, "classifyPage">;
  /** Reading a page the fetch could not through a browser the host runs for reading; off unless `enabled`. */
  render?: { enabled: boolean; read(url: string, signal?: AbortSignal): Promise<RenderedPage> };
  /** The text of a PDF the provider would not convert to markdown (WebToolsOptions["pdf"]): without it, the failure names the
   *  PDF and the `format: "raw"` route. */
  pdf?: WebToolsOptions["pdf"];
  /** Host text for a `web` section, rendered for a conversation offered web_fetch or web_search. None without it. */
  section?: { addendum?: string };
};

const usage = (usd: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });

export function createWebExtension(options: WebExtensionOptions): { extension: ReturnType<typeof defineExtension>; tools: readonly ToolRegistration[] } {
  const tools = createWebTools({
    name: options.providers.name ?? "provider",
    fetch: options.providers.fetch,
    search: options.providers.search,
    evidence: options.evidence,
    scope: options.scope ?? (() => ({ label: "web", proxies: true })),
    prices: options.prices,
    redact: options.redact,
    backups: options.backups,
    classifyPage: options.decisions?.classifyPage,
    render: options.render,
    pdf: options.pdf,
  });
  const run = { web_fetch: tools.fetch, web_search: tools.search } as const;
  const result = ({ text, isError, details, usd }: WebOutcome) => ({ content: [{ type: "text" as const, text }], isError, details: details as JsonValue, usage: usage(usd) });
  const registrations = WEB_TOOLS
    // web_fetch is offered when any source can fetch: the provider, a render the host enabled, or a backup.
    .filter((tool) => (tool.listedWhen === "fetch" ? options.providers.fetch || options.render?.enabled || options.backups?.length : options.providers.search))
    .map((tool) => defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as TSchema,
      replay: tool.replay,
      executionMode: tool.executionMode,
      execute: async (args: Record<string, unknown>, api, context) => result(await run[tool.name as keyof typeof run](api.conversationId, args, context.abortSignal)),
    }));
  // The host's text, rendered only for a conversation offered one of the web tools, matched by name: another
  // extension's tool registered under the same name would carry it too.
  const names = new Set(registrations.map((tool) => tool.name));
  const addendum = options.section?.addendum;
  const sections: PromptSection[] = addendum ? [{ key: "web", render: async (input) => (input.agent.tools.some((tool) => names.has(tool.name)) ? addendum : undefined) }] : [];
  return { extension: defineExtension({ name: "web", tools: registrations, sections }), tools: registrations };
}
