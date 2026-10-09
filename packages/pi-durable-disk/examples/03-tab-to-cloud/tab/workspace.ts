// The tab's workspace against the disk's work/: restore it from what the pipe sends on attach, and after a tool find
// what changed and send it. The last state the pipe acknowledged is the baseline; a change is sent whole (the file's
// content), a removal by name. Portable.
import { fromBase64, toBase64, workspaceDigest, type FileChange, type FileEntry } from "../wire.ts";
import { TAB_TMP, WORKSPACE, type WasmerEnv } from "./wasmer-env.ts";

type Seen = { kind: "file"; digest: string; size: number } | { kind: "directory" };

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
}

export class Workspace {
  readonly env: WasmerEnv;
  #baseline = new Map<string, Seen>();

  constructor(env: WasmerEnv) {
    this.env = env;
  }

  /** Every entry under the workspace except the tab's temporary files, relative paths, parents before children. */
  async scan(): Promise<Map<string, Seen & { data?: Uint8Array }>> {
    const out = new Map<string, Seen & { data?: Uint8Array }>();
    const fs = this.env.sandbox.fs;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = [...(await fs.readDir(dir))].sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        if (prefix === "" && entry.name === TAB_TMP) continue;
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const abs = `${dir}/${entry.name}`;
        if (entry.kind === "directory") {
          out.set(rel, { kind: "directory" });
          await walk(abs, rel);
        } else {
          const data = await fs.readFile(abs);
          out.set(rel, { kind: "file", digest: await digest(data), size: data.length, data });
        }
      }
    };
    await walk(WORKSPACE, "");
    return out;
  }

  /** Changes since the baseline, removals first (children before parents), then directories and files. */
  async changes(): Promise<{ changes: FileChange[]; scanned: Map<string, Seen & { data?: Uint8Array }> }> {
    const scanned = await this.scan();
    const changes: FileChange[] = [];
    const removed = [...this.#baseline.keys()].filter((p) => !scanned.has(p) || scanned.get(p)!.kind !== this.#baseline.get(p)!.kind);
    removed.sort((a, b) => b.length - a.length);
    for (const path of removed) {
      // A removed directory takes its children with it on the disk too; only the topmost removal is sent.
      if (removed.some((other) => other !== path && path.startsWith(`${other}/`))) continue;
      changes.push({ path, op: "delete" });
    }
    for (const [path, seen] of scanned) {
      const before = this.#baseline.get(path);
      if (seen.kind === "directory") {
        if (before?.kind !== "directory") changes.push({ path, op: "mkdir" });
      } else if (before?.kind !== "file" || before.digest !== seen.digest) {
        changes.push({ path, op: "write", data: toBase64(seen.data!) });
        this.env.touch(`${WORKSPACE}/${path}`);
      }
    }
    return { changes, scanned };
  }

  /** The pipe acknowledged everything up to `scanned`: it is the new baseline. */
  accept(scanned: Map<string, Seen & { data?: Uint8Array }>): void {
    this.#baseline = new Map([...scanned].map(([path, seen]) => [path, seen.kind === "file" ? { kind: "file", digest: seen.digest, size: seen.size } : { kind: "directory" }]));
  }

  /** Make the sandbox's workspace what the disk has (on attach): write every entry, remove what the disk lacks. */
  async restore(entries: readonly FileEntry[]): Promise<{ files: number; bytes: number; skipped: string[] }> {
    const fs = this.env.sandbox.fs;
    const current = await this.scan();
    const wanted = new Set(entries.map((e) => e.path));
    for (const path of [...current.keys()].sort((a, b) => b.length - a.length)) {
      if (!wanted.has(path)) await fs.remove(`${WORKSPACE}/${path}`, { recursive: true }).catch(() => undefined);
    }
    let files = 0;
    let bytes = 0;
    const skipped: string[] = [];
    for (const entry of entries) {
      const abs = `${WORKSPACE}/${entry.path}`;
      if (entry.kind === "directory") await fs.mkdir(abs, { recursive: true });
      else if (entry.kind === "file") {
        const data = fromBase64(entry.data);
        const parent = abs.slice(0, abs.lastIndexOf("/"));
        if (parent !== WORKSPACE) await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(abs, data);
        this.env.touch(abs, entry.mtimeMs);
        files++;
        bytes += data.length;
      } else skipped.push(entry.path); // the sandbox has no symbolic links; the disk keeps it
    }
    this.accept(await this.scan());
    return { files, bytes, skipped };
  }

  /** The digest of what the pipe acknowledged last (`workspaceDigest`). */
  baselineDigest(): Promise<string> {
    return workspaceDigest([...this.#baseline].map(([path, seen]) => (seen.kind === "file" ? `file ${path} ${seen.digest}` : `directory ${path}`)));
  }

  /** The workspace as the files panel shows it. */
  async list(): Promise<WorkspaceFile[]> {
    const scanned = await this.scan();
    return [...scanned].map(([path, seen]) => ({ path, kind: seen.kind, size: seen.kind === "file" ? seen.size : 0 }));
  }
}
