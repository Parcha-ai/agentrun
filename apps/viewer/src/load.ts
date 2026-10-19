// Loading a recording: the bundled ones (embedded in gallery.js or listed in recordings/index.json), one at a URL, or a
// dropped folder. Shared by the viewer (app.ts) and the chat view (chat.ts).
import { parseLines, type Line, type Manifest, type Recording } from './format.ts';
import { opensInPage, typeOfName } from './blobs.ts';
import { sha256Paused } from './receipt-key.ts';
import { LIVE_INDEX, LIVE_LINES, mergeLines } from './split.ts';

/** A bundled recording: embedded in gallery.js (its lines, and each blob as a data: URL), or, in a build that ships
 *  recordings as files, listed in `recordings/index.json` (each blob as its path in the recording's directory). */
export type GalleryEntry = { id: string; manifest: Manifest; events: string; blobs: Record<string, string> };
export type IndexEntry = { id: string; manifest: Manifest; blobs: Record<string, string> };
declare const window: Window & { AGENTRUN_GALLERY?: GalleryEntry[]; AGENTRUN_GALLERY_INDEX?: string };

const BLOB_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4', 'json', 'html', 'html.txt', 'md', 'txt', 'pdf', 'sqlite', 'css'];

/** A recording's lines at `root`: events.jsonl, and, unless `live` is false (a view that reads no pi.live line), the
 *  pi.live lines merged back in when the recording is split (draft 51). It is split exactly when events.live.idx is
 *  there: only a 404 means it is not, and any other failure is an error, never read as a run with no live lines. */
async function linesAt(root: string, live = true): Promise<string> {
  const read = async (name: string) => {
    const response = await fetch(`${root}${name}`);
    if (!response.ok) throw new Error(`${name} answered ${response.status}`);
    return response.text();
  };
  const text = await read('events.jsonl');
  if (!live) return text;
  const index = await fetch(`${root}${LIVE_INDEX}`);
  if (index.status === 404) return text;
  if (!index.ok) throw new Error(`${LIVE_INDEX} answered ${index.status}, so the run's live lines could not be read`);
  const merged = mergeLines(text, await read(LIVE_LINES), await index.text());
  if ('problem' in merged) throw new Error(merged.problem);
  return merged.text;
}

/** A recording the index lists: its lines fetched from its directory (`live`: and its pi.live lines, when split), each
 *  blob at the path the index names. */
export async function fromIndex(entry: IndexEntry, root: string, live = true): Promise<Recording> {
  const lines = parseLines(await linesAt(root, live));
  const urls = Object.fromEntries(Object.entries(entry.blobs).map(([sha, path]) => [sha, new URL(path, root).href]));
  return { id: entry.id, manifest: entry.manifest, lines, blobUrl: (sha) => urls[sha], blobType: (sha) => (urls[sha] ? typeOfName(urls[sha]!) : undefined) };
}

/** The bundled recordings: embedded in gallery.js, or listed in the index a files build ships beside them, read once and
 *  only when something needs them (a gallery, a `?r=`, a bundled baseline). */
let bundled: Promise<(GalleryEntry | IndexEntry)[]> | undefined;
export const bundledRecordings = () => (bundled ??= window.AGENTRUN_GALLERY ? Promise.resolve(window.AGENTRUN_GALLERY)
  : window.AGENTRUN_GALLERY_INDEX ? fetch(window.AGENTRUN_GALLERY_INDEX).then((response) => {
    if (!response.ok) throw new Error(`${window.AGENTRUN_GALLERY_INDEX} answered ${response.status}`);
    return response.json() as Promise<IndexEntry[]>;
  }) : Promise.resolve([]));
const isEmbedded = (each: GalleryEntry | IndexEntry): each is GalleryEntry => 'events' in each && typeof each.events === 'string';
/** A bundled recording, opened from gallery.js or fetched from its directory beside the page, with that directory.
 *  `live: false`: a view that reads no pi.live line fetches only events.jsonl. */
