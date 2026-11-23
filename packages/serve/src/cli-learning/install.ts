import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { codexHookLocation, readConfigText } from './codex-worktree.js';
import { takeHold, releaseHold } from '../harness-install.js';

export type CliLearningRuntime = 'codex' | 'claude-code';
type ObjectValue = Record<string, unknown>;
type Handler = { type: 'command'; command: string; timeout: number };
type Group = ObjectValue & { hooks: unknown[] };
type Configuration = ObjectValue & { hooks?: Record<string, Group[]> };
type ReceiptFields = {
  runtime: CliLearningRuntime;
  project: string;
  dataDir: string;
  url: string;
  hadHooks: boolean;
  createdEvents: string[];
  handlers: Record<string, Handler>;
};
type JsonReceipt = ReceiptFields & { version: 1 };
type SharedReceipt = ReceiptFields & { version: 2; format: 'codex-shared-json'; configRoot: string; legacy?: JsonReceipt };
type Receipt = JsonReceipt | SharedReceipt;
export type CliLearningLocation = { project: string; runtime: CliLearningRuntime };
export type CliLearningInstallOptions = CliLearningLocation & {
  dataDir: string;
  url?: string;
  /** Executable plus fixed arguments. Never shell source; every element is quoted separately. */
  command?: string[];
};
export type CliLearningInstallStatus = {
  runtime: CliLearningRuntime;
  project: string;
  configPath: string;
  receiptPath: string;
  state: 'not-installed' | 'configured' | 'partial' | 'migration-required';
  configured: boolean;
  activation: 'unverified';
  events: { event: string; configured: boolean }[];
  instructions: string[];
  warnings: string[];
};

const eventsFor = (runtime: CliLearningRuntime): string[] => runtime === 'codex'
  ? ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd']
  : ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'];
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function cliLearningUrl(value = 'http://127.0.0.1:7340'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AgentRun learning requires an HTTP(S) loopback URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('AgentRun learning requires an HTTP(S) loopback URL on this machine.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a loopback server origin without credentials, query parameters or a path.');
  }
  return url.origin;
}

