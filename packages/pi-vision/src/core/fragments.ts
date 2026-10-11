// Where in a source a look or a citation points: pages of a document (`#page=3`, `#page=1-37`), a time window of a
// video (`#t=60,90`, Media Fragments' temporal form), a region in percent of a page, image or frame
// (`#xywh=percent:10,20,30,40`, Media Fragments' spatial form). Dimensions combine with `&` in that order. A citation
// is `path#fragment`; the fragment form hosts already resolve for pages is `#page=N`.

/** Pages, 1-based and inclusive; one page has `from === to`. */
export type PageSpan = { readonly from: number; readonly to: number };
/** Seconds from the start; no `to` means to the end. */
export type TimeSpan = { readonly from: number; readonly to?: number };
/** A rectangle in percent of the whole: left, top, width, height. */
export type Region = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type Fragment = { readonly page?: PageSpan; readonly t?: TimeSpan; readonly xywh?: Region };

const number = (value: number) => String(Number(value.toFixed(3)));
const isPage = (value: number) => Number.isInteger(value) && value >= 1;
const isSeconds = (value: number) => Number.isFinite(value) && value >= 0;
const isPercent = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;

function valid(fragment: Fragment): boolean {
  const { page, t, xywh } = fragment;
  if (page && !(isPage(page.from) && isPage(page.to) && page.to >= page.from)) return false;
  if (t && !(isSeconds(t.from) && (t.to === undefined || (isSeconds(t.to) && t.to > t.from)))) return false;
  if (xywh && !([xywh.x, xywh.y, xywh.w, xywh.h].every(isPercent) && xywh.w > 0 && xywh.h > 0 && xywh.x + xywh.w <= 100 && xywh.y + xywh.h <= 100)) return false;
  return Boolean(page || t || xywh);
}

/** The fragment without its `#`, such as `page=1-37` or `t=60,90&xywh=percent:0,0,50,50`. Throws on a fragment that
 *  names nothing or holds an impossible value (page 0, a window that ends before it starts, a region off the whole). */
export function formatFragment(fragment: Fragment): string {
  if (!valid(fragment)) throw new RangeError(`not a fragment: ${JSON.stringify(fragment)}`);
  const parts: string[] = [];
  const { page, t, xywh } = fragment;
  if (page) parts.push(`page=${page.from === page.to ? page.from : `${page.from}-${page.to}`}`);
  if (t) parts.push(`t=${number(t.from)}${t.to === undefined ? "" : `,${number(t.to)}`}`);
  if (xywh) parts.push(`xywh=percent:${[xywh.x, xywh.y, xywh.w, xywh.h].map(number).join(",")}`);
  return parts.join("&");
}

/** `path#fragment`, the form a receipt and an answer cite. */
export const citation = (path: string, fragment: Fragment): string => `${path}#${formatFragment(fragment)}`;

const DECIMAL = /^\d+(?:\.\d+)?$/;
const decimal = (text: string): number | undefined => (DECIMAL.test(text) ? Number(text) : undefined);

/** A fragment, with or without its `#`; null for anything this module would not write: an unknown or repeated key,
 *  a malformed or impossible value, a spatial fragment in pixels. `t` also takes Media Fragments' `npt:` prefix and an
 *  open start (`t=,90`, from 0). */
export function parseFragment(text: string): Fragment | null {
  const body = text.startsWith("#") ? text.slice(1) : text;
  if (!body) return null;
  const out: { page?: PageSpan; t?: TimeSpan; xywh?: Region } = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    const [key, value] = eq < 0 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
    if (key in out) return null;
    if (key === "page") {
      const m = /^(\d+)(?:-(\d+))?$/.exec(value);
      if (!m) return null;
      out.page = { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
    } else if (key === "t") {
      const m = /^(?:npt:)?([^,]*)(?:,(.+))?$/.exec(value);
      const from = m?.[1] === "" ? 0 : decimal(m?.[1] ?? "");
      const to = m?.[2] === undefined ? undefined : decimal(m[2]);
      if (!m || from === undefined || (m[2] !== undefined && to === undefined) || (m[1] === "" && to === undefined)) return null;
      out.t = to === undefined ? { from } : { from, to };
    } else if (key === "xywh") {
      if (!value.startsWith("percent:")) return null;
      const values = value.slice("percent:".length).split(",").map(decimal);
      if (values.length !== 4 || values.some((v) => v === undefined)) return null;
      const [x, y, w, h] = values as number[];
      out.xywh = { x, y, w, h };
    } else return null;
  }
  return valid(out) ? out : null;
}

/** A citation split at its last `#` that starts a fragment, so a `#` inside a file name stays in the path. A path
 *  with no fragment comes back with `fragment: null`. */
export function parseCitation(text: string): { path: string; fragment: Fragment | null } {
  for (let at = text.lastIndexOf("#"); at > 0; at = text.lastIndexOf("#", at - 1)) {
    const fragment = parseFragment(text.slice(at + 1));
    if (fragment) return { path: text.slice(0, at), fragment };
  }
  return { path: text, fragment: null };
}
