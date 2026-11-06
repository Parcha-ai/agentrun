/** A URL from server data (a fetched page's citation, an image a provider saw) as a link or an image source: the URL as the
 *  parser reads it when its scheme is http or https, else undefined, and the caller shows text in its place. The parser does
 *  the normalizing (case, leading spaces and control characters, a tab inside the scheme), so `javascript:`, `data:`,
 *  `vbscript:` and anything that is no absolute URL never become a link, however they are spelled. */
export function httpHref(u: string | null | undefined): string | undefined {
  if (typeof u !== "string" || !u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
