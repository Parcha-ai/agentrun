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

export function readSources(path: string): Sources {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown };
  if (!Array.isArray(parsed.items)) throw new Error(`${path} has no items: it lists the checked files as { id, url, bytes, sha256 }`);
  for (const item of parsed.items as SourceItem[]) {
    if (!item || typeof item.id !== 'string' || !/^[\w.-]+$/.test(item.id)) throw new Error(`${path}: an item's id is a file name (letters, digits, dot, dash, underscore), not ${JSON.stringify(item?.id)}`);
    if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) throw new Error(`${path}: ${item.id} has no http or https url`);
    if (!Number.isInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`${path}: ${item.id} needs its size in bytes and its SHA-256`);
  }
  return parsed as Sources;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Fetches each item into `work` and verifies it; returns what was fetched and what was already there. */
export async function fetchSources(sources: Sources, work: string, fetcher: typeof fetch = fetch): Promise<{ fetched: string[]; kept: string[] }> {
  const fetched: string[] = [];
  const kept: string[] = [];
  for (const item of sources.items) {
    const name = fileOf(item);
    const at = join(work, name);
    if (existsSync(at) && sha(readFileSync(at)) === item.sha256) { kept.push(name); continue; }
    const response = await fetcher(item.url);
    if (!response.ok) throw new Error(`${name}: ${item.url} answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`${name}: not the checked file: expected ${item.bytes} bytes with SHA-256 ${item.sha256}, got ${bytes.length} bytes with ${sha(bytes)}`);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(`${at}.${process.pid}.partial`, bytes);
    await rename(`${at}.${process.pid}.partial`, at);
    fetched.push(name);
  }
  return { fetched, kept };
}
