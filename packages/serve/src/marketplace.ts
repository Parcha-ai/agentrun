// The marketplace's templates (GET /v2/marketplace/templates): marketplace.agentrun.ai lists every template package,
// Parcha's and the community's, and publishes that list as /search.json, the one its own pages are built beside. The
// console lists the packages this server ships and those imported here, then the marketplace's others, so the two show
// the same templates. This server reads the list only when asked (no read at its start, none in the background), keeps
// it 5 minutes (the site's own cache-control), and keeps the last good one when a read fails. Nothing on the list is
// imported or run: an entry is display data and, when it names one, the package source an install reads (POST
// /v2/templates/import, with its publisher trusted once). Off with AGENTRUN_MARKETPLACE=off, and under --faux unless
// AGENTRUN_MARKETPLACE names an address; an address there reads that site's list in place of marketplace.agentrun.ai's.
import { HARNESS_ID_PATTERN } from "./harness.js";
import { parseSource } from "./template-source.js";
import { CATEGORIES } from "./templates.js";

export const MARKETPLACE_URL = "https://marketplace.agentrun.ai";
export const MARKETPLACE_ENV = "AGENTRUN_MARKETPLACE";
/** How long a list read is answered before it is read again: the site's own cache-control (max-age=300). */
export const MARKETPLACE_TTL_MS = 5 * 60_000;
/** How long a failed read is answered before the next try, so a console open on an offline server asks the network
 *  once a minute, not on every page. */
export const MARKETPLACE_RETRY_MS = 60_000;
/** What one read may take: the list's bytes (today's is 68 KB), its entries, and the time the read may last. */
export const MARKETPLACE_LIMITS = { bytes: 4 << 20, entries: 1000, ms: 10_000 } as const;
/** Where the packages this server ships live on GitHub, so a marketplace entry that names one is the bundled package. */
const BUNDLED_REPO = "parcha-ai/agentrun";
const BUNDLED_PATH = "packages/serve/templates/";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9-]{1,32}$/;
const HARNESS = new RegExp(HARNESS_ID_PATTERN);
const MAX = { name: 64, title: 120, summary: 300, description: 2000, tags: 8, needs: 16, need: 200, harness: 8 } as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** One template on the marketplace. `title`, its display name; `summary`, its card's one line; `description`, the rest;
 *  `needs`, what it requires, in the marketplace's words; `harness`, its package's harness preference list (empty: any
 *  harness; left out when the list does not say), display only; `page_url`, its page there; `source`, the package an install
 *  reads (`github:<owner>/<repo>[/<path>]@<sha>`), when the list names one; `here`, the id of this server's package that
 *  is this one, when there is one (a bundled package by its name, or one imported from its source). */
export type MarketplaceTemplate = { name: string; title: string; summary?: string; description?: string; category?: string; tags: string[]; needs: string[]; harness?: string[]; page_url: string; source?: string };
export type MarketplaceAnswer = {
  /** The site read, or null when the marketplace is off here. */
  url: string | null;
  /** `read`: the list as read within the last 5 minutes; `stale`: the last read failed, and this is the list as read at
   *  `read_at`; `unreachable`: no read has worked yet, so the list is empty; `off`: this server reads no marketplace. */
  state: "read" | "stale" | "unreachable" | "off";
  read_at: string | null;
  /** Why the last read failed (`stale`, `unreachable`), or why the marketplace is off. */
  problem?: string;
  templates: (MarketplaceTemplate & { here?: string })[];
};

/** The marketplace this server reads, from the environment: its address, or null for off. Unset, the public one, except
 *  under --faux (a test's or a demo's server, which reaches no network unasked). `off` (or 0, false) turns it off. An
 *  address is an https origin (with a path, when the site is served under one); http is taken for a loopback host
 *  alone, a local copy of the site. Anything else stops the start: the owner set it, and a typo should not read as off. */
