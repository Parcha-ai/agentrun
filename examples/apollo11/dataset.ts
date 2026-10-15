// The Apollo 11 sources: one manifest (`sources.json`) of NASA files, each with its URL, size and SHA-256, which the reference entry
// fetches and checks on --live or --fetch-sources (`sourcesFor` names the ones an input reads). The slice (`slice/slice.json`) is what
// a run on fakes reads with no network: files cut from those, committed as the job's files, each fixed the same way. A job's input
// names what it reads: the film's windows, the transcript's pages, the photos, the typed transcript the times are checked against.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
 *  own (a `file:` URL: never fetched, the job's files hold them), and the slice manifest's SHA-256. A manifest named by `file` or
 *  `DEMO_APOLLO_SOURCES` (a test's own, of files it builds) is read alone. */
export function loadDataset(file = process.env.DEMO_APOLLO_SOURCES): { dataset: Dataset; sha256: string; slice?: string } {
  const bytes = readFileSync(file ?? DATASET_FILE);
  const dataset = JSON.parse(bytes.toString('utf8')) as Dataset;
  if (dataset.format !== 'apollo11.dataset/1') throw new Error(`${file ?? DATASET_FILE} is not an apollo11.dataset/1 manifest`);
  if (file) return { dataset, sha256: sha256Hex(bytes) };
  const { slice, sha256 } = loadSlice();
  const cuts = slice.files.flatMap((entry) => (entry.item ? [{ ...entry.item, url: pathToFileURL(join(SLICE_DIR, entry.file)).href, bytes: entry.bytes, sha256: entry.sha256, from: entry.from, cut: entry.cut } as Item] : []));
  return { dataset: { ...dataset, items: [...dataset.items, ...cuts] }, sha256: sha256Hex(bytes), slice: sha256 };
}

/** The file name an item has in the run's workspace: its id and the extension of its URL. */
export const fileOf = (item: Item) => `${item.id}${/\.[a-z0-9]+$/i.exec(new URL(item.url).pathname)?.[0]?.toLowerCase() ?? ''}`;

/** The parts of a job's input that name what it reads. */
export type Reads = { film_item: string; film_from_s: number; film_to_s: number; scan_item: string; pages_from: number; pages_to: number; photos: readonly string[]; typed_item: string; typed_file: string };

/** The items a job's input reads: the film when it reads a window, the scan when it reads a page, each photo, and the typed transcript. */
export const itemsFor = (dataset: Dataset, input: Reads): Item[] => {
  const ids = new Set([...(input.film_to_s > input.film_from_s ? [input.film_item] : []), ...(input.pages_to >= input.pages_from ? [input.scan_item] : []), ...input.photos, input.typed_item]);
  const missing = [...ids].filter((id) => !dataset.items.some((item) => item.id === id));
  if (missing.length) throw new Error(`the input names items neither sources.json nor the slice holds: ${missing.join(', ')}`);
  return dataset.items.filter((item) => ids.has(item.id));
};

/** What the reference entry fetches for an input (`sourcesFor`): the NASA files it reads. A cut of the slice is the job's own file. */
export const sourcesFor = (input: Record<string, unknown>) => itemsFor(loadDataset().dataset, input as Reads).filter((item) => /^https?:\/\//.test(item.url)).map(({ id, url, bytes, sha256 }) => ({ id, url, bytes, sha256 }));

/** The data set's item a look read, from its path (`itemOf` of the reference entry). */
export function itemOfPath(): (path: string) => string | null {
  let ids: Map<string, string> | undefined;
  return (path) => (ids ??= new Map(loadDataset().dataset.items.map((item) => [fileOf(item), item.id]))).get(basename(path)) ?? null;
}
