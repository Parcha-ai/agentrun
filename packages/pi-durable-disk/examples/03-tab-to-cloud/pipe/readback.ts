// The opt-in durability check (serve.ts --evidence-readback): after a release, read the run's work/ back from the
// disk's object store, not through the mount the pipe wrote it with, and compare it with what the pipe says it wrote
// (its kept digest) and with what the tab had acknowledged. Paths and digests only: no content is ever logged.
import { createHash } from "node:crypto";
import { manifestDigest } from "./run-pipe.ts";
import type { ManifestEntry } from "../wire.ts";

/** The object store's view of the disk: a listing (all pages) and one object's bytes. */
export interface ReadbackSource {
  list(prefix: string): Promise<{ key: string; size: number; lastModified?: Date }[]>;
  get(key: string): Promise<Uint8Array>;
}

/** What a readback found: work/ as manifest entries (directories and files with their SHA-256), and when each file changed. */
export interface Readback {
  entries: ManifestEntry[];
  files: number;
  bytes: number;
  digest: string;
  modified: Map<string, number>;
  ms: number;
}

/** The pipe's own temporaries, which no manifest holds. */
const temporary = (path: string) => path.split("/").some((part) => part.startsWith(".pipe-"));

/**
 * Read `runs/<id>/work/` from the object store: every file's SHA-256, every directory (an object whose key ends in `/`,
 * and every parent of a file), in the manifest's digest. Files are read one at a time, never all in memory.
 */
export async function readBack(source: ReadbackSource, runId: string): Promise<Readback> {
  const started = performance.now();
  const prefix = `runs/${runId}/work/`;
  const objects = await source.list(prefix);
  const dirs = new Set<string>();
  const files: ManifestEntry[] = [];
  const modified = new Map<string, number>();
  let bytes = 0;
  const addParents = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) continue;
    const rel = object.key.slice(prefix.length);
    if (rel === "" || temporary(rel.replace(/\/$/, ""))) continue;
    if (rel.endsWith("/")) {
      const dir = rel.slice(0, -1);
      dirs.add(dir);
      addParents(dir);
      continue;
    }
    addParents(rel);
    const data = await source.get(object.key);
    bytes += data.length;
    files.push({ path: rel, kind: "file", size: data.length, sha256: createHash("sha256").update(data).digest("hex"), mode: 0, mtimeMs: 0 });
    if (object.lastModified) modified.set(rel, object.lastModified.getTime());
  }
  const entries: ManifestEntry[] = [...[...dirs].map((path) => ({ path, kind: "directory" as const })), ...files];
  return { entries, files: files.length, bytes, digest: await manifestDigest(entries), modified, ms: Math.round(performance.now() - started) };
}

/** Where two views of work/ differ, by path: present in only one, or a file whose SHA-256 differs. */
export function compareEntries(kept: readonly ManifestEntry[], read: readonly ManifestEntry[]): { missing: string[]; extra: string[]; differ: string[] } {
  const index = (entries: readonly ManifestEntry[]) =>
    new Map(entries.filter((e) => e.kind === "file" || e.kind === "directory").map((e) => [e.path, e.kind === "file" ? `file ${e.sha256}` : "directory"]));
  const a = index(kept);
  const b = index(read);
  const missing = [...a.keys()].filter((p) => !b.has(p)).sort();
  const extra = [...b.keys()].filter((p) => !a.has(p)).sort();
  const differ = [...a.keys()].filter((p) => b.has(p) && a.get(p) !== b.get(p)).sort();
  return { missing, extra, differ };
}
