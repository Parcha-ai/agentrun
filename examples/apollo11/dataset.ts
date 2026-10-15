// The Apollo 11 sources: one manifest (`sources.json`) of NASA files, each with its URL, size and SHA-256. A file is used only after
// the bytes downloaded match its SHA-256; a cached copy is checked the same way before every run. The slice (`slice/slice.json`) is
// what a run reads with no network: files cut from those, committed, each fixed the same way. A job's input names what it reads: the
// film's windows, the transcript's pages, the photos, the typed transcript the times are checked against.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DATASET_FILE = join(import.meta.dirname, 'sources.json');
export const SLICE_DIR = join(import.meta.dirname, 'slice');

/** `from` and `cut`: a slice file's item, the item of sources.json it was cut from and how. */
export type ItemBase = { id: string; title: string; kind: 'film' | 'transcript' | 'photo'; role: string; url: string; license: string; bytes: number; sha256: string; source?: string; from?: string; cut?: string };
export type FilmItem = ItemBase & { kind: 'film'; duration_s: number; landing: { from_s: number; to_s: number }; window_s: number };
/** `first_page`: the source's page a cut's page 1 is. */
export type TranscriptItem = ItemBase & { kind: 'transcript'; pages?: number; landing?: { from: number; to: number }; first_page?: number };
export type PhotoItem = ItemBase & { kind: 'photo'; caption: string; class: string };
export type Item = FilmItem | TranscriptItem | PhotoItem;
export type Dataset = { format: 'apollo11.dataset/1'; classes: Record<string, string>; class_rule: string; items: Item[] };

/** A committed file of the slice: the item it is in a run when it is a cut (a photograph unchanged is sources.json's own item). */
export type SliceFile = { file: string; from: string; cut: string; bytes: number; sha256: string; item?: Omit<Item, 'url' | 'bytes' | 'sha256' | 'from' | 'cut'> };
export type Slice = { format: 'apollo11.slice/1'; about: string; files: SliceFile[] };

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The slice's manifest and the SHA-256 of its bytes. */
export function loadSlice(dir = SLICE_DIR): { slice: Slice; sha256: string } {
  const bytes = readFileSync(join(dir, 'slice.json'));
  const slice = JSON.parse(bytes.toString('utf8')) as Slice;
  if (slice.format !== 'apollo11.slice/1') throw new Error(`${dir}/slice.json is not an apollo11.slice/1 manifest`);
  return { slice, sha256: sha256Hex(bytes) };
}

/** The slice's files by name, each checked against its size and SHA-256: the job's committed files. */
export function sliceFiles(dir = SLICE_DIR): Record<string, Uint8Array> {
  return Object.fromEntries(loadSlice(dir).slice.files.map((entry) => {
    const bytes = readFileSync(join(dir, entry.file));
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) throw Object.assign(new Error(`slice/${entry.file} is not the ${entry.bytes} bytes with SHA-256 ${entry.sha256} slice.json fixes`), { code: 'DATASET_MISMATCH' });
    return [entry.file, new Uint8Array(bytes)];
  }));
}

/** The manifest and the SHA-256 of its bytes, which every recording of it names: sources.json with the slice's cuts as items of their
 *  own, and the slice manifest's SHA-256. `held` maps each item the slice holds to its committed copy's `file:` URL, so it is copied
 *  and checked, never downloaded. A manifest named by `file` or `APOLLO_SOURCES` (a test's own, of files it builds) is read alone. */
export function loadDataset(file = process.env.APOLLO_SOURCES): { dataset: Dataset; sha256: string; slice?: string; held: Map<string, string> } {
  const bytes = readFileSync(file ?? DATASET_FILE);
  const dataset = JSON.parse(bytes.toString('utf8')) as Dataset;
  if (dataset.format !== 'apollo11.dataset/1') throw new Error(`${file ?? DATASET_FILE} is not an apollo11.dataset/1 manifest`);
  if (file) return { dataset, sha256: sha256Hex(bytes), held: new Map() };
  const { slice, sha256 } = loadSlice();
  const urlOf = (entry: SliceFile) => pathToFileURL(join(SLICE_DIR, entry.file)).href;
  const cuts = slice.files.flatMap((entry) => (entry.item ? [{ ...entry.item, url: urlOf(entry), bytes: entry.bytes, sha256: entry.sha256, from: entry.from, cut: entry.cut } as Item] : []));
  const held = new Map(slice.files.map((entry) => [entry.item?.id ?? entry.from, urlOf(entry)]));
  return { dataset: { ...dataset, items: [...dataset.items, ...cuts] }, sha256: sha256Hex(bytes), slice: sha256, held };
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
      log(item.url.startsWith('file:') ? `copying ${item.id} (${(item.bytes / 1e3).toFixed(0)} kB), a local file` : `downloading ${item.id} (${(item.bytes / 1e6).toFixed(1)} MB) from ${new URL(item.url).host}`);
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
export type Reads = { film_item: string; film_from_s: number; film_to_s: number; scan_item: string; pages_from: number; pages_to: number; photos: readonly string[]; typed_item: string; typed_file: string };

/** The items a job's input reads: the film when it reads a window, the scan when it reads a page, each photo, and the typed transcript. */
export const itemsFor = (dataset: Dataset, input: Reads): Item[] => {
  const ids = new Set([...(input.film_to_s > input.film_from_s ? [input.film_item] : []), ...(input.pages_to >= input.pages_from ? [input.scan_item] : []), ...input.photos, input.typed_item]);
  const missing = [...ids].filter((id) => !dataset.items.some((item) => item.id === id));
  if (missing.length) throw new Error(`the input names items neither sources.json nor the slice holds: ${missing.join(', ')}`);
  return dataset.items.filter((item) => ids.has(item.id));
};
