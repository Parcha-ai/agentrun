// Every provider, once. An order names providers by these ids; the id unions (ProviderId, SearchProvider, FetchProvider,
// a search's `provider`, a page's `via`) and the settings a Web takes are read from here, so a provider is added in its
// own file and here alone.
import type { SettingsSpec, WebProvider } from "../provider.js";
import { direct } from "./direct.js";
import { exa } from "./exa.js";
import { exaKeyless } from "./exa-keyless.js";
import { firecrawl } from "./firecrawl.js";
import { firecrawlKeyless } from "./firecrawl-keyless.js";
import { native } from "./native.js";
import { parallel } from "./parallel.js";

export const PROVIDERS = Object.freeze([parallel, exa, firecrawl, firecrawlKeyless, exaKeyless, native, direct] as const);
type Registered = (typeof PROVIDERS)[number];

export type ProviderId = Registered["id"];
type Serving<Op extends string, P = Registered> = P extends { id: infer I extends string; ops: readonly (infer O)[] } ? (Op extends O ? I : never) : never;
/** A provider an order may name for web_search, and for web_fetch. */
export type SearchProvider = Serving<"search">;
export type FetchProvider = Serving<"fetch">;
/** A provider read on the run's key (WebConfig.keys), and one whose fetch says on the page why it gave none. */
export type KeyedProvider = Registered extends infer P ? (P extends { id: infer I; key: { env: string } } ? I : never) : never;
export type SaidProvider = Registered extends infer P ? (P extends { id: infer I; fetch: { miss: "said" } } ? I : never) : never;
/** Each provider's settings, typed, by its id: those of a provider that takes any (each with its defaults, in its file). */
export type ProviderSettings = { [P in Registered as P extends { settings: SettingsSpec<unknown> } ? P["id"] : never]?: P extends { settings: SettingsSpec<infer S> } ? S : never };

const BY_ID: ReadonlyMap<string, WebProvider> = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
export const isProviderId = (id: unknown): id is ProviderId => typeof id === "string" && BY_ID.has(id);
/** The provider `id` names; a throw for an id no provider has (an order is checked when the Web is made). */
export function providerOf(id: string): WebProvider {
  const provider = BY_ID.get(id);
  if (!provider) throw new Error(`web: no provider ${JSON.stringify(id)} (the providers are ${[...BY_ID.keys()].join(", ")})`);
  return provider;
}
/** Whether `id` names a provider serving `op`. */
export const serves = (id: unknown, op: "search" | "fetch"): boolean => isProviderId(id) && providerOf(id).ops.includes(op);
/** The ids of the providers whose fetch says on the page why it gave none (SaidProvider). */
export const SAID: readonly SaidProvider[] = (PROVIDERS as readonly WebProvider[]).flatMap(({ id, fetch }) => (fetch && !fetch.ends && fetch.miss === "said" ? [id as SaidProvider] : []));

/** What is wrong with `settings`, one line each: a provider they name that takes none, or what its own check refuses. */
export function settingsProblemsOf(settings: unknown): string[] {
  if (settings === undefined) return [];
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return ["settings must be an object of each provider's settings"];
  const taking = (PROVIDERS as readonly WebProvider[]).filter((provider) => provider.settings).map(({ id }) => id);
  const named = `${taking.slice(0, -1).join(", ")} and ${taking.at(-1)}`;
  return Object.entries(settings).flatMap(([name, one]) => (one === undefined ? [] : BY_ID.get(name)?.settings?.problems(one) ?? [`settings name ${name}, which takes no settings here (${named} do)`]));
}