export function marketplaceUrlOf(env: NodeJS.ProcessEnv, faux: boolean): string | null {
  const given = env[MARKETPLACE_ENV]?.trim();
  if (!given) return faux ? null : MARKETPLACE_URL;
  if (/^(off|0|false|no)$/i.test(given)) return null;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`${MARKETPLACE_ENV}=${given} is not an address: set it to the marketplace's https address (default ${MARKETPLACE_URL}), or to off.`);
  }
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${MARKETPLACE_ENV}=${given} is not one: the marketplace is read over https (http on a loopback host alone), with no user, query or fragment. Default ${MARKETPLACE_URL}; off turns it off.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** One line of text from the list: control characters made spaces, trimmed, and cut at `max`. Undefined for anything but
 *  a string with text in it. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\0-\x1f\x7f]+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** One entry of the list read as a template, or undefined for one that is not (no name of a package's shape): an entry's
 *  other fields are kept where they are of their shape and dropped where not, so one odd field never hides a template. */
export function entryOf(raw: unknown, site: string): MarketplaceTemplate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== "string" || e.name.length > MAX.name || !NAME.test(e.name)) return undefined;
  const name = e.name;
  const summary = line(e.summary, MAX.summary);
  const description = line(e.description, MAX.description);
  const category = typeof e.category === "string" && (CATEGORIES as readonly string[]).includes(e.category) ? e.category : undefined;
  const tags = Array.isArray(e.tags) ? [...new Set(e.tags.filter((t): t is string => typeof t === "string" && TAG.test(t)))].slice(0, MAX.tags) : [];
  const needs = Array.isArray(e.needs) ? e.needs.map((n) => line(n, MAX.need)).filter((n): n is string => !!n).slice(0, MAX.needs) : [];
  // Its harnesses, in preference order: the ids of a harness's shape, each once. A list that says none leaves it out.
  const harness = Array.isArray(e.harness) ? [...new Set(e.harness.filter((h): h is string => typeof h === "string" && HARNESS.test(h)))].slice(0, MAX.harness) : undefined;
  // Its page: the path the list gives, on the site itself; any other place, its page's usual one.
  const usual = `${site}/templates/${name}/`;
  let page_url = usual;
  if (typeof e.url === "string" && e.url.startsWith("/") && !e.url.startsWith("//")) {
    try {
      const at = new URL(`${site}${e.url}`);
      if (at.origin === new URL(site).origin) page_url = at.href;
    } catch {
      page_url = usual;
    }
  }
  // Its source, kept as the list writes it (the commit it pins with it) when it reads as one: an install reads that.
  let source: string | undefined;
  if (typeof e.source === "string") {
    try {
      parseSource(e.source);
      source = e.source.trim();
    } catch {
      source = undefined;
    }
  }
  return {
    name, title: line(e.title, MAX.title) ?? name,
    ...(summary ? { summary } : {}), ...(description ? { description } : {}), ...(category ? { category } : {}),
    tags, needs, ...(harness ? { harness } : {}), page_url, ...(source ? { source } : {}),
  };
}

/** The list's JSON read as templates, in its order, each name once (its first entry), at most MARKETPLACE_LIMITS.entries.
 *  Anything but a list is the read's failure. */
export function listOf(json: unknown, site: string): MarketplaceTemplate[] {
  if (!Array.isArray(json)) throw new Error("The marketplace's list is not a list of templates.");
  const seen = new Set<string>();
  const out: MarketplaceTemplate[] = [];
  for (const raw of json) {
    const entry = entryOf(raw, site);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
    if (out.length >= MARKETPLACE_LIMITS.entries) break;
  }
  return out;
}

/** The package here that a marketplace entry is, by id: with a source, the package imported from it, else the bundled
 *  package of its name when the source is where this server's own packages live; with none (a list that names no
 *  sources), the package of its name, a bundled one first. */
export function hereOf(entry: Pick<MarketplaceTemplate, "name" | "source">, packages: readonly { id: string; name: string; origin: unknown }[]): string | undefined {
  const bundled = packages.find((p) => p.origin === null && p.name === entry.name);
  if (!entry.source) return (bundled ?? packages.find((p) => p.name === entry.name))?.id;
  const source = parseSource(entry.source);
  const imported = packages.find((p) => p.origin !== null && p.id === source.id);
  if (imported) return imported.id;
  return `${source.owner}/${source.repo}`.toLowerCase() === BUNDLED_REPO && source.path === `${BUNDLED_PATH}${entry.name}` ? bundled?.id : undefined;
}

