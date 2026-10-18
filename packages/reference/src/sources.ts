// `sources.json`: the checked files a demo reads, each `{ id, url, bytes, sha256, license }`, fetched into the run's `work/` as `<id><extension of the URL's path>` and verified by size and hash. A file already there whose hash
// matches is kept and not fetched again. A fetch that answers anything but the checked bytes is refused, naming the file, what was checked and what came: a demo never reads an unchecked source. A no-key run uses the files
// the demo commits (`job.files`); the fetch is for `--live` and `--fetch-sources`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

export type SourceItem = { id: string; url: string; bytes: number; sha256: string; license?: string };
export type Sources = { items: SourceItem[] };

/** The file name of an item in `work/`: its id and the extension of its URL's path. */
export const fileOf = (item: SourceItem): string => `${item.id}${extname(new URL(item.url).pathname)}`;

/** The checks every list of items passes, wherever it came from: ids that are file names, http(s) URLs, a size and a hash, and no two items that are the same file (the second would replace the first, and both checks would pass). */
export function checkItems(items: unknown, label: string): SourceItem[] {
  if (!Array.isArray(items)) throw new Error(`${label} has no items: it lists the checked files as { id, url, bytes, sha256 }`);
  for (const item of items as SourceItem[]) {
    if (!item || typeof item.id !== 'string' || !/^[\w.-]+$/.test(item.id)) throw new Error(`${label}: an item's id is a file name (letters, digits, dot, dash, underscore), not ${JSON.stringify(item?.id)}`);
    if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) throw new Error(`${label}: ${item.id} has no http or https url`);
    if (!Number.isInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`${label}: ${item.id} needs its size in bytes and its SHA-256`);
  }
  const names = new Map<string, string>();
  for (const item of items as SourceItem[]) {
    const name = fileOf(item);
    if (names.has(name)) throw new Error(`${label}: ${item.id} and ${names.get(name)} are both ${name}: an id and a URL extension make one file`);
    names.set(name, item.id);
  }
  return items as SourceItem[];
}

/** A demo's `sources.json` has two kinds of entry: `files` (or `items`), fetched and checked by size and SHA-256, and `pages`, which the agent visits live (each with its URL, what it shows and its hand-check date). Pages are passed through untouched: never fetched, never refused. */
export function readSources(path: string): Sources {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown; items?: unknown; pages?: unknown };
  if (file.files === undefined && file.items === undefined) {
    if (Array.isArray(file.pages)) return { items: [] };
    throw new Error(`${path} lists neither files (checked by size and SHA-256) nor pages (visited live)`);
  }
  return { items: checkItems(file.files ?? file.items, path) };
}

/** The files of `items` that are neither in the job's own files nor already in `work`: what a no-key run would lack. */
export function missingCommitted(items: readonly SourceItem[], files: Record<string, Uint8Array> | undefined, work: string): string[] {
  return items.map(fileOf).filter((name) => !(files && name in files) && !existsSync(join(work, name)));
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Fetches each item into `work` and verifies it; returns what was fetched and what was already there. */
/** `timeoutMs` is each download's deadline, the request and the reading of its body together (default 60 s). */
export async function fetchSources(sources: Sources, work: string, fetcher: typeof fetch = fetch, timeoutMs = 60_000, cache?: string): Promise<{ fetched: string[]; kept: string[]; cached: string[] }> {
  const fetched: string[] = [];
  const kept: string[] = [];
  const cached: string[] = [];
  for (const item of sources.items) {
    const name = fileOf(item);
    const at = join(work, name);
    if (existsSync(at) && sha(readFileSync(at)) === item.sha256) { kept.push(name); continue; }
    // A copy in the download cache (by its hash) is used when it still has the checked bytes: a re-run does not fetch it again.
    const copy = cache ? join(cache, item.sha256) : undefined;
    if (copy && existsSync(copy)) {
      const have = readFileSync(copy);
      if (have.length === item.bytes && sha(have) === item.sha256) {
        await mkdir(dirname(at), { recursive: true });
        await writeFile(`${at}.${process.pid}.partial`, have);
        await rename(`${at}.${process.pid}.partial`, at);
        cached.push(name);
        continue;
      }
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let bytes: Uint8Array;
    try {
      const response = await fetcher(item.url, { signal });
      if (!response.ok) throw new Error(`${name}: ${item.url} answered ${response.status}`);
      // The size is the item's: a body larger than it is refused as it streams, never buffered whole (the deadline limits time, not bytes).
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > item.bytes) throw new Error(`${name}: ${item.url} is larger than the checked file (${declared} bytes, expected ${item.bytes})`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > item.bytes) { await reader.cancel().catch(() => undefined); throw new Error(`${name}: ${item.url} is larger than the checked file (more than ${item.bytes} bytes)`); }
          chunks.push(value);
        }
      } else { const whole = new Uint8Array(await response.arrayBuffer()); if (whole.length > item.bytes) throw new Error(`${name}: ${item.url} is larger than the checked file (${whole.length} bytes, expected ${item.bytes})`); chunks.push(whole); size = whole.length; }
      bytes = new Uint8Array(size);
      let at2 = 0;
      for (const chunk of chunks) { bytes.set(chunk, at2); at2 += chunk.length; }
    } catch (error) {
      if (signal.aborted) throw new Error(`${name}: ${item.url} did not finish within ${timeoutMs} ms`, { cause: error });
      throw error;
    }
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`${name}: not the checked file: expected ${item.bytes} bytes with SHA-256 ${item.sha256}, got ${bytes.length} bytes with ${sha(bytes)}`);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(`${at}.${process.pid}.partial`, bytes);
    await rename(`${at}.${process.pid}.partial`, at);
    if (copy) {
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(`${copy}.${process.pid}.partial`, bytes);
      await rename(`${copy}.${process.pid}.partial`, copy);
    }
    fetched.push(name);
  }
  return { fetched, kept, cached };
}

/** The files a box is given: the job's own, and each fetched source (a Docker box shares nothing with `work/`, so it is uploaded). */
export function withSources(files: Record<string, Uint8Array> | undefined, work: string, names: readonly string[]): Record<string, Uint8Array> {
  return { ...(files ?? {}), ...Object.fromEntries(names.map((name) => [name, new Uint8Array(readFileSync(join(work, name)))])) };
}
