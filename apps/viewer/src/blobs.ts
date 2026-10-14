// What a recording's blob may do in the viewer's page. A blob URL (a dropped folder) or a file beside the page (a
// static host) has the viewer's origin, so a page in a blob (HTML, SVG, script) opened from a link would run with the
// viewer's access. Only passive types open in place; every other blob is a download.

/** The media type of a blob file's extension. */
export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm',
  json: 'application/json', html: 'text/html', md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf',
};
export const typeOfName = (name: string): string | undefined => MIME[name.split('.').at(-1)?.toLowerCase() ?? ''];

const PASSIVE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/webm', 'application/json', 'text/plain', 'text/markdown', 'application/pdf']);
/** Whether a blob of this type may open in a tab of the viewer's origin: never a page, an SVG or an unknown type. */
export const opensInPage = (type: string | undefined): boolean => type !== undefined && PASSIVE.has(type.split(';')[0]!.trim().toLowerCase());