type Read = { templates: MarketplaceTemplate[]; at: number };

/** The marketplace's list as this server reads it: on demand, kept MARKETPLACE_TTL_MS, one read at a time however many
 *  ask, and the last good list kept through a failed read. `fetchImpl`, `now` and `deadlineMs` (the read's time limit,
 *  MARKETPLACE_LIMITS.ms unless said) are a test's seams. */
export class Marketplace {
  readonly url: string | null;
  #fetch: typeof fetch;
  #now: () => number;
  #held: Read | undefined;
  #failed: { at: number; problem: string } | undefined;
  #reading: Promise<Read> | undefined;
  #deadlineMs: number;

  constructor(url: string | null, options: { fetchImpl?: typeof fetch; now?: () => number; deadlineMs?: number } = {}) {
    this.url = url;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#deadlineMs = options.deadlineMs ?? MARKETPLACE_LIMITS.ms;
  }

  async list(): Promise<Omit<MarketplaceAnswer, "templates"> & { templates: MarketplaceTemplate[] }> {
    if (!this.url) return { url: null, state: "off", read_at: null, problem: `This server reads no marketplace (${MARKETPLACE_ENV}=off, or --faux with it unset).`, templates: [] };
    const now = this.#now();
    const held = this.#held;
    const fresh = held && now - held.at < MARKETPLACE_TTL_MS;
    const waiting = this.#failed && now - this.#failed.at < MARKETPLACE_RETRY_MS;
    if (!fresh && !waiting) {
      try {
        this.#held = await (this.#reading ??= this.#read().finally(() => { this.#reading = undefined; }));
        this.#failed = undefined;
      } catch (error) {
        this.#failed = { at: this.#now(), problem: (error as Error).message };
      }
    }
    const kept = this.#held;
    const read_at = kept ? new Date(kept.at).toISOString() : null;
    if (this.#failed) return kept ? { url: this.url, state: "stale", read_at, problem: this.#failed.problem, templates: kept.templates } : { url: this.url, state: "unreachable", read_at: null, problem: this.#failed.problem, templates: [] };
    return { url: this.url, state: "read", read_at, templates: kept?.templates ?? [] };
  }

  async #read(): Promise<Read> {
    const at = `${this.url}/search.json`;
    // One deadline for the whole read: the answer's headers and every byte of its body.
    const signal = AbortSignal.timeout(this.#deadlineMs);
    let res: Response;
    try {
      res = await this.#fetch(at, { redirect: "manual", signal, headers: { accept: "application/json", "user-agent": "agentrun-serve" } });
    } catch (error) {
      throw new Error(signal.aborted ? `The marketplace (${this.url}) did not answer in ${this.#deadlineMs / 1000} s.` : `The marketplace (${this.url}) could not be reached: ${(error as Error).message}.`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new Error(`The marketplace (${this.url}) sent its list elsewhere (${res.status} to ${res.headers.get("location") ?? "nowhere"}): set ${MARKETPLACE_ENV} to the address it names.`);
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel();
      throw new Error(`The marketplace (${this.url}) answered ${res.status} for its list.`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MARKETPLACE_LIMITS.bytes) {
      await res.body.cancel();
      throw new Error(`The marketplace's list is ${declared} bytes, over the ${MARKETPLACE_LIMITS.bytes} this server reads.`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.byteLength;
        if (bytes > MARKETPLACE_LIMITS.bytes) throw new Error(`The marketplace's list is over the ${MARKETPLACE_LIMITS.bytes} bytes this server reads.`);
        chunks.push(chunk);
      }
    } catch (error) {
      throw signal.aborted ? new Error(`The marketplace (${this.url}) did not finish its list in ${this.#deadlineMs / 1000} s.`) : error;
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("The marketplace's list is not JSON.");
    }
    return { templates: listOf(json, this.url!), at: this.#now() };
  }
}
