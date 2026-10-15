// The Apollo 11 sources: one manifest (`sources.json`) of NASA files, each with its URL, size and SHA-256. A file is used only after
// the bytes downloaded match its SHA-256; a cached copy is checked the same way before every run. A job's input names what it reads
// of them: the film's windows, the transcript's pages, the photos.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATASET_FILE = join(import.meta.dirname, 'sources.json');

export type ItemBase = { id: string; title: string; kind: 'film' | 'transcript' | 'photo'; role: string; url: string; license: string; bytes: number; sha256: string; source?: string };
export type FilmItem = ItemBase & { kind: 'film'; duration_s: number; landing: { from_s: number; to_s: number }; window_s: number };
export type TranscriptItem = ItemBase & { kind: 'transcript'; pages?: number; landing?: { from: number; to: number } };
export type PhotoItem = ItemBase & { kind: 'photo'; caption: string; class: string };
export type Item = FilmItem | TranscriptItem | PhotoItem;
export type Dataset = { format: 'apollo11.dataset/1'; classes: Record<string, string>; class_rule: string; items: Item[] };

/** The manifest and the SHA-256 of its bytes, which every recording of it names. */
/** `APOLLO_SOURCES` names another manifest: a test's own, of files it builds. */
export function loadDataset(file = process.env.APOLLO_SOURCES || DATASET_FILE): { dataset: Dataset; sha256: string } {
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

/** Puts each checked file in the run's workspace under its own name: a hard link when the two are on one file system, else a copy.
 *  A file already there is kept only when its size and SHA-256 are the item's; any other is replaced. */
export async function placeFiles(paths: Map<string, string>, items: readonly Item[], work: string): Promise<void> {
  for (const item of items) {
    const at = join(work, fileOf(item));
    if (existsSync(at)) {
      if ((await stat(at)).size === item.bytes && (await sha256Of(at)) === item.sha256) continue;
      await rm(at, { force: true });
    }
    await mkdir(dirname(at), { recursive: true });
    try { await link(paths.get(item.id)!, at); } catch { await copyFile(paths.get(item.id)!, at); }
  }
}

/** The parts of a job's input that name what it reads. */
export type Reads = { film_item: string; film_from_s: number; film_to_s: number; scan_item: string; pages_from: number; pages_to: number; photos: readonly string[] };

/** The items a job's input reads: the film when it reads a window, the scan when it reads a page, and each photo. */
export const itemsFor = (dataset: Dataset, input: Reads): Item[] => {
  const ids = new Set([...(input.film_to_s > input.film_from_s ? [input.film_item] : []), ...(input.pages_to >= input.pages_from ? [input.scan_item] : []), ...input.photos]);
  const missing = [...ids].filter((id) => !dataset.items.some((item) => item.id === id));
  if (missing.length) throw new Error(`the input names items sources.json does not hold: ${missing.join(', ')}`);
  return dataset.items.filter((item) => ids.has(item.id));
};
