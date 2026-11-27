// The provider contract: one WebProvider object per provider, registered once (providers/registry.ts). createWeb makes
// each provider an order names once per Web, from the parts the run hands it, and asks it through one loop per tool
// (search.ts searchInTurn, fetch.ts webRead), each behind one breaker (search.ts searchBreaker). A provider never sees
// another provider, the order, or the model.
import type { Pay } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import type { Read, Unread } from "./page.js";
import type { Words } from "./providers/mcp.js";
import { type Breaker, type Failure, failure, type Holding, type Limit, type SearchAsk, type SearchBounds, type Searched } from "./search.js";

export type { SearchAsk };

/** The run's own model provider's hosted search, asked one query (a search's first). `signal` is the caller's; it keeps
 *  its own bounds. */
export type NativeSearch = (query: string, n: number, signal?: AbortSignal) => Promise<Searched>;

/** What a Web hands a provider it makes: the run's key for it, where its requests go and through what, its settings
 *  (checked when the Web was made), the run's Pay, the clock, a product's words, a native search, the public-host guard,
 *  a call's bounds, and the client the run knows of (WebClient). Each is the run's, never another provider's. */
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
  client?: WebClient;
};
/** What a run knows of the agent calling the web tools, each only where known, never made up: `model`, the id of the
 *  model that writes the searches and reads their results; `session`, the run's id, the one session of every search the
 *  run makes. */
export type WebClient = { model?: string; session?: string };
/** A read's options: the guard's, and `client`, the call's own, each field in place of the Web's where given. */
export type ReadOptions = GuardOptions & { client?: WebClient };

/** A read that gave no page: in our words, the failure typed (search.ts Failed; a stand-in's may give the words alone),
 *  and the limit it met, if any (for the run's breaker). */
export type ReadFailed = { error: string; failure?: Failure; limit?: Limit };

/** A provider made for one Web. `search`: one search, ended by `deadline` (the call's one deadline for every provider it
 *  asks) or kept on the caller's `signal` and the provider's own bound, as the provider says; `bounds`, the call's own,
 *  each in place of the Web's (ProviderParts.bounds) where given; `client`, the call's own, each field in place
 *  of the Web's (ProviderParts.client) where given. `read`: one read of a page
 *  (one that passed the guard's check, unless the provider ends the order and reads through the guard itself).
 *  `unready`: why a read is not asked now, unsent (its key refused, or none where none means no turn), typed, or
 *  undefined. */
export type ProviderRun = {
  search?(ask: SearchAsk, deadline: AbortSignal, signal?: AbortSignal, bounds?: SearchBounds, client?: WebClient): Promise<Searched>;
  read?(url: unknown, options: ReadOptions): Promise<Read | Unread | ReadFailed>;
  unready?(): Failure | undefined;
};

/** How a provider's fetch fits the order. `ends`: it answers whatever it reads, the order's last word (the guarded direct
 *  fetch). Otherwise the page names why the provider gave none under its id, and the model is told: a read that gave no
 *  page, and a turn it was not asked for being unready or held. `miss` says what more becomes of it:
 *  - "said": a turn the guard's check refused is told too;
 *  - `{log, when}`: a failed read is logged as `log`, at once with the provider and the limit it met (`when` "failed"),
 *    or once a provider that ends the order has answered, with what it did (`when` "ends"; never where none follows).
 *  Every turn not asked is on the receipt as search's is: one its breaker held as outcome "held", its failure the hold;
 *  any other (unready, or the guard's refusal) as a failed turn saying why. */
export type FetchShape = { ends: true } | { ends?: false; miss: "said" } | { ends?: false; miss: { log: string; when: "failed" | "ends" } };

/** A provider's settings, typed `S`: `problems` says what is wrong with a value, one line each (none: it is S). */
export type SettingsSpec<S> = { problems(value: unknown): string[]; readonly typed?: S };
export const settingsOf = <S>(problems: (value: unknown) => string[]): SettingsSpec<S> => ({ problems });

/** One provider: its `id` (what an order names), its `label` in our words, the variable its key is read from, `keyless`
 *  where it is the free use of a service another provider reads on a key, the tools it serves, what its fetch does where
 *  it serves web_fetch, its settings where it takes any, and `make`, the provider for one Web. */
export type WebProvider<Id extends string = string> = {
  id: Id;
  label: string;
  key?: { env: string };
  keyless?: true;
  ops: readonly ("search" | "fetch")[];
  fetch?: FetchShape;
  settings?: SettingsSpec<unknown>;
  make(parts: ProviderParts): ProviderRun;
};

/** A provider as registered: `meta` (its id, ops, fetch shape, key and settings kept as literals, for the registry's
 *  unions) and `make`. Two arguments, so the unions are read from `meta` alone, never from what `make` answers. */
export const defineProvider = <const M extends Omit<WebProvider, "make">>(meta: M, make: WebProvider["make"]): M & Pick<WebProvider, "make"> => ({ ...meta, make });

/** The code of a turn not asked because its breaker holds the provider (Reader.held). */
export const HELD_CODE = "HELD";

/** When a breaker holding a provider lets it be asked again, in words: until the minute it names (UTC), or for the rest
 *  of the run. */
export function holdingWords({ kind, until }: Holding): string {
  const what = kind === "rate" ? "rate-limited" : "out of quota";
  return Number.isFinite(until) ? `${what} until ${new Date(Math.ceil(until / 60_000) * 60_000).toISOString().slice(11, 16)} UTC` : `${what} for the rest of this run`;
}

/** A provider's reads behind `breaker`: `held` is why it is not asked now, typed (unready, else the breaker holding it:
 *  its limit's kind, code HELD, and until when, holdingWords), `holding` what holds the breaker, and a failed read's limit
 *  trips the breaker. The fetch's breaker is search's (searchBreaker). */
export type Reader = { held(): Failure | undefined; holding?(): Holding | undefined; read(url: unknown, options: ReadOptions): Promise<Read | Unread | ReadFailed> };
export function readerOf(run: ProviderRun, breaker: Breaker): Reader {
  const read = run.read;
  if (!read) throw new Error("readerOf: the provider has no read");
  return {
    held() {
      const unready = run.unready?.();
      if (unready) return unready;
      const holding = breaker.holding();
      return holding ? failure(holding.kind, HELD_CODE, `not tried: ${holdingWords(holding)}`) : undefined;
    },
    holding: () => breaker.holding(),
    async read(url, options) {
      const got = await read(url, options);
      if (!("ok" in got) && got.limit) breaker.read({ answer: { error: got.error }, limit: got.limit, ...(got.failure ? { failure: got.failure } : {}) });
      return got;
    },
  };
}