async function noSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing project configuration symlink: ${path}`);
  } catch (error) { if (!missing(error)) throw error; }
}

async function location(options: CliLearningLocation) {
  if (!['codex', 'claude-code'].includes(options.runtime)) throw new Error('runtime must be codex or claude-code');
  const project = await realpath(resolve(options.project));
  if (!(await stat(project)).isDirectory()) throw new Error('project must be a directory');
  const mapping = options.runtime === 'codex' ? await codexHookLocation(project) : { configRoot: project, linkedWorktree: false };
  const localScope = join(project, options.runtime === 'codex' ? '.codex' : '.claude');
  const localPath = join(localScope, options.runtime === 'codex' ? 'hooks.json' : 'settings.local.json');
  const scope = join(mapping.configRoot, options.runtime === 'codex' ? '.codex' : '.claude');
  const configPath = join(scope, options.runtime === 'codex' ? 'hooks.json' : 'settings.local.json');
  const receiptDir = join(project, '.agentrun', 'cli-learning');
  const receiptPath = join(receiptDir, `${options.runtime}.json`);
  for (const path of [localScope, localPath, scope, configPath, join(project, '.agentrun'), receiptDir, receiptPath]) await noSymlink(path);
  let localAvailable = false;
  try { localAvailable = (await stat(localScope)).isDirectory(); } catch (error) { if (!missing(error)) throw error; }
  return { project, scope, configPath, localScope, localPath, localAvailable, ...mapping, receiptDir, receiptPath };
}

async function readJson(path: string): Promise<ObjectValue | undefined> {
  const text = await readConfigText(path);
  if (text === undefined) return;
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value)) throw new Error();
    return value;
  } catch { throw new Error(`Invalid JSON object in ${path}; nothing was replaced.`); }
}

async function configuration(path: string): Promise<Configuration> {
  const config = await readJson(path) ?? {};
  if (config.hooks !== undefined) {
    if (!object(config.hooks)) throw new Error(`Invalid hooks in ${path}; nothing was replaced.`);
    for (const groups of Object.values(config.hooks)) {
      if (!Array.isArray(groups) || groups.some((g: unknown) => !object(g) || !Array.isArray(g.hooks))) {
        throw new Error(`Invalid hook groups in ${path}; nothing was replaced.`);
      }
    }
  }
  return config as Configuration;
}

function validReceipt(value: unknown, project: string, runtime: CliLearningRuntime, configRoot: string): value is Receipt {
  if (!object(value) || ![1, 2].includes(value.version as number) || value.project !== project || value.runtime !== runtime || typeof value.dataDir !== 'string'
    || typeof value.url !== 'string' || typeof value.hadHooks !== 'boolean' || !Array.isArray(value.createdEvents)
    || value.createdEvents.some((event) => typeof event !== 'string' || !eventsFor(runtime).includes(event)) || !object(value.handlers)
    || !isDeepStrictEqual(Object.keys(value.handlers).sort(), eventsFor(runtime).sort())
    || Object.values(value.handlers).some((h) => !object(h) || h.type !== 'command' || typeof h.command !== 'string' || !Number.isFinite(h.timeout))) return false;
  if (value.version === 1) return true;
  return runtime === 'codex' && value.format === 'codex-shared-json' && value.configRoot === configRoot && configRoot !== project
    && (value.legacy === undefined || (object(value.legacy) && value.legacy.version === 1
      && validReceipt(value.legacy, project, runtime, configRoot) && value.legacy.dataDir === value.dataDir && value.legacy.url === value.url
      && isDeepStrictEqual(value.legacy.handlers, value.handlers)));
}

async function receipt(path: string, project: string, runtime: CliLearningRuntime, configRoot: string): Promise<Receipt | undefined> {
  const value = await readJson(path);
  if (!value) return;
  if (!validReceipt(value, project, runtime, configRoot)) {
    throw new Error(`Invalid AgentRun hook receipt in ${path}; nothing was replaced.`);
  }
  return value as Receipt;
}

function jsonText(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('AgentRun hooks would exceed the project configuration size limit; nothing was replaced.');
  return text;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const text = jsonText(value);
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch (error) { if (!missing(error)) throw error; }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

function result(options: CliLearningLocation, paths: Awaited<ReturnType<typeof location>>, config: Configuration, owned?: Receipt): CliLearningInstallStatus {
  const events = eventsFor(options.runtime).map((event) => ({ event, configured: !!owned && (!paths.linkedWorktree || paths.localAvailable) && config.disableAllHooks !== true
    && (config.hooks?.[event] ?? []).some((group) => (group.matcher === undefined || group.matcher === '' || group.matcher === '*')
      && group.hooks.some((handler) => isDeepStrictEqual(handler, owned.handlers[event]))) }));
  const configured = events.every((event) => event.configured);
  return {
    runtime: options.runtime, project: paths.project, configPath: paths.configPath, receiptPath: paths.receiptPath,
    state: !owned ? 'not-installed' : configured ? 'configured' : 'partial', configured, activation: 'unverified', events,
    instructions: options.runtime === 'codex' ? [
      'In this project’s Codex session, open /hooks and trust the AgentRun hook definitions after reviewing them.',
      'Open a new Codex session, or close and resume the existing session, to load project configuration. Already loaded project layers do not hot reload.',
      'Verify /hooks lists and enables the installed events before the next prompt.',
      'Configuration alone does not prove activation. Submit a prompt and check that its run appears in AgentRun.',
    ] : [
      'In this project’s Claude Code session, verify /hooks lists the AgentRun hooks. Settings edits normally load automatically.',
      'The project must be trusted. If /hooks does not update after a few seconds, resume the session to reload it; managed policy may prohibit custom hooks.',
      'Submit a prompt and check that its run appears in AgentRun. Existing transcript history is not imported.',
    ],
    warnings: config.disableAllHooks === true ? ['Hooks are disabled by this configuration.'] : [],
  };
}

/** Reads configuration evidence only: never claims the CLI has loaded or trusted a hook. */
export async function statusCliLearning(options: CliLearningLocation): Promise<CliLearningInstallStatus> {
  const paths = await location(options);
  const owned = await receipt(paths.receiptPath, paths.project, options.runtime, paths.configRoot);
  const config = await configuration(paths.configPath);
  if (paths.linkedWorktree && owned?.version === 1) {
    const legacy = result(options, paths, await configuration(paths.localPath), owned);
    return { ...result(options, paths, config), state: legacy.configured ? 'migration-required' : 'partial',
      warnings: ['Codex loads linked-worktree hooks from the main checkout. Run learning connect again to migrate unchanged AgentRun hooks, then reopen the session.'] };
  }
  return result(options, paths, config, owned);
}

async function lock<T>(directory: string, fn: () => Promise<T>, filename = 'install.lock', waitMs = 0): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const holdPath = join(directory, filename);
  let token;
  const deadline = Date.now() + waitMs;
  while (!token) {
    token = await takeHold(directory, { holdPath, timeoutMs: Infinity, recoverUnknownOwner: false });
    if (!token) {
      if (Date.now() >= deadline) throw new Error(`AgentRun hook installation lock is held or its owner cannot be verified: ${holdPath}. Wait for the current installation to finish. For a legacy or malformed lock, stop all AgentRun connect/disconnect commands using this checkout and its linked worktrees, verify none remain, then remove only this lock and retry.`);
      await new Promise(done => setTimeout(done, 20));
    }
  }
  try { return await fn(); } finally { await releaseHold(directory, token, { holdPath }); }
}

function stripHandlers(config: Configuration, owned: Receipt, warnings: string[], stableIndices: boolean): boolean {
  let changed = false;
  for (const [event, handler] of Object.entries(owned.handlers)) {
    const groups = config.hooks?.[event];
    if (!groups) continue;
    // Never shift a surviving Codex group: its native trust key includes both array indices.
    let lastKept = -1;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (!group.hooks.some((h) => isDeepStrictEqual(h, handler)) || group.hooks.some((h) => !isDeepStrictEqual(h, handler))) lastKept = i;
    }
    const kept: Group[] = [];
    for (const [index, group] of groups.entries()) {
      const hadOwn = group.hooks.some((h) => isDeepStrictEqual(h, handler));
      for (const h of group.hooks) if (object(h) && h.command === handler.command && !isDeepStrictEqual(h, handler)) {
        warnings.push(`Left a modified ${event} hook in place; review it in /hooks.`);
      }
      if (stableIndices && hadOwn && group.hooks.some((h, i) => i > group.hooks.findIndex((value) => isDeepStrictEqual(value, handler)) && !isDeepStrictEqual(h, handler))) {
        // Stop capture even if a user has edited this group. Separate project groups keep stable indices.
        warnings.push(`Removed the AgentRun ${event} handler; this modified group's remaining hook trust keys changed. Review them in /hooks.`);
      }
      changed ||= hadOwn;
      group.hooks = group.hooks.filter((h) => !isDeepStrictEqual(h, handler));
      if (group.hooks.length || !hadOwn || (stableIndices && index <= lastKept)) kept.push(group);
    }
    config.hooks![event] = kept;
    if (!kept.length && owned.createdEvents.includes(event)) delete config.hooks![event];
  }
  if (config.hooks && !Object.keys(config.hooks).length && !owned.hadHooks) delete config.hooks;
  return changed;
}

