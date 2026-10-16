import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Session } from "@earendil-works/pi-durable";
import { modeRefusal, type Repo } from "@parcha/pi-git-remote";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Learning, parseLearning } from "./entry.js";
import { LearnError } from "./errors.js";
import { assertNotRulesLocked, CAPS, COMMIT_SHA, LAYOUT, LEARNING_ID } from "./layout.js";
import { deriveSeed, renderSection, type SeedRecord, type WorkflowHint } from "./section.js";

type SeedState = { sha: string; index: string[]; omitted: string[]; workflows: WorkflowHint[]; copied: boolean };

/** What the run was seeded from: the agent repository commit and the index derived there. Written once per run. */
export const SeedDoc = defineDoc<SeedState>({ kind: "learn.seed", version: 1, scope: "session", initial: () => ({ sha: "", index: [], omitted: [], workflows: [], copied: false }) });

/** The seed recorded in a run's store, or undefined before `seedLearning`. A Harness is a valid `target`. */
export async function readSeed(target: Pick<Session, "snapshot">, context: Context = BACKGROUND_CONTEXT): Promise<SeedRecord | undefined> {
  const doc = await target.snapshot(SeedDoc, context);
  return doc && doc.sha ? structuredClone(doc) as SeedRecord : undefined;
}

export type SeedOptions = {
  /** The agent repository. Only fetch, resolve, list and read are used. */
  readonly repo: Pick<Repo, "fetch" | "resolve" | "list" | "read">;
  /** A branch or commit; default `main`. */
  readonly ref?: string;
  /** The run's store: a pi-durable Harness, or any `commit` and `snapshot`. */
  readonly target: Pick<Session, "commit" | "snapshot">;
  /** The run's working directory: the active learnings are copied to `<into>/.agent/learnings/<id>.md`. */
  readonly into?: string;
  /** Workflows the host found for this run's input. */
  readonly workflows?: readonly WorkflowHint[];
  readonly context?: Context;
};

export type Skipped = { readonly path: string; readonly reason: string };

export type Seeded = SeedRecord & {
  /** The `<learned>` section body the model sees (with `learn` offered). */
  readonly section: string;
  /** False when the run's store already held a seed, which is kept. */
  readonly recorded: boolean;
  /** Learning files at the commit that were not loaded, and why. */
  readonly skipped: readonly Skipped[];
  /** Files written under `into`, relative to it. */
  readonly files: readonly string[];
};

const ENTRY = new RegExp(`^${LAYOUT.learnings}/(L-[0-9a-f]{12})\\.md$`);

async function learningsAt(repo: SeedOptions["repo"], sha: string): Promise<{ learnings: Learning[]; files: Map<string, string>; skipped: Skipped[] }> {
  const learnings: Learning[] = [];
  const files = new Map<string, string>();
  const skipped: Skipped[] = [];
  for (const entry of await repo.list(LAYOUT.learnings, sha)) {
    const match = ENTRY.exec(entry.path);
    if (!match) {
      skipped.push({ path: entry.path, reason: "not a learning file name (learnings/L-<12 hex>.md)" });
      continue;
    }
    const mode = entry.type === "blob" ? modeRefusal(entry.mode) : `a ${entry.type}`;
    if (mode) {
      skipped.push({ path: entry.path, reason: mode });
      continue;
    }
    if (entry.size !== undefined && entry.size > CAPS.learning) {
      skipped.push({ path: entry.path, reason: `${entry.size} bytes, over the ${CAPS.learning} byte cap` });
      continue;
    }
    const text = await repo.read(entry.path, sha);
    if (text === undefined) continue;
    try {
      const learning = parseLearning(text);
      if (learning.id !== match[1]) throw new LearnError("format", `its id is ${learning.id}`);
      learnings.push(learning);
      files.set(learning.id, text);
    } catch (error) {
      if (!(error instanceof LearnError)) throw error;
      skipped.push({ path: entry.path, reason: error.message });
    }
  }
  return { learnings, files, skipped };
}

async function realDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const stat = await lstat(dir);
  if (!stat.isDirectory()) throw new LearnError("invalid", `${dir} is not a directory`);
}

