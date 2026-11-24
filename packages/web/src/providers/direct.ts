// The guarded direct fetch: one page through the injected public-host guard. A refusal or a failure is a Page with ok
// false, never a throw. With no guard nothing is fetched.
import { type Guard, type GuardOptions, isRefused } from "../guard.js";
import { clip, linksWithin, type Page, type Part, partOfRead, type Read, TIMEOUT_MS, TITLE_CAP, textOf, type Unread, URL_MAX, withoutUserinfo } from "../page.js";
import { linksOf } from "../text-urls.js";

/** The page at `url`, read once through `guard`'s fetch (an HTML page through its reader), or why it was not. `options`
 *  are the guard's resolver and fetch, for a test; a signal ends it early. */
export async function readDirect(url: unknown, guard: Guard | undefined, options: GuardOptions = {}): Promise<Read | Unread> {
  const failed = (fields: Partial<Omit<Page, "ok">> & ({ refused: string } | { error: string })): Unread => ({ ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], ...fields });
  if (typeof url !== "string" || !URL.canParse(url)) return failed({ error: "url is not an absolute URL" });
  const target = new URL(url);
  // The bound is on the href, what the guard fetches: percent-encoding can grow it past the string as asked.
  if (target.href.length > URL_MAX) return failed({ error: `url is longer than ${URL_MAX.toLocaleString("en-US")} characters` });
  const { port, username, password } = target;
  if (port && port !== "80" && port !== "443") return failed({ refused: `refused: port ${port} is not 80 or 443` });
  // A URL's user name and password are never sent anywhere: a fetch refuses them, never a third party's read of them.
  if (username || password) return failed({ refused: "refused: the URL holds a user name or password" });
  if (!guard) return failed({ error: "no public-host guard was given, so nothing is fetched directly" });
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const answer = await guard.fetch(url, { ...options, signal });
    if (answer.body === null) return failed({ url: clip(answer.url, URL_MAX), status: answer.status, error: `the page answered ${answer.status}` });
    // The caller's stop reaches the read too; the timeout is the network's, and the reader keeps its own deadline.
    const read = guard.html && /html/i.test(answer.contentType) ? await guard.html(answer.body, answer.url, options.signal ? { signal: options.signal } : {}) : null;
    const page = read ?? { title: "", text: answer.body, links: linksOf(answer.body) };
    return {
      ok: true,
      url: clip(answer.url, URL_MAX),
      status: answer.status,
      title: clip(page.title, TITLE_CAP),
      ...textOf(page.text, !read?.truncated),
      ...(read?.truncated ? { html_chars: read.html_chars! } : {}),
      ...(read?.converted === "text" ? { converted: "text" as const } : {}),
      ...linksWithin(page.links),
    };
  } catch (error) {
    // Never a URL's user name or password: undici's refusal of a redirect to a URL holding them quotes it whole.
    const message = withoutUserinfo((error as Error)?.message ?? String(error));
    return failed(isRefused(error) ? { refused: message } : { error: message });
  }
}

/** The part `options` names of the page at `url`, as a Page, read through the guarded direct fetch. */
export async function fetchPage(url: unknown, { guard, offset, maxChars, ...options }: GuardOptions & Part & { guard?: Guard } = {}): Promise<Page> {
  const read = await readDirect(url, guard, options);
  return read.ok ? partOfRead(read, { offset, maxChars }) : read;
}