export async function openBundled(entry: GalleryEntry | IndexEntry, { live = true }: { live?: boolean } = {}): Promise<{ recording: Recording; dir: string }> {
  const dir = new URL(`recordings/${entry.id}/`, location.href).href;
  return { recording: isEmbedded(entry) ? fromGallery(entry) : await fromIndex(entry, dir, live), dir };
}

export function fromGallery(entry: GalleryEntry): Recording {
  return { id: entry.id, manifest: entry.manifest, lines: parseLines(entry.events), blobUrl: (sha) => entry.blobs[sha],
    blobType: (sha) => /^data:([^;,]+)/.exec(entry.blobs[sha] ?? '')?.[1] };
}

/** Every blob a recording names: its lines', its images', its result's, its artifact's files'. */
export function blobsNamed(manifest: Manifest, lines: Line[]): string[] {
  const named = new Set<string>([manifest.result?.blob, manifest.job?.blob, manifest.store?.blob].filter((sha): sha is string => sha !== undefined));
  const files = (manifest as { artifact?: { files?: Record<string, unknown> } }).artifact?.files;
  for (const sha of Object.values(files ?? {})) if (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) named.add(sha);
  for (const line of lines) {
    for (const sha of line.blobs ?? []) named.add(sha);
    for (const match of JSON.stringify(line.data).matchAll(/"blob":"([0-9a-f]{64})"/g)) named.add(match[1]!);
  }
  return [...named];
}

/** The blobs of a recording at a URL: blobs/<sha>.<ext>, where the line names the hash, so the extension is found by
 *  asking. A hash not found is asked again on a later `find`, after 1, 2, 4 and up to 32 of them, so a slow writer never
 *  draws a request for every type of every missing blob on every poll. `whole`: a run still being written may serve a
 *  blob half written, so each one is read and kept only when its bytes hash to its name; one that does not is not
 *  there yet. */
/** A blob's SHA-256 without holding the page: the browser's own digest where the page has one (a secure origin), else
 *  the viewer's, a MiB at a time. */
async function digestOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Paused(bytes);
  return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function blobsAt(root: string, whole = false) {
  const urls: Record<string, string> = {};
  const types: Record<string, string | undefined> = {};
  const texts: Record<string, string> = {};
  const held: Record<string, Uint8Array> = {};
  const missing = new Map<string, { tries: number; at: number }>();
  let round = 0;
  const found = async (sha: string, url: string): Promise<boolean> => {
    if (!whole) return (await fetch(url, { method: 'HEAD' }).catch(() => undefined))?.ok === true;
    const response = await fetch(url, { cache: 'no-store' }).catch(() => undefined);
    if (!response?.ok) return false;
    // A body cut off midway is a blob not there yet: the lines that name it are drawn, and it is asked for again.
    const body = await response.arrayBuffer().catch(() => undefined);
    if (!body) return false;
    const bytes = new Uint8Array(body);
    if (await digestOf(bytes) !== sha) return false;
    // A blob URL has the viewer's origin: a page in one must never render, so an active type becomes opaque bytes.
    const type = typeOfName(url) ?? 'application/octet-stream';
    urls[sha] = URL.createObjectURL(new Blob([bytes], { type: opensInPage(type) || type.startsWith('image/') ? type : 'application/octet-stream' }));
    types[sha] = type;
    // Its JSON and its PDF are kept as read: a page served with `connect-src 'self'` may not fetch the blob: URL.
    if (type.split(';')[0] === 'application/json') texts[sha] = new TextDecoder().decode(bytes);
    if (type.split(';')[0] === 'application/pdf') held[sha] = bytes;
    return true;
  };
  return {
    url: (sha: string) => urls[sha],
    type: (sha: string) => (types[sha] ?? (urls[sha] ? typeOfName(urls[sha]!) : undefined)),
    text: (sha: string): string | undefined => texts[sha],
    bytes: (sha: string): Promise<Uint8Array> | undefined => (held[sha] ? Promise.resolve(held[sha]!.slice()) : undefined),
    /** Looks for the blobs not found yet, and those due again; says how many it found. */
    async find(shas: readonly string[]): Promise<number> {
      round += 1;
      const due = [...missing].filter(([, wait]) => wait.at <= round).map(([sha]) => sha);
      let count = 0;
      await Promise.all([...new Set([...shas, ...due])].filter((sha) => urls[sha] === undefined).map(async (sha) => {
        for (const ext of BLOB_TYPES) {
          const url = `${root}blobs/${sha}.${ext}`;
          if (await found(sha, url)) { if (!whole) urls[sha] = url; missing.delete(sha); count += 1; return; }
        }
        const tries = (missing.get(sha)?.tries ?? 0) + 1;
        missing.set(sha, { tries, at: round + Math.min(32, 2 ** (tries - 1)) });
      }));
      return count;
    },
  };
}