/** Installs each file whole: written into a staging directory this call creates under `.agent/` (never inside the
 *  learnings directory), then renamed over its name, so an interrupted copy never leaves a partial file under the name
 *  and a restart restores the stored bytes over whatever is there. A call removes only its own staging directory, so
 *  concurrent calls never touch each other's files; one a crash interrupted is left where it is. */
async function copyInto(into: string, files: ReadonlyMap<string, string>): Promise<string[]> {
  if (typeof into !== "string" || !path.isAbsolute(into)) throw new LearnError("invalid", "into is an absolute directory");
  const rel = [...files.keys()].map((id) => path.posix.join(LAYOUT.seeded, `${id}.md`));
  assertNotRulesLocked(rel);
  for (const id of files.keys()) if (!LEARNING_ID.test(id)) throw new LearnError("invalid", "not a learning id");
  await mkdir(into, { recursive: true, mode: 0o755 });
  const [top, ...rest] = LAYOUT.seeded.split("/");
  const agentDir = path.join(into, top!);
  await realDirectory(agentDir);
  let at = agentDir;
  for (const part of rest) {
    at = path.join(at, part);
    await realDirectory(at);
  }
  const staging = path.join(agentDir, `.seeding-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  const written: string[] = [];
  try {
    for (const [id, text] of files) {
      const partial = path.join(staging, `${id}.md`);
      const handle = await open(partial, "wx", 0o644);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(partial, path.join(at, `${id}.md`));
      } catch (error) {
        throw new LearnError("invalid", `${path.posix.join(LAYOUT.seeded, `${id}.md`)} cannot be replaced: ${(error as NodeJS.ErrnoException).code ?? "error"}`, { cause: error });
      }
      written.push(path.posix.join(LAYOUT.seeded, `${id}.md`));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return written;
}

/**
 * Host step at run start: resolve `ref` in the agent repository, read the learnings at that commit, derive the index
 * under the section cap, record `{ sha, index }` in the run's store as `learn.seed`, and copy the active learnings into
 * the run's working directory for reading. A run is seeded once: when its store already holds a seed, that commit is
 * used again and the record is kept, so a restarted host never moves a run to a newer commit.
 */
export async function seedLearning(options: SeedOptions): Promise<Seeded> {
  if (!options || typeof options !== "object" || !options.repo || !options.target) throw new LearnError("invalid", "seedLearning needs { repo, target }");
  const context = options.context ?? BACKGROUND_CONTEXT;
  const ref = options.ref ?? "main";
  if (typeof ref !== "string" || ref.trim() === "") throw new LearnError("invalid", "ref is a branch or a commit");
  const existing = await readSeed(options.target, context);
  await options.repo.fetch();
  const sha = existing?.sha ?? (await options.repo.resolve(ref));
  if (!sha) throw new LearnError("missing", `${ref} names no commit in the agent repository`);
  if (!COMMIT_SHA.test(sha)) throw new LearnError("invalid", "the repository resolved a ref to something that is not a commit id");
  const { learnings, files, skipped } = await learningsAt(options.repo, sha);
  const derived = deriveSeed(sha, learnings, { workflows: existing?.workflows ?? options.workflows ?? [], copied: existing?.copied ?? options.into !== undefined });
  const seed: SeedRecord = existing ?? { sha, index: derived.index, omitted: derived.omitted, workflows: derived.workflows, copied: derived.copied };
  const active = new Map([...files].filter(([id]) => learnings.find((l) => l.id === id)?.status === "active"));
  const written = options.into === undefined ? [] : await copyInto(options.into, active);
  let recorded = false;
  if (!existing) {
    recorded = await options.target.commit(async (tx) => {
      const doc = await tx.doc(SeedDoc);
      if (doc.sha) return false;
      Object.assign(doc, structuredClone(seed));
      return true;
    }, context);
  }
  const kept = recorded ? seed : ((await readSeed(options.target, context)) ?? seed);
  return {
    ...kept,
    section: renderSection(kept),
    recorded,
    skipped: [...skipped, ...derived.unshown.map((id) => ({ path: `${LAYOUT.learnings}/${id}.md`, reason: "its first line holds the section's tag" }))],
    files: written,
  };
}
