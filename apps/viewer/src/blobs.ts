// What a recording's blob may do in the viewer's page. A blob URL (a dropped folder) or a file beside the page (a
// static host) has the viewer's origin, so a page in a blob (HTML, SVG, script) opened from a link would run with the
// viewer's access. Only passive types open in place; every other blob is a download.

/** The media type of a blob file's extension. */
export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm', mp4: 'video/mp4',
  json: 'application/json', html: 'text/html', md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf',
  sqlite: 'application/vnd.sqlite3', css: 'text/css',
};
export const typeOfName = (name: string): string | undefined => MIME[name.split('.').at(-1)?.toLowerCase() ?? ''];

const PASSIVE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/webm', 'video/mp4', 'application/json', 'text/plain', 'text/markdown', 'application/pdf']);
/** A blob's bytes as a Response. An embedded blob's data: URL is decoded in the page, not fetched: a page served with `connect-src 'self'`
 *  (the docs site) may not fetch one, and what it holds (a run's cited result, an agent's page, a stylesheet, a picture to draw) would go
 *  unread. Any other URL is fetched as it is. */
export function fetchBlob(url: string, init?: RequestInit): Promise<Response> {
  const data = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,/.exec(url);
  if (!data) return fetch(url, init);
  try {
    const body = url.slice(data[0].length);
    const bytes = data[3] ? Uint8Array.from(atob(body), (each) => each.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
    return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': data[1] || 'text/plain' } }));
  } catch (error) { return Promise.reject(error); }
}

/** Whether a blob of this type may open in a tab of the viewer's origin: never a page, an SVG or an unknown type. */
export const opensInPage = (type: string | undefined): boolean => type !== undefined && PASSIVE.has(type.split(';')[0]!.trim().toLowerCase());
