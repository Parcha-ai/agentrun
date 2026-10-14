// The Apollo 11 data set: one manifest (`dataset.json`) of NASA files, each with its URL, size and SHA-256. A file is used only
// after the bytes downloaded match its SHA-256; a cached copy is checked the same way before every run. What a run reads is a
// selection of it: the film in windows, the transcript's pages, the photos.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { link, mkdir, copyFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATASET_FILE = join(import.meta.dirname, 'dataset.json');

export type ItemBase = { id: string; title: string; kind: 'film' | 'transcript' | 'photo'; role: string; url: string; license: string; bytes: number; sha256: string; source?: string };
export type FilmItem = ItemBase & { kind: 'film'; duration_s: number; landing: { from_s: number; to_s: number }; window_s: number };
export type TranscriptItem = ItemBase & { kind: 'transcript'; pages?: number; landing?: { from: number; to: number } };
export type PhotoItem = ItemBase & { kind: 'photo'; caption: string; class: string };
export type Item = FilmItem | TranscriptItem | PhotoItem;
export type Dataset = { format: 'apollo11.dataset/1'; classes: Record<string, string>; class_rule: string; items: Item[] };

/** The manifest and the SHA-256 of its bytes, which every recording of it names. */
export function loadDataset(file = DATASET_FILE): { dataset: Dataset; sha256: string } {
  const bytes = readFileSync(file);
  const dataset = JSON.parse(bytes.toString('utf8')) as Dataset;
  if (dataset.format !== 'apollo11.dataset/1') throw new Error(`${file} is not an apollo11.dataset/1 manifest`);
  return { dataset, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export const itemOf = (dataset: Dataset, id: string): Item => {
  const item = dataset.items.find((each) => each.id === id);
  if (!item) throw new Error(`the data set has no item ${id}`);
  return item;
};

/** The file name an item has in the run's workspace: its id and the extension of its URL. */
export const fileOf = (item: Item) => `${item.id}${/\.[a-z0-9]+$/i.exec(new URL(item.url).pathname)?.[0]?.toLowerCase() ?? ''}`;

const sha256Of = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

/** Each item in `cache`, downloaded once and checked against its size and SHA-256 every time; a file that does not match is
 *  removed and refused. A `file:` URL is copied, so a test can build its own data set. */
export async function fetchItems(items: readonly Item[], cache: string, log: (line: string) => void = () => {}): Promise<Map<string, string>> {
  await mkdir(cache, { recursive: true });
  const paths = new Map<string, string>();
  for (const item of items) {
    const at = join(cache, fileOf(item));
    if (!existsSync(at)) {
      log(`downloading ${item.id} (${(item.bytes / 1e6).toFixed(1)} MB) from ${new URL(item.url).host || 'a local file'}`);
      const partial = `${at}.${process.pid}.partial`;
      if (item.url.startsWith('file:')) await copyFile(fileURLToPath(item.url), partial);
      else {
        const response = await fetch(item.url, { redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`${item.id}: ${item.url} answered ${response.status}`);
        await writeFile(partial, response.body as unknown as AsyncIterable<Uint8Array>);
      }
      await rename(partial, at);
    }
    const size = (await stat(at)).size;
    const sha256 = await sha256Of(at);
    if (size !== item.bytes || sha256 !== item.sha256) {
      await rm(at, { force: true });
      throw Object.assign(new Error(`${item.id}: the downloaded file is ${size} bytes with SHA-256 ${sha256}, not the ${item.bytes} bytes and ${item.sha256} the data set fixes. It was removed and nothing ran.`), { code: 'DATASET_MISMATCH' });
    }
    paths.set(item.id, at);
  }
  return paths;
}

/** Puts each checked file in the run's workspace under its own name: a hard link when the two are on one file system, else a copy. */
export async function placeFiles(paths: Map<string, string>, items: readonly Item[], work: string): Promise<void> {
  for (const item of items) {
    const at = join(work, fileOf(item));
    if (existsSync(at)) continue;
    await mkdir(dirname(at), { recursive: true });
    try { await link(paths.get(item.id)!, at); } catch { await copyFile(paths.get(item.id)!, at); }
  }
}

export type Mode = 'quick' | 'full';
/** What one run reads: the film's windows, the transcript's pages and the photos (by item id; each one's file is `<id><photo_ext>`),
 *  and the film's and the scan's item ids and files in the workspace. */
export type Selection = {
  files: { film: string; film_file: string; scan: string; scan_file: string; photo_ext: string };
  windows: { from_s: number; to_s: number }[];
  pages: number[];
  photos: string[];
};

/** `quick`: the landing (the film's cuts that hold it, the transcript's landing pages, every photo). `full`: the whole film and every
 *  page. `only` narrows a selection to some of its lanes (the weak-eyes scene reads the pages and the photos). */
export function select(dataset: Dataset, mode: Mode, only?: readonly ('film' | 'transcript' | 'photos')[]): Selection {
  const film = dataset.items.find((item): item is FilmItem => item.kind === 'film');
  const scan = dataset.items.find((item): item is TranscriptItem => item.kind === 'transcript' && item.pages !== undefined);
  const windows: Selection['windows'] = [];
  if (film && (!only || only.includes('film'))) {
    const [from, to] = mode === 'quick' ? [film.landing.from_s, film.landing.to_s] : [0, Math.floor(film.duration_s)];
    for (let at = from; at < to; at += film.window_s) windows.push({ from_s: at, to_s: Math.min(to, at + film.window_s) });
  }
  const pages: number[] = [];
  if (scan && (!only || only.includes('transcript'))) {
    const [from, to] = mode === 'quick' && scan.landing ? [scan.landing.from, scan.landing.to] : [1, scan.pages!];
    for (let page = from; page <= to; page += 1) pages.push(page);
  }
  const own = !only || only.includes('photos') ? dataset.items.filter((item): item is PhotoItem => item.kind === 'photo') : [];
  const exts = new Set(own.map((item) => fileOf(item).slice(item.id.length)));
  if (exts.size > 1) throw new Error(`the photos' files end in ${[...exts].join(' and ')}: a run reads one kind`);
  return { files: { film: film?.id ?? '', film_file: film ? fileOf(film) : '', scan: scan?.id ?? '', scan_file: scan ? fileOf(scan) : '', photo_ext: [...exts][0] ?? '' }, windows, pages, photos: own.map((item) => item.id) };
}

/** The items a selection reads. */
export const itemsOf = (dataset: Dataset, selection: Selection): Item[] => {
  const ids = new Set([...(selection.windows.length ? [selection.files.film] : []), ...(selection.pages.length ? [selection.files.scan] : []), ...selection.photos]);
  return dataset.items.filter((item) => ids.has(item.id));
};
