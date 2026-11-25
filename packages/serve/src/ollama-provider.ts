// Ollama as a model provider: the models the Ollama on this machine (or the one OLLAMA_HOST names) has pulled, listed live
// from its own API, run by pi and by every harness on a wire the route translates (wires.ts TRANSLATED), at $0, on
// Ollama's native chat API. No key: Ollama has none.
//   Where: OLLAMA_HOST, Ollama's own variable, read as the ollama CLI reads it (ollamaBase), from the server's environment,
//     never from a provider's auth context, so it is never a held secret. Unset, the server names the default address
//     itself only on one owner's own machine (ollamaHostOf); unset anywhere else, no Ollama is asked. Plain http only to this machine (provider.ts
//     gatewayBase, the one base rule); anything else needs https.
//   Which models: GET /api/tags, then POST /api/show for each, whose `capabilities` say whether it chats (`completion`),
//     takes tools (`tools`) and thinks (`thinking`), and whose model_info's `<family>.context_length` is the context it was
//     trained on. Nothing is hardcoded. A model with no `tools` capability takes its tools as text (local-models.ts ToolsAs,
//     on the runner's translated route).
//   Wire: POST /api/chat, streamed as NDJSON. Its OpenAI-compatible API cannot set the context size, and Ollama's own
//     default context is small, so every request names it: options.num_ctx, the model's trained context up to 64k
//     (OLLAMA_NUM_CTX), and the model's window here is that same number.
// Listing never stalls a caller: one short deadline for the whole listing, no redirects, and a down, hung or refused Ollama
// throws nothing. Each address's answer is kept (OLLAMA_TTL_MS) and refreshed behind the caller; a failed ask is no
// answer: the models kept before it stay (none for a refused one: that Ollama is down), and are asked again at the next
// call (listOllama).
import { AsyncLocalStorage } from "node:async_hooks";
import { calculateCost, collapseSystemMessages, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ToolsAs } from "./local-models.js";
import { gatewayBase } from "./provider.js";

/** The provider's id, the prefix of its models' refs (`ollama/<tag>`). */
export const OLLAMA_PROVIDER = "ollama";
/** The api its models name: Ollama's own chat API, neither Responses nor Messages, so the runner's route translates it. */
export const OLLAMA_API = "ollama-chat";
/** The most context a request asks Ollama for (options.num_ctx), and so the most window a model has here: 64k. */
export const OLLAMA_NUM_CTX = 65_536;
/** How long a listing may take, all of it: a stuck Ollama costs a caller this only where nothing is kept for its address
 *  (ollamaModels); after that it is asked behind its callers. */
export const OLLAMA_LIST_TIMEOUT_MS = 2_000;
/** How long an address's listing is kept before it is asked again (behind the caller, which takes the kept one). A
 *  failed ask is never kept fresh (listOllama). */
export const OLLAMA_TTL_MS = 30_000;
/** Ollama's port, where OLLAMA_HOST names none and no scheme. */
const OLLAMA_PORT = "11434";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** A model as Ollama lists it: its tag, its capabilities, and the context it was trained on (undefined: /api/show says none). */
export type OllamaListed = { readonly name: string; readonly capabilities: readonly string[]; readonly trained: number | undefined };

/**
 * The base URL OLLAMA_HOST names, as the ollama CLI reads it (envconfig.Host): unset, this machine on 11434; with no
 * scheme, http; with no port, 11434 with no scheme and the scheme's own with one (https: 443); a path kept. `0.0.0.0` and
 * `::`, where `ollama serve` listens on every address, connect to this machine. Then the one base rule (provider.ts
 * gatewayBase): plain http only to this machine, no user, query or fragment. Throws, naming OLLAMA_HOST, when refused.
 */
