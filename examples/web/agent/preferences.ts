// The agent's preferences: how the person wants things done, kept between runs. The agent's side is one plain file in
// its workspace, `work/preferences.md`, which it reads and writes with its own file tools (the preferences skill). The
// host's side: start-run.mjs puts the home's copy into a new run's workspace before the agent starts, and the server
// keeps the run's file as the home's copy when it carries the run back, only for the run that owns the sign-in (it
// held the save lease, or made the profile), so one run writes at a time.
//
// The home's copy is a plain file beside agent.sqlite (`<home>/preferences.md`), written whole (a temporary file, then a
// rename). It does not travel in a pack yet: packHome copies the agent store and runs only. Moving it into the agent
// store is pi-durable-agent's to do; the workspace file stays the agent's contract either way.
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PREFERENCES_FILE = 'preferences.md';
/** The most the home keeps: a note of how, a few lines, never a document. */
export const MAX_PREFERENCES_BYTES = 16 * 1024;

/** The home's preferences, or null when it has none. */
export async function readPreferences(homeDir: string): Promise<string | null> {
  return readFile(join(homeDir, PREFERENCES_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
}

/** Before the agent starts: the home's preferences into the run's workspace, unless the run has its own (a resumed run). */
export async function seedPreferences(homeDir: string, workDir: string): Promise<boolean> {
  const from = join(homeDir, PREFERENCES_FILE);
  const to = join(workDir, PREFERENCES_FILE);
  if (!existsSync(from) || existsSync(to)) return false;
  await copyFile(from, to);
  return true;
}

/**
 * When the server carries a run back: the run's preferences become the home's, when the run owns the sign-in (`back`
 * is carryBack's answer: it copied a profile or released a save lease) and it has a file within the size cap. Written
 * whole, so a reader sees the old file or the new one. Returns whether it wrote.
 */
export async function keepPreferences(homeDir: string, workDir: string, back: { changed: boolean; profiles: string[]; released: string[] } | undefined): Promise<boolean> {
  if (!back?.changed || (back.profiles.length === 0 && back.released.length === 0)) return false;
  const text = await readFile(join(workDir, PREFERENCES_FILE), 'utf8').catch(() => null);
  if (text === null || Buffer.byteLength(text) > MAX_PREFERENCES_BYTES) return false;
  const partial = join(homeDir, `.${PREFERENCES_FILE}.${process.pid}.partial`);
  await writeFile(partial, text, { mode: 0o600 });
  await rename(partial, join(homeDir, PREFERENCES_FILE));
  return true;
}
