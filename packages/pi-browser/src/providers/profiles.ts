import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserFailureError } from "../core/custody.js";
import { withLock } from "../core/downloads.js";

type Writer = { tag: string; owner: string; running?: (signal: AbortSignal) => Promise<boolean>; settle?: () => Promise<void> };
const writers = new Map<string, Writer>();
const WAIT_MS = 20_000;
const PROBE_MS = 2_000;
const refusal = (message: string) => new BrowserFailureError({ ok: false, code: "refused", retryable: false, effect: "none", message });

/** True when `work` finishes within `ms`; false at the deadline; rejects when `signal` aborts, leaving `work` to finish alone. */
async function waitFor(work: Promise<void>, signal: AbortSignal | undefined, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); }),
      new Promise<boolean>((_, reject) => { if (signal) { abort = () => reject(signal.reason); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); } }),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

/** Both vendors keep the last writer's state and neither locks, so within this process one session at a time may save to a
 *  profile. A holder that is no longer running is replaced; the same owner's successor (a relaunch asks for its replacement
 *  while the old session is still being released) waits for the release; anyone else is refused. */
export async function claimWriter(key: string, name: string, tag: string, owner: string, signal?: AbortSignal): Promise<void> {
  for (const end = Date.now() + WAIT_MS; ; ) {
    const held = writers.get(key);
    if (!held || held.tag === tag) { writers.set(key, { tag, owner }); return; }
    if (held.running && !(await held.running(AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(PROBE_MS)])).catch(() => true))) {
      if (held.settle && !(await waitFor(held.settle(), signal, end - Date.now()))) throw refusal(`browser profile "${name}": the session that was saving to it is still ending. Try again in a moment. No session was started.`);
      if (writers.get(key) === held) writers.delete(key);
      continue;
    }
    if (held.owner !== owner) throw refusal(`browser profile "${name}": one session at a time may save to a profile, and another session is saving to it now. Wait for it to end, or start without saving. No session was started.`);
    if (Date.now() > end) throw refusal(`browser profile "${name}": the session that was saving to it is still ending. Try again in a moment. No session was started.`);
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** `running` says whether the session still runs (a probe that cannot answer in time counts as running); `settle` is what a new
 *  saver must wait out after finding it stopped, when the provider is still writing its state back. */
export function noteWriter(tag: string, running: (signal: AbortSignal) => Promise<boolean>, settle?: () => Promise<void>): void {
  for (const held of writers.values()) if (held.tag === tag) Object.assign(held, { running, ...(settle ? { settle } : {}) });
}

export function freeWriter(tag: string): void {
  for (const [key, held] of writers) if (held.tag === tag) writers.delete(key);
}

export function isWriter(tag: string): boolean {
  for (const held of writers.values()) if (held.tag === tag) return true;
  return false;
}

/** Context ids are not secrets, and Browserbase has no way to look a context up by name, so the name to id map is the host's.
 *  `resolve` returns the name's context, calling `make` only when there is none, and no two callers may both make one. */
export type ProfileStore = { resolve(key: string, make: (signal: AbortSignal) => Promise<string>): Promise<string> };

const SCHEMA = "pi-browser.profiles.v1";
type ProfilesFile = { schema: typeof SCHEMA; contexts: Record<string, string> };

const defaultProfilesFile = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pi-browser", "profiles.json");
const notOurs = (file: string) => new Error(`the profiles file ${path.basename(file)} is not a pi-browser profiles file, so it was left as it is`);

async function readProfiles(file: string): Promise<ProfilesFile> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: SCHEMA, contexts: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as ProfilesFile;
    const contexts = parsed?.contexts;
    if (parsed?.schema === SCHEMA && contexts && typeof contexts === "object" && !Array.isArray(contexts) && Object.values(contexts).every((id) => typeof id === "string" && id !== "")) return parsed;
  } catch { /* not JSON */ }
  throw notOurs(file);
}

/** A JSON file, read, extended and written under one lock, so two processes' first uses of a name make one context; a file that is
 *  not this format, or cannot be read, is never overwritten. */
export function fileProfileStore(file: string = defaultProfilesFile(), options: { makeLimitMs?: number } = {}): ProfileStore {
  // The lock is taken over once it is 30 s old (core/downloads.ts's rule), so `make` must end well before: a slower one is cut here, never left
  // to run past the lock that protects it.
  const makeLimitMs = options.makeLimitMs ?? 20_000;
  return {
    async resolve(key, make) {
      await mkdir(path.dirname(file), { recursive: true });
      return withLock(`${file}.lock`, async () => {
        const current = await readProfiles(file);
        const known = current.contexts[key];
        if (known) return known;
        const limit = AbortSignal.timeout(makeLimitMs);
        // Listening before `make` does, so the cut's own words are what the caller hears.
        const cut = new Promise<never>((_, reject) => limit.addEventListener("abort", () => reject(new Error(`making the profile's context took longer than ${makeLimitMs} ms, so it was cut before the profiles file's lock could be taken over`)), { once: true }));
        const id = await Promise.race([make(limit), cut]);
        const next = `${file}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(next, `${JSON.stringify({ schema: SCHEMA, contexts: { ...current.contexts, [key]: id } }, null, 2)}\n`);
        await rename(next, file);
        return id;
      }, "the profiles file");
    },
  };
}
