// The public-host guard, injected: web holds no fetcher of its own that could reach a private address. A refusal is told
// from a failure by its shape alone (isRefused): the guard throws an error whose `failure.code` is "refused".
/** The guard's resolver and fetch (a test's fake network), and a signal that ends the fetch. */
export type GuardOptions = {
  /** Every address a name resolves to; default the guard's own (the system resolver). */
  lookup?: (host: string) => Promise<string[]>;
  /** The fetch the guard dials through; default the guard's own. */
  fetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response>;
  signal?: AbortSignal;
};
/** The answer that ended the redirects: its URL, status and type, and its body when it is a 2xx text answer. */
export type PublicAnswer = { url: string; status: number; contentType: string; body: string | null };
/** The guarded fetch: `maxBytes` its byte cap (the guard's default when not given). */
export type PublicFetch = (url: string, options: GuardOptions & { maxBytes?: number }) => Promise<PublicAnswer>;
/** An HTML page read as text: its title, its text (markdown), its links; `truncated` with `html_chars` (the page's whole
 *  length) when its HTML was cut before it was read (HTML_READ_CHARS), `converted: "text"` when its conversion to
 *  markdown ran out of time and the text is the page's plain text. */
export type HtmlRead = { title: string; text: string; links: string[]; converted?: "markdown" | "text"; truncated?: true; html_chars?: number };
/** The HTML reader the direct fetch hands an HTML page to; `signal` ends the read. */
export type HtmlReader = (html: string, url: string, options: { signal?: AbortSignal }) => Promise<HtmlRead>;
/** The guard's check of a URL's first hop with nothing sent: resolves when the guarded fetch would dial it, throws its
 *  refusal when not. A URL goes to a provider only once this passes. */
export type PublicCheck = (url: string, options: Pick<GuardOptions, "lookup" | "signal">) => Promise<void>;
/** The guarded fetch, its check, and for an HTML page its reader (none: an HTML page's body is read as plain text). */
export type Guard = { fetch: PublicFetch; check: PublicCheck; html?: HtmlReader };

/** Whether `error` is the guard's refusal (a private, loopback, link-local or intranet address, a scheme other than
 *  http(s), a redirect to one): an error whose `failure.code` is "refused". */
export const isRefused = (error: unknown): boolean => (error as { failure?: { code?: unknown } } | null | undefined)?.failure?.code === "refused";