export function ollamaBase(env: NodeJS.ProcessEnv): string {
  const given = (env.OLLAMA_HOST ?? "").trim();
  const cut = given.indexOf("://");
  const scheme = cut < 0 ? "http" : given.slice(0, cut).toLowerCase();
  const rest = cut < 0 ? given : given.slice(cut + 3);
  const slash = rest.indexOf("/");
  const hostport = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash);
  // A user before the host: the base rule refuses it, in its words.
  if (hostport.includes("@")) return gatewayBase("OLLAMA_HOST", `${scheme}://${rest}`);
  const defaultPort = cut < 0 ? OLLAMA_PORT : scheme === "https" ? "443" : scheme === "http" ? "80" : OLLAMA_PORT;
  let [host, port] = splitHostPort(hostport);
  if (!/^\d{1,5}$/.test(port ?? "") || Number(port) > 65_535) port = defaultPort;
  if (host === "" || host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  return gatewayBase("OLLAMA_HOST", `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}${path}`);
}

/** `host:port`, `[v6]:port`, `[v6]`, a bare IPv6 address or a host alone, as Go's net.SplitHostPort and the CLI's fallback
 *  read them: the host (brackets off) and the port, undefined where none is named. */
function splitHostPort(hostport: string): [string, string | undefined] {
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(hostport);
  if (bracketed) return [bracketed[1]!, bracketed[2]];
  const colons = hostport.split(":").length - 1;
  if (colons === 1) {
    const [host, port] = hostport.split(":") as [string, string];
    return [host, port];
  }
  return [hostport, undefined];
}

/** Each address's last listing, by base URL (`at` -Infinity: a failed ask's, stale at once), and the listing under way
 *  for it. */
const kept = new Map<string, { at: number; models: readonly OllamaListed[] }>();
const asking = new Map<string, Promise<readonly OllamaListed[]>>();
/** Bumped by ollamaForget, per address: a listing asked before a forget answers its caller but is never kept, since it
 *  may be from before the pull that made the forget. */
const forgets = new Map<string, number>();
/** The clock a listing is kept by: Date.now, or a test's (ollamaClock). */
let now: () => number = Date.now;

/** A test's clock for the kept listings, so it ages them without waiting; with none, Date.now again. */
export function ollamaClock(clock?: () => number): void {
  now = clock ?? Date.now;
}

/** The listing under way for the Ollama `env` names (one a stale answer started behind its caller), or undefined: for a
 *  test to await what a refresh brings. */
export function ollamaAsking(env: NodeJS.ProcessEnv): Promise<readonly OllamaListed[]> | undefined {
  const base = baseOf(env);
  return base === undefined ? undefined : asking.get(base);
}

/** Set inside ollamaReading: a reading no run waits on. */
const reading = new AsyncLocalStorage<true>();

/** `read` as a reading no run waits on: the offers and the server's model needs, made again at each key save
 *  (harness.ts harnessOffers, server.ts needsOf). Inside it, ollamaShown answers from the kept listing at any age, which
 *  is the listing the offers are made from, and asks Ollama nothing when one is kept. So a save never waits on one
 *  /api/show per model of a stuck Ollama. A run's own choice is never made inside it. */
export const ollamaReading = <T>(read: () => Promise<T>): Promise<T> => reading.run(true, read);

/** What marks an Ollama cloud model (a `-cloud` tag): it runs on `remote_host` (ollama.com) as `remote_model`. */
type Remote = { remote_host?: unknown; remote_model?: unknown };
/** Whether an /api/tags or /api/show entry is a cloud model's. Its prompts leave this machine, so it is never listed: the
 *  models here are local, $0 and uncounted, and a cloud model is none of those. */
const remote = (entry: Remote | null | undefined): boolean => entry?.remote_host !== undefined || entry?.remote_model !== undefined;

/** A test process's switch, read from its own environment (process.env), never from the `env` a caller passes: set, no
 *  Ollama is asked, whatever address that `env` names or leaves to the default. A test hook's name (model.ts FAUX_PREFIX),
 *  so a server never hands it on to its runs. The test suites set it (test/support.mjs); a test of Ollama clears it. */
export const OLLAMA_OFF_ENV = "AGENTRUN_SERVE_FAUX_NO_OLLAMA";

/** Ollama's own default address (ollamaBase of an unset OLLAMA_HOST). */
export const OLLAMA_DEFAULT_HOST = `127.0.0.1:${OLLAMA_PORT}`;

