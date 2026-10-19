// The agent's memory: what it keeps between runs, as files in `memory/` in its workspace (the memory skill: an index,
// how the person wants things done, the accounts it works on), read and written with its own file tools. The host's
// side: start-run.mjs copies the home's memory into a new run's `work/memory/` before the agent starts, and the server
// takes the run's folder back as the home's when it carries back the run that owns the sign-in (it held the save lease,
// or made the profile), so one run writes at a time. Every file is written whole (a temporary file, then a rename); a
// file the run's folder no longer has is removed from the home.
//
// The home's memory is a plain folder beside agent.sqlite (`<home>/memory/`, owner-only). It does not travel in a pack
// yet: packHome copies the agent store and runs only. Moving it into the agent store is pi-durable-agent's to do;
// `work/memory/` stays the agent's contract either way.
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MEMORY_DIR = 'memory';
/** A memory file: a plain name, flat in the folder, markdown. */
export const MEMORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;
/** Notes, not documents: per file, in all, and how many. */
export const MAX_MEMORY_FILE_BYTES = 16 * 1024;
export const MAX_MEMORY_BYTES = 64 * 1024;
export const MAX_MEMORY_FILES = 32;

export type MemoryFile = { name: string; text: string };
export type CarriedBack = { changed: boolean; profiles: string[]; released: string[] };

/** The memory files in `dir`, by name; null when there is no folder. A name that is not a memory file, a link, a
 *  folder, or a file or folder over the caps fails it (an Error), so nothing is taken from it. Dotfiles are skipped. */
async function filesIn(dir: string): Promise<MemoryFile[] | null> {
  if (!existsSync(dir)) return null;
  const files: MemoryFile[] = [];
  let total = 0;
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith('.')) continue;
    const stat = await lstat(join(dir, name));
    if (!stat.isFile() || !MEMORY_NAME.test(name)) throw new Error(`memory/${name} is not a memory file (a plain .md file)`);
    if (stat.size > MAX_MEMORY_FILE_BYTES) throw new Error(`memory/${name} is over ${MAX_MEMORY_FILE_BYTES} bytes`);
    total += stat.size;
    files.push({ name, text: await readFile(join(dir, name), 'utf8') });
  }
  if (files.length > MAX_MEMORY_FILES || total > MAX_MEMORY_BYTES) throw new Error(`memory/ holds more than ${MAX_MEMORY_FILES} files or ${MAX_MEMORY_BYTES} bytes`);
  return files;
}

/** The home's memory files, by name; none when it has no folder or one it cannot take. */
export async function readMemory(homeDir: string): Promise<MemoryFile[]> {
  return (await filesIn(join(homeDir, MEMORY_DIR)).catch(() => null)) ?? [];
}

/** Before the agent starts: the home's memory into the run's `work/memory/`, unless the run has its own (a resumed run).
 *  Returns how many files it copied. */
export async function seedMemory(homeDir: string, workDir: string): Promise<number> {
  const to = join(workDir, MEMORY_DIR);
  if (existsSync(to)) return 0;
  const files = await readMemory(homeDir);
  if (!files.length) return 0;
  await mkdir(to, { recursive: true });
  for (const { name } of files) await copyFile(join(homeDir, MEMORY_DIR, name), join(to, name));
  return files.length;
}

/**
 * When the server carries a run back: the run's `work/memory/` becomes the home's, when the run owns the sign-in (`back`
 * is carryBack's answer: it copied a profile or released a save lease) and the folder is within the caps. A changed or
 * new file is written whole; a home file the run's folder no longer has is removed. A run with no folder changes nothing.
 * Returns the names written and removed, or null when it took nothing.
 */
export async function keepMemory(homeDir: string, workDir: string, back: CarriedBack | undefined): Promise<{ written: string[]; removed: string[] } | null> {
  if (!back?.changed || (back.profiles.length === 0 && back.released.length === 0)) return null;
  const files = await filesIn(join(workDir, MEMORY_DIR)).catch(() => null);
  if (!files) return null;
  const home = join(homeDir, MEMORY_DIR);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const before = (await readdir(home)).filter((name) => MEMORY_NAME.test(name));
  const written: string[] = [];
  for (const { name, text } of files) {
    if (before.includes(name) && (await readFile(join(home, name), 'utf8')) === text) continue;
    const partial = join(home, `.${name}.${process.pid}.partial`);
    await writeFile(partial, text, { mode: 0o600 });
    await rename(partial, join(home, name));
    written.push(name);
  }
  const removed = before.filter((name) => !files.some((file) => file.name === name));
  for (const name of removed) await rm(join(home, name), { force: true });
  return { written, removed };
}
