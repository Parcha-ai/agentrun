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
/** Whether a blob of this type may open in a tab of the viewer's origin: never a page, an SVG or an unknown type. */
export const opensInPage = (type: string | undefined): boolean => type !== undefined && PASSIVE.has(type.split(';')[0]!.trim().toLowerCase());

/** The blob extensions a static host serves as data when a file of them is opened straight: the recording format's
 *  allowlist (draft 50: a picture, a video, a PDF, words) and a style sheet. A published blob of any other extension (an
 *  artifact's page) is shipped as `<name>.txt`, plain text, so no file the gallery publishes runs as a page of its site. */
export const SHOWN_AS_DATA: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4', 'pdf', 'json', 'jsonl', 'txt', 'md', 'csv', 'vtt', 'css']);
/** The name a blob file is published under: its own when its extension is shown as data, else with `.txt` after it. */
export const inertName = (name: string): string => (SHOWN_AS_DATA.has(name.split('.').at(-1)?.toLowerCase() ?? '') ? name : `${name}.txt`);