async function cleanLegacy(paths: Awaited<ReturnType<typeof location>>, owned: JsonReceipt, warnings: string[]): Promise<void> {
  const config = await configuration(paths.localPath);
  if (stripHandlers(config, owned, warnings, false)) await writeJson(paths.localPath, config);
}

async function sharedLock<T>(paths: Awaited<ReturnType<typeof location>>, runtime: CliLearningRuntime, fn: () => Promise<T>): Promise<T> {
  // Main-checkout v1 installs/removals take this same lock as all linked worktrees.
  return runtime === 'codex' ? lock(paths.scope, fn, '.agentrun-learning.lock', 5000) : fn();
}

async function unchangedLocation(options: CliLearningLocation, expected: Awaited<ReturnType<typeof location>>): Promise<void> {
  const current = await location(options);
  if (current.project !== expected.project || current.configRoot !== expected.configRoot || current.linkedWorktree !== expected.linkedWorktree) {
    throw new Error('Git project hook scope changed during installation; nothing was replaced.');
  }
}

/** Additive, project-scoped install. The receipt owns exact handlers, not an entire settings file. */
export async function installCliLearning(options: CliLearningInstallOptions): Promise<CliLearningInstallStatus> {
  const url = cliLearningUrl(options.url);
  const paths = await location(options);
  const command = options.command ?? [process.execPath, fileURLToPath(new URL('./entry.js', import.meta.url))];
  if (!command.length || command.some((part) => !part || /[\0\r\n]/.test(part))) throw new Error('Invalid hook executable arguments.');
  const dataDir = resolve(options.dataDir);
  const line = [...command, 'learning', 'hook', '--runtime', options.runtime, '--project', paths.project, '--data', dataDir, '--url', url].map(quote).join(' ');
  const handlers = Object.fromEntries(eventsFor(options.runtime).map((event) => [event, { type: 'command' as const, command: line, timeout: 5 }]));
  // Validate before creating any project files.
  await configuration(paths.configPath);
  return lock(paths.receiptDir, async () => {
    await unchangedLocation(options, paths);
    return sharedLock(paths, options.runtime, async () => {
      await unchangedLocation(options, paths);
      const config = await configuration(paths.configPath);
      const previous = await receipt(paths.receiptPath, paths.project, options.runtime, paths.configRoot);
      const migrating = paths.linkedWorktree && previous?.version === 1;
      if (previous && (previous.dataDir !== dataDir || previous.url !== url || !isDeepStrictEqual(previous.handlers, handlers))) {
        throw new Error('AgentRun is already configured with another target; disconnect it before reconnecting.');
      }
      if (previous && !migrating) {
        if (!result(options, paths, config, previous).configured) throw new Error('AgentRun hooks were removed, disabled or modified; disconnect before reconnecting.');
        if (previous.version === 2 && previous.legacy) {
          await cleanLegacy(paths, previous.legacy, []);
          delete previous.legacy;
          await writeJson(paths.receiptPath, previous);
        }
        return result(options, paths, config, previous);
      }
      if (migrating && !result(options, paths, await configuration(paths.localPath), previous).configured) {
        throw new Error('AgentRun legacy hooks were removed, disabled or modified; disconnect before reconnecting.');
      }
      const fields: ReceiptFields = { project: paths.project, runtime: options.runtime, dataDir, url, handlers,
        hadHooks: config.hooks !== undefined, createdEvents: eventsFor(options.runtime).filter((event) => !Object.hasOwn(config.hooks ?? {}, event)) };
      const next: Receipt = paths.linkedWorktree
        ? { ...fields, version: 2, format: 'codex-shared-json', configRoot: paths.configRoot, ...(migrating ? { legacy: previous } : {}) }
        : { ...fields, version: 1 };
      config.hooks ??= {};
      for (const [event, handler] of Object.entries(handlers)) (config.hooks[event] ??= []).push({ hooks: [handler] });
      jsonText(config); // Refuse a shared file our bounded status/disconnect reader could no longer open.
      await mkdir(paths.scope, { recursive: true, mode: 0o700 });
      // Codex discovers a worktree project layer only if its local .codex directory exists.
      await mkdir(paths.localScope, { recursive: true, mode: 0o700 });
      paths.localAvailable = true;
      await writeJson(paths.receiptPath, next); // Own both files before migration can be interrupted.
      await writeJson(paths.configPath, config);
      if (next.version === 2 && next.legacy) {
        await cleanLegacy(paths, next.legacy, []);
        delete next.legacy;
        await writeJson(paths.receiptPath, next);
      }
      return result(options, paths, config, next);
    });
  });
}

/** Removes only unchanged handlers recorded by this installer; never restores a stale whole-file backup. */
export async function removeCliLearning(options: CliLearningLocation): Promise<CliLearningInstallStatus> {
  const paths = await location(options);
  if (!await receipt(paths.receiptPath, paths.project, options.runtime, paths.configRoot)) return statusCliLearning(options);
  return lock(paths.receiptDir, async () => {
    await unchangedLocation(options, paths);
    return sharedLock(paths, options.runtime, async () => {
      await unchangedLocation(options, paths);
      const owned = await receipt(paths.receiptPath, paths.project, options.runtime, paths.configRoot);
      const config = await configuration(paths.configPath);
      const warnings: string[] = [];
      if (owned) {
        if (owned.version === 1 && paths.linkedWorktree) await cleanLegacy(paths, owned, warnings);
        else if (stripHandlers(config, owned, warnings, options.runtime === 'codex')) await writeJson(paths.configPath, config);
        if (owned.version === 2 && owned.legacy) await cleanLegacy(paths, owned.legacy, warnings);
        await rm(paths.receiptPath);
      }
      return { ...result(options, paths, config), warnings };
    });
  });
}