export async function fromUrl(base: string, { live = true }: { live?: boolean } = {}): Promise<Recording> {
  const root = base.endsWith('/') ? base : `${base}/`;
  const manifest = await (await fetch(`${root}manifest.json`)).json() as Manifest;
  const lines = parseLines(await linesAt(root, live));
  const blobs = blobsAt(root);
  await blobs.find(blobsNamed(manifest, lines));
  return { id: root, manifest, lines, blobUrl: blobs.url, blobType: blobs.type, find: blobs.find, heldBytes: blobs.bytes };
}

export async function fromFiles(files: File[]): Promise<Recording> {
  const byPath = new Map(files.map((file) => [(file.webkitRelativePath || file.name).split('/').slice(-2).join('/'), file]));
  const find = (name: string) => [...byPath].find(([path]) => path === name || path.endsWith(`/${name}`))?.[1];
  const manifestFile = find('manifest.json');
  const eventsFile = find('events.jsonl');
  if (!manifestFile || !eventsFile) throw new Error('The folder needs manifest.json and events.jsonl.');
  // A folder holding both live files is split (draft 51): its lines are the three merged.
  const liveFile = find(LIVE_LINES);
  const indexFile = find(LIVE_INDEX);
  if (!liveFile !== !indexFile) throw new Error(`The folder holds ${liveFile ? LIVE_LINES : LIVE_INDEX} without ${liveFile ? LIVE_INDEX : LIVE_LINES}: the two come together or neither.`);
  let text = await eventsFile.text();
  if (liveFile && indexFile) {
    const merged = mergeLines(text, await liveFile.text(), await indexFile.text());
    if ('problem' in merged) throw new Error(merged.problem);
    text = merged.text;
  }
  const urls: Record<string, string> = {};
  const types: Record<string, string> = {};
  const dropped: Record<string, File> = {};
  for (const [path, file] of byPath) {
    const name = path.split('/').at(-1)!;
    if (!path.startsWith('blobs/')) continue;
    const sha = name.split('.')[0]!;
    dropped[sha] = file;
    types[sha] = typeOfName(name) ?? (file.type || 'application/octet-stream');
    // A blob URL has the viewer's origin: a page in one must never render, so an active type becomes opaque bytes.
    urls[sha] = URL.createObjectURL(opensInPage(types[sha]) || types[sha]!.startsWith('image/') ? file : new Blob([file], { type: 'application/octet-stream' }));
  }
  return { id: 'dropped', manifest: JSON.parse(await manifestFile.text()) as Manifest, lines: parseLines(text), blobUrl: (sha) => urls[sha], blobType: (sha) => types[sha],
    // A dropped file is read as a file: a host whose policy fetches only from its own origin refuses its blob: URL.
    heldBytes: (sha) => (dropped[sha] ? dropped[sha]!.arrayBuffer().then((bytes) => new Uint8Array(bytes)) : undefined) };
}
