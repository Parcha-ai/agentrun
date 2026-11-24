// The provider contract: one WebProvider object per provider, registered once (providers/registry.ts). createWeb makes
// each provider an order names once per Web, from the parts the run hands it, and asks it through one loop per tool
// (search.ts searchInTurn, fetch.ts webRead), each behind one breaker (search.ts searchBreaker). A provider never sees
// another provider, the order, or the model.
import type { Pay } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import type { Read, Unread } from "./page.js";
import type { Words } from "./providers/mcp.js";
import type { Breaker, Limit, SearchBounds, Searched } from "./search.js";

/** The run's own model provider's hosted search. `signal` is the caller's; it keeps its own bounds. */
export type NativeSearch = (query: string, n: number, signal?: AbortSignal) => Promise<Searched>;

/** What a Web hands a provider it makes: the run's key for it, where its requests go and through what, its settings
 *  (checked when the Web was made), the run's Pay, the clock, a product's words, a native search, the public-host guard,
 *  and a call's bounds. Each is the run's, never another provider's. */
export type ProviderParts = {
  key?: string;
  endpoint?: string;
  send?: typeof fetch;
  settings?: unknown;
  guard?: Guard;
  pay: Pay;
  now: () => number;
  words?: Words;
  native?: NativeSearch;
  bounds?: SearchBounds;
};

/** A search a call asks: the query (trimmed, at most QUERY_MAX) and how many results (1 to RESULTS_MAX). */
export type SearchAsk = { query: string; n: number };
/** A read that gave no page, in our words, and the limit it met, if any (for the run's breaker). */
export type ReadFailed = { error: string; limit?: Limit };

/** A provider made for one Web. `search`: one search, ended by `deadline` (the call's one deadline for every provider it
 *  asks) or kept on the caller's `signal` and the provider's own bound, as the provider says. `read`: one read of a page
 *  (one that passed the guard's check, unless the provider ends the order and reads through the guard itself).
 *  `unready`: why a read is not asked now, unsent (its key refused, or none where none means no turn), or undefined. */
export type ProviderRun = {
  search?(ask: SearchAsk, deadline: AbortSignal, signal?: AbortSignal): Promise<Searched>;
  read?(url: unknown, options: GuardOptions): Promise<Read | Unread | ReadFailed>;
  unready?(): string | undefined;
};

/** How a provider's fetch fits the order. `ends`: it answers whatever it reads, the order's last word (the guarded direct
 *  fetch). Otherwise `miss` says what becomes of a read it gave no page, ahead of the page another gave:
 *  - "said": the page names why under the provider's id, and the model is told; so is a turn it was not asked (unready,
 *    held, or the URL refused by the guard);
 *  - `{log, when}`: never the model's; a failed read is logged as `log`, at once with the provider and the limit it met
 *    (`when` "failed"), or once a provider that ends the order has answered, with what it did (`when` "ends"; never
 *    where none follows). A turn it was not asked is passed over unrecorded. */
export type FetchShape = { ends: true } | { ends?: false; miss: "said" } | { ends?: false; miss: { log: string; when: "failed" | "ends" } };

/** A provider's settings, typed `S`: `problems` says what is wrong with a value, one line each (none: it is S). */
export type SettingsSpec<S> = { problems(value: unknown): string[]; readonly typed?: S };
export const settingsOf = <S>(problems: (value: unknown) => string[]): SettingsSpec<S> => ({ problems });

/** One provider: its `id` (what an order names), its `label` in our words, the variable its key is read from, the tools
 *  it serves, what its fetch does where it serves web_fetch, its settings where it takes any, and `make`, the provider
 *  for one Web. */
export type WebProvider<Id extends string = string> = {
  id: Id;
  label: string;
  key?: { env: string };
  ops: readonly ("search" | "fetch")[];
  fetch?: FetchShape;
  settings?: SettingsSpec<unknown>;
  make(parts: ProviderParts): ProviderRun;
};

/** A provider as registered: `meta` (its id, ops, fetch shape, key and settings kept as literals, for the registry's
 *  unions) and `make`. Two arguments, so the unions are read from `meta` alone, never from what `make` answers. */
export const defineProvider = <const M extends Omit<WebProvider, "make">>(meta: M, make: WebProvider["make"]): M & Pick<WebProvider, "make"> => ({ ...meta, make });

/** A provider's reads behind `breaker`: `held` is why it is not asked now (unready, else the breaker holding it), and a
 *  failed read's limit trips the breaker. The fetch's breaker is search's (searchBreaker). */
export type Reader = { held(): string | undefined; read(url: unknown, options: GuardOptions): Promise<Read | Unread | ReadFailed> };
export function readerOf(run: ProviderRun, breaker: Breaker): Reader {
  const read = run.read;
  if (!read) throw new Error("readerOf: the provider has no read");
  return {
    held: () => run.unready?.() ?? (breaker.held() ? "not tried: held by its limit" : undefined),
    async read(url, options) {
      const got = await read(url, options);
      if (!("ok" in got) && got.limit) breaker.read({ answer: { error: got.error }, limit: got.limit });
      return got;
    },
  };
}
