// Codex's own apply_patch, off with the built-ins. Written for AgentRun.
//
// With the built-ins off, code mode (`code_mode_host`) still lists Codex's `apply_patch` as a nested tool of `exec`, though it
// has no environment to run in: every call fails "No usable execution environment is available". Codex 0.164 has no feature
// that removes it (`apply_patch_freeform` is removed); its model catalog's `apply_patch_tool_type` does. So the session's
// machine (host/machine.ts) reads Codex's own bundled catalog from the binary the session runs (`codex debug models --bundled`),
// sets that one field null on every model, keeps it in CODEX_HOME beside the seed and names it in Codex's config
// (`model_catalog_json`, a key an app may not set: config.ts). With the built-ins on, apply_patch runs through the shell and
// stays.
import type { MachineSpawn, SessionProcess } from './host/process.js';

/** The catalog's file in `CODEX_HOME`. */
export const MODEL_CATALOG_FILE = 'model-catalog.json';

/**
 * Codex's bundled model catalog with `apply_patch_tool_type` null on every
 * model, every other field as Codex ships it; undefined when the text is not
 * a catalog (an object whose `models` is a non-empty list of objects, each
 * with a `slug`).
 */
export function withoutApplyPatch(bundled: string): string | undefined {
  let catalog: unknown;
  try {
    catalog = JSON.parse(bundled);
  } catch {
    return undefined;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(catalog)) return undefined;
  const models = catalog.models;
  if (!Array.isArray(models) || models.length === 0 || !models.every((m) => isObject(m) && typeof m.slug === 'string')) return undefined;
  return JSON.stringify({ ...catalog, models: models.map((m) => ({ ...m, apply_patch_tool_type: null })) });
}

/** The binary a session runs: its command and the arguments before Codex's own. */
export interface CodexCommand {
  command: string;
  args?: readonly string[];
  /** Told when the catalog can't be read. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** The catalog each binary gave, once read: one binary, one catalog. */
const read = new Map<string, Uint8Array>();
/** How long `codex debug models --bundled` may take (it takes milliseconds). */
const DUMP_MS = 20_000;

/** Why the session runs on Codex's own catalog, in words for the run (the machine's notes): `cause`, what went wrong. */
const stillListed = (cause: string) =>
  `Codex's own apply_patch stays listed: its bundled model catalog could not be read (${cause}). It has no environment to run in here, so a call to it fails: edit files with the host's edit and write tools.`;

/**
 * The catalog without apply_patch for `codex`, read once per binary with
 * `spawn` (`codex debug models --bundled`, its CODEX_HOME `dirs.own`, a
 * directory of its own): its `bytes`, or `why` it can't be read, never
 * silence. The session then runs on Codex's own catalog, apply_patch listed;
 * a failure is not remembered, so the next drive tries again.
 */
export async function patchlessCatalog(spawn: (options: MachineSpawn) => SessionProcess | Promise<SessionProcess>, codex: CodexCommand, dirs: { home: string; tmp: string; own: string }, signal?: AbortSignal): Promise<{ bytes: Uint8Array; why?: undefined } | { bytes?: undefined; why: string }> {
  const key = JSON.stringify([codex.command, ...(codex.args ?? [])]);
  const known = read.get(key);
  if (known) return { bytes: known };
  const failed = (cause: string, fields: Record<string, unknown>) => {
    const why = stillListed(cause);
    codex.log?.(`codex: ${why}`, fields);
    return { why };
  };
  let child: SessionProcess;
  try {
    child = await spawn({
      command: codex.command,
      args: [...(codex.args ?? []), 'debug', 'models', '--bundled'],
      cwd: dirs.own,
      ...(signal ? { signal } : {}),
      env: { HOME: dirs.home, CODEX_HOME: dirs.own, TMPDIR: dirs.tmp, NO_COLOR: '1' },
      isolatedCommands: true,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const error = String((err as Error)?.message ?? err).slice(0, 200);
    return failed(`it did not start: ${error}`, { error });
  }
  child.end();
  const out: string[] = [];
  const reading = (async () => {
    for await (const line of child.lines()) out.push(line);
  })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([child.exited, new Promise<undefined>((r) => (timer = setTimeout(r, DUMP_MS, undefined)))]);
  clearTimeout(timer);
  if (!exit) {
    child.kill('SIGKILL');
    await child.exited;
  }
  await reading;
  if (signal?.aborted) throw signal.reason ?? new Error('agentrun-harness-codex: the drive stopped');
  const catalog = exit?.code === 0 ? withoutApplyPatch(out.join('\n')) : undefined;
  if (!catalog) {
    const stderr = child.stderrTail().trim().slice(-300);
    const cause = !exit ? `no answer in ${DUMP_MS / 1000} s` : exit.code === 0 ? 'its answer is not a catalog' : `exit ${exit.code === null ? `signal ${exit.signal}` : `code ${exit.code}`}${stderr ? `: ${stderr.split('\n').at(-1)}` : ''}`;
    return failed(cause, { exit: exit ?? 'none', stderr });
  }
  const bytes = new TextEncoder().encode(catalog);
  read.set(key, bytes);
  return { bytes };
}