/**
 * The OLLAMA_HOST a server asks, and hands the runner beside it: the one its environment sets, else Ollama's default
 * address on one owner's own server on their own machine (`ownMachine`: server.ts whyNotOwnMachine, the rule
 * --harness-sign-in starts under), else none. On a shared server, whatever answers on this machine's 11434 is no model of
 * the people who start runs there, so it is asked only where its operator names it.
 */
export function ollamaHostOf(env: NodeJS.ProcessEnv, ownMachine: boolean): string | undefined {
  const given = env.OLLAMA_HOST?.trim();
  return given ? given : ownMachine ? OLLAMA_DEFAULT_HOST : undefined;
}

/** Why the OLLAMA_HOST `env` names is refused (ollamaBase's words, which never hold its value), or undefined. */
export function ollamaHostRefused(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.OLLAMA_HOST?.trim()) return undefined;
  try {
    ollamaBase(env);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The base OLLAMA_HOST names, or undefined where it names none (a server names the default where it may: ollamaHostOf),
 *  is refused (ollamaBase) or the test switch is on (OLLAMA_OFF_ENV). */
const baseOf = (env: NodeJS.ProcessEnv): string | undefined => {
  if (process.env[OLLAMA_OFF_ENV] || !env.OLLAMA_HOST?.trim()) return undefined;
  try {
    return ollamaBase(env);
  } catch {
    return undefined;
  }
};

/** A request to the Ollama at `base`, under `signal`, following no redirect: its JSON answer, or a throw. */
const askerOf = (base: string, send: typeof fetch, signal: AbortSignal) => async (path: string, body?: unknown): Promise<unknown> => {
  const response = await send(`${base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};

/** Model `name` as /api/show reports it (`ask`): its capabilities and trained context. Undefined where it does not answer
 *  (a refusal, a wrong shape, the deadline) or names a cloud model. */
async function shownOf(ask: ReturnType<typeof askerOf>, name: string): Promise<OllamaListed | undefined> {
  try {
    const show = (await ask("/api/show", { model: name })) as ({ capabilities?: unknown; model_info?: Record<string, unknown> } & Remote) | null;
    if (remote(show)) return undefined;
    // An Ollama from before /api/show said capabilities chats, with its tools as text.
    const capabilities = Array.isArray(show?.capabilities) ? show.capabilities.filter((c): c is string => typeof c === "string") : ["completion"];
    const length = Object.entries(show?.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
    return { name, capabilities, trained: typeof length === "number" && Number.isSafeInteger(length) && length > 0 ? length : undefined };
  } catch {
    return undefined;
  }
}

/**
 * The models the Ollama `env` names has, asked now: its tags (/api/tags), each one's capabilities and trained context
 * (/api/show), in the order Ollama lists them. All of it within `timeoutMs`, with no redirect followed; nothing is thrown.
 * A model /api/show refuses is left out and the others kept; so is a cloud model (remote_host or remote_model, in either
 * answer). The answer is kept for its address (ollamaModels, ollamaKept), fresh for OLLAMA_TTL_MS. A failed ask (a
 * hung Ollama, an /api/tags of the wrong shape, or the deadline passing before every /api/show answered) is no listing:
 * the address keeps the models it had (none kept, what this ask got), stale at once, so the next caller takes them and
 * asks again behind it. A refused connection is an Ollama that is down: its address keeps none, stale too. `fetch`: a
 * test's.
 */
export async function listOllama(env: NodeJS.ProcessEnv, { fetch: send = globalThis.fetch, timeoutMs = OLLAMA_LIST_TIMEOUT_MS }: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<readonly OllamaListed[]> {
  const base = baseOf(env);
  if (base === undefined) return [];
  const deadline = AbortSignal.timeout(timeoutMs);
  const ask = askerOf(base, send, deadline);
  const asked = forgets.get(base) ?? 0;
  let models: readonly OllamaListed[] = [];
  let whole = false;
  let down = false;
  try {
    const tags = (await ask("/api/tags")) as { models?: ({ name?: unknown; model?: unknown } & Remote)[] } | null;
    if (!Array.isArray(tags?.models)) throw new Error("/api/tags: no models list");
    const names = tags.models.filter((tag) => !remote(tag)).map((tag) => tag?.name ?? tag?.model).filter((name): name is string => typeof name === "string" && name.length > 0);
    models = (await Promise.all(names.map((name) => shownOf(ask, name)))).filter((model): model is OllamaListed => model !== undefined);
    whole = !deadline.aborted;
  } catch (error) {
    down = refused(error);
  }
  const before = kept.get(base)?.models;
  const listing = whole ? { at: now(), models } : { at: -Infinity, models: !down && before?.length ? before : models };
  // A forget since this listing was asked: it answers its caller, and is never kept.
  if ((forgets.get(base) ?? 0) === asked) kept.set(base, listing);
  return listing.models;
}

/** Whether `error` is a refused connection (ECONNREFUSED anywhere in its causes): nothing listens at the address. */
function refused(error: unknown): boolean {
  for (let at = error; at instanceof Error; at = at.cause) {
    if ((at as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
    if (at instanceof AggregateError && at.errors.some(refused)) return true;
  }
  return false;
}

/** How long a run gives the /api/show of the one Ollama model it names (ollamaShown): longer than a listing's, since the
 *  run cannot start without it and Ollama may be loading another model. */
export const OLLAMA_SHOW_TIMEOUT_MS = 10_000;

/** Model `tag` of the Ollama `env` names, for a run that names it (`ollama/<tag>`): from its address's kept listing while
 *  that is fresh (OLLAMA_TTL_MS), else its own /api/show within `timeoutMs`, never /api/tags, so a run never waits on a
 *  whole listing and never runs on a model's context from before it was pulled again. Undefined where it is not there,
 *  does not answer, is a cloud model or OLLAMA_HOST is refused. Nothing kept: the listing is the kept one. Inside
 *  ollamaReading, the kept listing at any age, and nothing asked when one is kept. */
export async function ollamaShown(env: NodeJS.ProcessEnv, tag: string, { fetch: send = globalThis.fetch, timeoutMs = OLLAMA_SHOW_TIMEOUT_MS }: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OllamaListed | undefined> {
  const base = baseOf(env);
  if (base === undefined) return undefined;
  const known = kept.get(base);
  if (known && reading.getStore()) return known.models.find((model) => model.name === tag);
  const fresh = known && now() - known.at < OLLAMA_TTL_MS ? known.models.find((model) => model.name === tag) : undefined;
  return fresh ?? shownOf(askerOf(base, send, AbortSignal.timeout(timeoutMs)), tag);
}

/** The models the Ollama `env` names has: its address's kept listing while fresh; a stale one at once, asked again behind
 *  the caller; none kept, asked now (listOllama). One listing per address at a time. */
export async function ollamaModels(env: NodeJS.ProcessEnv): Promise<readonly OllamaListed[]> {
  const base = baseOf(env);
  if (base === undefined) return [];
  const known = kept.get(base);
  if (known && now() - known.at < OLLAMA_TTL_MS) return known.models;
  let listing = asking.get(base);
  if (!listing) {
    const mine: Promise<readonly OllamaListed[]> = listOllama(env).finally(() => { if (asking.get(base) === mine) asking.delete(base); });
    listing = mine;
    asking.set(base, listing);
  }
  return known ? known.models : listing;
}

/** The models the Ollama `env` names has, asked again now: its kept listing dropped first, so a tag removed since it was
 *  kept is gone from the answer (model.ts chooseModel, once the host's default no longer answers). A listing already
 *  under way for the address is awaited, never doubled. */
export async function ollamaRelisted(env: NodeJS.ProcessEnv): Promise<readonly OllamaListed[]> {
  const base = baseOf(env);
  if (base === undefined) return [];
  kept.delete(base);
  return ollamaModels(env);
}
/** The models the Ollama `env` names had when last listed (ollamaModels; a failed ask keeps the ones before it, a refused
 *  one none): none where it was never asked. Synchronous, for the host's default model (model.ts hostModel), which a
 *  listing primes before it is read. */
export function ollamaKept(env: NodeJS.ProcessEnv): readonly OllamaListed[] {
  const base = baseOf(env);
  return base === undefined ? [] : (kept.get(base)?.models ?? []);
}

/** Forgets the listing kept for the Ollama `env` names, and the one under way for it, so the next ollamaModels asks it
 *  again at once: after a pull here (local-model.ts), the model is in the picker with no wait for OLLAMA_TTL_MS. A
 *  listing under way when it is forgotten still answers its caller, but is never kept: it may be from before the pull. */
export function ollamaForget(env: NodeJS.ProcessEnv): void {
  const base = baseOf(env);
  if (base === undefined) return;
  forgets.set(base, (forgets.get(base) ?? 0) + 1);
  kept.delete(base);
  asking.delete(base);
}

/** How long the version of the Ollama here is waited for (ollamaVersion): a listing's deadline. */
export const OLLAMA_VERSION_TIMEOUT_MS = OLLAMA_LIST_TIMEOUT_MS;

/** The version the Ollama `env` names says it is (GET /api/version), or undefined where it names none, is refused, down,
 *  hung past `timeoutMs` or answers another shape. Nothing thrown. */
export async function ollamaVersion(env: NodeJS.ProcessEnv, { fetch: send = globalThis.fetch, timeoutMs = OLLAMA_VERSION_TIMEOUT_MS }: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string | undefined> {
  const base = baseOf(env);
  if (base === undefined) return undefined;
  try {
    const answer = (await askerOf(base, send, AbortSignal.timeout(timeoutMs))("/api/version")) as { version?: unknown } | null;
    return typeof answer?.version === "string" && answer.version.length > 0 && answer.version.length <= 64 ? answer.version : undefined;
  } catch {
    return undefined;
  }
}

/** One line of a pull's progress as Ollama streams it (POST /api/pull): its status, and a layer's digest with its bytes. */
export type OllamaPullLine = { readonly status: string; readonly digest?: string; readonly total?: number; readonly completed?: number };

/**
 * Pulls `tag` through the Ollama `env` names (POST /api/pull, streamed as NDJSON), each line of progress to `onLine` as it
 * comes. Resolves once Ollama says `success`; throws, in Ollama's words, on an `error` line, a refusal, a stream that ends
 * before `success`, or `signal`. No deadline of its own: a model is gigabytes, and the caller stops it (`signal`).
 */
export async function ollamaPull(env: NodeJS.ProcessEnv, tag: string, onLine: (line: OllamaPullLine) => void, { fetch: send = globalThis.fetch, signal }: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<void> {
  const base = baseOf(env);
  if (base === undefined) throw new Error("no Ollama is asked here");
  const response = await send(`${base}/api/pull`, { method: "POST", redirect: "error", ...(signal ? { signal } : {}), headers: { "content-type": "application/json" }, body: JSON.stringify({ model: tag, stream: true }) });
  if (!response.ok || !response.body) {
    const said = safeJson(await response.text().catch(() => "")) as { error?: unknown } | undefined;
    throw new Error(typeof said?.error === "string" ? said.error : `/api/pull: ${response.status}`);
  }
  const decoder = new TextDecoder();
  let rest = "";
  let succeeded = false;
  const take = (text: string) => {
    const line = safeJson(text) as { status?: unknown; error?: unknown; digest?: unknown; total?: unknown; completed?: unknown } | undefined;
    if (!line || typeof line !== "object") return;
    if (typeof line.error === "string") throw new Error(line.error);
    if (typeof line.status !== "string") return;
    if (line.status === "success") succeeded = true;
    onLine({ status: line.status, ...(typeof line.digest === "string" ? { digest: line.digest } : {}), ...(line.total !== undefined ? { total: count(line.total) } : {}), ...(line.completed !== undefined ? { completed: count(line.completed) } : {}) });
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = rest.indexOf("\n")) >= 0) {
      const text = rest.slice(0, cut).trim();
      rest = rest.slice(cut + 1);
      if (text) take(text);
    }
  }
  if (rest.trim()) take(rest.trim());
  if (!succeeded) throw new Error("the pull ended before Ollama said success");
}

/** `env`'s Ollama listing as last kept (ollamaKept), in one string: each model's tag, capabilities and trained context.
 *  A server compares it to see a model pulled, removed or an Ollama started since it made its offers (server.ts). */
export const ollamaListing = (env: NodeJS.ProcessEnv): string => ollamaKept(env).map((model) => `${model.name}=${model.capabilities.join(",")}@${model.trained ?? ""}`).join(" ");

/** The context a request on `model` asks for, and its window here: its trained context up to OLLAMA_NUM_CTX (which a model
 *  /api/show names none for gets), and never above the OLLAMA_CONTEXT_LENGTH `env` sets. */
export const contextOf = (model: Pick<OllamaListed, "trained">, env: NodeJS.ProcessEnv): number => Math.min(OLLAMA_NUM_CTX, model.trained ?? OLLAMA_NUM_CTX, contextLengthOf(env) ?? OLLAMA_NUM_CTX);

/** OLLAMA_CONTEXT_LENGTH, Ollama's own default context, where `env` sets it to a whole number above 0: a person who set it
 *  lower (for their memory) is never sent more. Any other value, none. */
const contextLengthOf = (env: NodeJS.ProcessEnv): number | undefined => {
  const given = env.OLLAMA_CONTEXT_LENGTH?.trim();
  if (!given || !/^\d+$/.test(given)) return undefined;
  const length = Number(given);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
};

/** Whether `model` chats (an embedding model does not). */
const chats = (model: OllamaListed): boolean => model.capabilities.includes("completion");

/** The models of `env`'s Ollama that chat and call tools, as refs (`ollama/<tag>`), from its kept listing (ollamaKept),
 *  in its order: the ones a run of pi has tools on. */
export function ollamaToolsModels(env: NodeJS.ProcessEnv): string[] {
  return ollamaKept(env).filter((each) => chats(each) && each.capabilities.includes("tools")).map((each) => `${OLLAMA_PROVIDER}/${each.name}`);
}

/** The first of ollamaToolsModels; undefined where none calls tools. */
export const ollamaToolsModel = (env: NodeJS.ProcessEnv): string | undefined => ollamaToolsModels(env)[0];

type OllamaModel = Model<typeof OLLAMA_API> & { toolsAs?: ToolsAs };

/** The provider of `listed` (its chat models) at `base`: keyless, $0, each model's window its context (contextOf). */
export function ollamaProvider(base: string, listed: readonly OllamaListed[], env: NodeJS.ProcessEnv) {
  const models: OllamaModel[] = listed.filter(chats).map((model) => {
    const window = contextOf(model, env);
    return {
      id: model.name,
      name: `${model.name} (Ollama)`,
      api: OLLAMA_API,
      provider: OLLAMA_PROVIDER,
      baseUrl: base,
      reasoning: model.capabilities.includes("thinking"),
      input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
      cost: { ...ZERO },
      contextWindow: window,
      maxTokens: Math.min(16_384, Math.floor(window / 2)),
      ...(model.capabilities.includes("tools") ? {} : { toolsAs: "text" as const }),
    };
  });
  return createProvider({
    id: OLLAMA_PROVIDER,
    name: "Ollama",
    baseUrl: base,
    // No key: Ollama takes none, so its auth resolves to none, as the faux provider's does (model.ts runModels).
    auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: {} }) } },
    models,
    api: { stream: streamChat, streamSimple: streamChat },
  });
}

/** A line of /api/chat's stream: a part of the answer, its last with `done` and the counts; or an error. */
type ChatLine = {
  message?: { content?: string; thinking?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

/** What a request asks Ollama past pi-ai's own options (model-route.ts ollamaAsks): `format`, the JSON schema its answer is
 *  held to (/api/chat's format); `think: false`, a thinking model asked not to think. */
export type OllamaAsks = { format?: Record<string, unknown>; think?: false };

/** `context` as /api/chat's body for `model`: the current system prompt first, each message in Ollama's shape (a call's
 *  arguments an object, a result `tool` with the tool's name, images as base64), and the current tools in its `tools`. */
export function chatBody(model: Model<string>, context: TranscriptContext, options: (SimpleStreamOptions & OllamaAsks) | undefined): Record<string, unknown> {
  const collapsed = collapseSystemMessages(context);
  const system = getCurrentSystemPrompt(collapsed.messages);
  const tools = getCurrentTools(collapsed.messages);
  const messages: Record<string, unknown>[] = system ? [{ role: "system", content: system }] : [];
  const textOf = (parts: readonly { type: string; text?: string }[]) => parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  const imagesOf = (parts: readonly { type: string; data?: string }[]) => parts.flatMap((part) => (part.type === "image" && part.data ? [part.data] : []));
  for (const message of transformMessages(collapsed.messages, model as Model<never>)) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      const images = imagesOf(parts);
      messages.push({ role: "user", content: textOf(parts), ...(images.length ? { images } : {}) });
    } else if (message.role === "assistant") {
      const thinking = message.content.flatMap((part) => (part.type === "thinking" && !part.redacted ? [part.thinking] : [])).join("");
      const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [{ function: { name: part.name, arguments: part.arguments } }] : []));
      messages.push({ role: "assistant", content: textOf(message.content), ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const images = imagesOf(message.content);
      messages.push({ role: "tool", tool_name: message.toolName, content: textOf(message.content), ...(images.length ? { images } : {}) });
    }
  }
  const window = Math.min(model.contextWindow, OLLAMA_NUM_CTX);
  const topP = options?.samplingParams?.top_p;
  return {
    model: model.id,
    messages,
    ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    stream: true,
    // A thinking model asked to reason thinks; asked not to (think false), does not; asked nothing, Ollama's default.
    ...(model.reasoning && options?.reasoning ? { think: true } : model.reasoning && options?.think === false ? { think: false } : {}),
    ...(options?.format ? { format: options.format } : {}),
    options: { num_ctx: window, ...(options?.maxTokens ? { num_predict: options.maxTokens } : {}), ...(options?.temperature === undefined ? {} : { temperature: options.temperature }), ...(typeof topP === "number" ? { top_p: topP } : {}) },
  };
}

/** One request on /api/chat, its NDJSON read into pi-ai's events: text and thinking as they stream, each tool call whole,
 *  and the end with Ollama's counts as its usage (prompt_eval_count in, eval_count out), at the model's price ($0). An
 *  error line, a refused status or a broken stream ends in an error event; a stopped one in an aborted one. */
function streamChat(model: Model<string>, context: TranscriptContext, options?: StreamOptions & SimpleStreamOptions & OllamaAsks): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
  void (async () => {
    const send = options?.fetch ?? globalThis.fetch;
    const body = chatBody(model, context, options);
    const response = await send(`${model.baseUrl}/api/chat`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...headersOf(options) }, body: JSON.stringify(body), ...(options?.signal ? { signal: options.signal } : {}) });
    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model as Model<never>);
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let said = text;
      try {
        said = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`${response.status} ${said}`.trim());
    }
    stream.push({ type: "start", partial: output });
    // The block open now (text or thinking), by its index in the answer's content.
    let open: { kind: "text" | "thinking"; index: number } | undefined;
    const close = () => {
      if (!open) return;
      const block = output.content[open.index]!;
      if (open.kind === "text") stream.push({ type: "text_end", contentIndex: open.index, content: (block as { text: string }).text, partial: output });
      else stream.push({ type: "thinking_end", contentIndex: open.index, content: (block as { thinking: string }).thinking, partial: output });
      open = undefined;
    };
    const add = (kind: "text" | "thinking", delta: string) => {
      if (!delta) return;
      if (open?.kind !== kind) {
        close();
        output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        open = { kind, index: output.content.length - 1 };
        stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: open.index, partial: output });
      }
      const block = output.content[open.index] as { text?: string; thinking?: string };
      if (kind === "text") block.text += delta;
      else block.thinking += delta;
      stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: open.index, delta, partial: output });
    };
    let calls = 0;
    let ended: ChatLine | undefined;
    // A model without the thinking capability gets no split from Ollama: its content's opening <think> is split here.
    const split = model.reasoning ? undefined : thinkSplit();
    const content = (delta: string) => {
      if (!split) return add("text", delta);
      for (const [kind, part] of split(delta)) add(kind, part);
    };
    const read = (line: ChatLine) => {
      if (line.error) throw new Error(line.error);
      add("thinking", line.message?.thinking ?? "");
      content(line.message?.content ?? "");
      for (const call of line.message?.tool_calls ?? []) {
        close();
        const args = call.function?.arguments;
        const parsed = typeof args === "string" ? safeJson(args) : args;
        const toolCall = { type: "toolCall" as const, id: call.id || `call_${calls}_${Math.random().toString(36).slice(2, 10)}`, name: call.function?.name ?? "", arguments: (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, never> };
        calls += 1;
        output.content.push(toolCall);
        const index = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
      }
      if (line.done) ended = line;
    };
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) read(JSON.parse(line) as ChatLine);
    }
    if ((rest + decoder.decode()).trim()) read(JSON.parse(rest) as ChatLine);
    for (const [kind, part] of split?.(undefined) ?? []) add(kind, part);
    close();
    if (!ended) throw new Error("Ollama's answer ended before it was done");
    const input = count(ended.prompt_eval_count);
    const out = count(ended.eval_count);
    output.usage = { input, output: out, cacheRead: 0, cacheWrite: 0, totalTokens: input + out, cost: { ...ZERO, total: 0 } };
    output.usage.cost = calculateCost(model as Model<never>, output.usage);
    output.stopReason = calls > 0 ? "toolUse" : ended.done_reason === "length" ? "length" : "stop";
    if (ended.done_reason) output.rawStopReason = ended.done_reason;
    stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
    stream.end(output);
  })().catch((error: unknown) => {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end(output);
  });
  return stream;
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * The content of a model Ollama splits no thinking out of, split as Ollama's own thinking parser splits a thinking
 * model's: where the answer opens with `<think>` (after any whitespace), what follows is thinking up to `</think>`, then
 * the rest is text, whitespace at the start of each left out. Any other answer is text as it came. Takes each delta in
 * turn, and `undefined` at the end for what it held back (a tag still incomplete); answers the parts to add, in order.
 */
function thinkSplit(): (delta: string | undefined) => Array<["text" | "thinking", string]> {
  let state: "opening" | "thinking" | "after" | "text" = "opening";
  let held = "";
  return (delta) => {
    const parts: Array<["text" | "thinking", string]> = [];
    const end = delta === undefined;
    let input = held + (delta ?? "");
    held = "";
    if (state === "opening") {
      const start = input.trimStart();
      if (start.startsWith(OPEN)) [state, input] = ["thinking", start.slice(OPEN.length).trimStart()];
      else if (OPEN.startsWith(start) && !end) return (held = input), parts;
      else state = "text";
    }
    if (state === "thinking") {
      const at = input.indexOf(CLOSE);
      if (at < 0) {
        // A tail that may begin `</think>` waits for the next delta, unless this is the end.
        let keep = 0;
        if (!end) for (let n = Math.min(CLOSE.length - 1, input.length); n > 0; n--) if (CLOSE.startsWith(input.slice(-n))) { keep = n; break; }
        held = input.slice(input.length - keep);
        if (input.length > keep) parts.push(["thinking", input.slice(0, input.length - keep)]);
        return parts;
      }
      if (at > 0) parts.push(["thinking", input.slice(0, at)]);
      [state, input] = ["after", input.slice(at + CLOSE.length)];
    }
    if (state === "after") {
      input = input.trimStart();
      if (!input) return parts;
      state = "text";
    }
    if (input) parts.push(["text", input]);
    return parts;
  };
}

/** A count Ollama reports, or 0 where it reports none (a cached prompt reports no prompt_eval_count). */
const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The request's own headers, a null one left out. */
const headersOf = (options: StreamOptions | undefined): Record<string, string> => Object.fromEntries(Object.entries(options?.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
