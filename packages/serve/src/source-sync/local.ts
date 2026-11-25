/** Explicit same-machine export consent. A loopback URL alone is not proof: it can forward to another host.
 * Only newly granted rows are scanned; native/capture enrollment without this consent retains its old behavior. */
import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { getAgent } from "../agents-store.js";
import type { CliConnection } from "../cli-learning/connections.js";
import { ApiError } from "../errors.js";
import { nativeOf } from "../native/binding.js";
import { selectedNative } from "../native/connection.js";
import { nativeIdentity, nativeMachineId } from "../native/discovery.js";
import { nativeEnvironment } from "../native/environment.js";
import { isNativeRuntime, NATIVE_RUNTIME_FACTS } from "../native/runtimes.js";
import { sourceNativeEnvironmentFacts } from "../native/source-runtime-tools.js";
import { exportSourceSnapshot, SourceSnapshotError } from "../native/source-snapshot.js";
import { runnerSecrets } from "../runner/redact.js";
import { canonical, cliLearningOf, isObject } from "../store/agent-body.js";
import type { SettingsGuard, Store } from "../store/store.js";
import { SourceSync, sourceKey, type SourceAuthority, type SourceIdentity, type SourceRecord } from "./registry.js";
import { sourceSyncOf } from "./types.js";
import { SourcePreparationError } from "./prepare.js";

export type SourceLocalConsent = { readonly version: 1; readonly scope: string };
type LocalRecord = {
  readonly version: 1; readonly agent_id: string; readonly active: boolean; readonly generation: string;
  readonly scope: string; readonly source: SourceIdentity; readonly capture_revision: string;
  readonly cli?: { readonly connection_id: string; readonly generation: string };
};
export const sourceLocalKey = (agentId: string): string => `source-sync.local.${agentId}`;
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const denied = (message = "Enable sync from this agent's original source machine and user profile."): ApiError => new ApiError("forbidden", message);
const changed = (): ApiError => new ApiError("precondition_failed", "The local source connection changed. Enable sync again from its source.");
const identity = (target: SourceIdentity): SourceIdentity => ({ runtime: target.runtime, machine_id: target.machine_id, project: target.project, selector: target.selector });
const consentOf = (value: unknown): value is SourceLocalConsent => isObject(value) && Object.keys(value).every(key => ["version", "scope"].includes(key)) && value.version === 1 && typeof value.scope === "string" && /^[a-f0-9]{64}$/.test(value.scope);

async function folders(target: SourceIdentity, env: NodeJS.ProcessEnv) {
  if (!isNativeRuntime(target.runtime) || process.platform !== "linux" || !process.geteuid || target.machine_id !== await nativeMachineId()) throw denied();
  const home = env.HOME || homedir();
  const explicit = NATIVE_RUNTIME_FACTS[target.runtime].protocol === "codex-json" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
  const paths = [target.project, home, ...(explicit ? [explicit] : [])];
  if (paths.some(path => !isAbsolute(path))) throw denied();
  const held = [];
  for (const path of paths) {
    try {
      const canonicalPath = await realpath(path), information = await stat(canonicalPath, { bigint: true });
      if (!information.isDirectory()) throw denied();
      held.push({ path: canonicalPath, device: information.dev.toString(), inode: information.ino.toString() });
    } catch { throw denied("The approved source project or native profile folder is unavailable. Reconnect it on the source machine."); }
  }
  const source = { runtime: target.runtime, machine_id: target.machine_id, project: held[0]!.path,
    selector: { kind: target.selector.kind, ...(target.selector.name === undefined ? {} : { name: target.selector.name }) } };
  const scope = digest({ version: 1, source, uid: process.geteuid(), project: held[0], home: held[1], explicit: held[2] ?? null,
    environment: sourceNativeEnvironmentFacts(env) });
  return { consent: { version: 1 as const, scope }, home: held[1]!.path, explicit: held[2]?.path,
    roots: [...new Set(held.map(item => item.path))], expectedRoots: [...new Map(held.map(item => [item.path, item])).values()] };
}

/** The wire carries only this digest, never device/inode/user/profile metadata. Configuration contents are not in
 * the scope: editing those contents is the authorized input to sync. Replacing a folder or changing user is not. */
export async function sourceLocalConsent(target: SourceIdentity, env = nativeEnvironment()): Promise<SourceLocalConsent> {
  return (await folders(target, env)).consent;
}

export interface LocalSourcesOptions {
  readonly env?: () => NodeJS.ProcessEnv;
  readonly selected?: typeof selectedNative;
  readonly export?: typeof exportSourceSnapshot;
  readonly secrets?: () => readonly string[];
}
export class LocalSources {
  constructor(readonly store: Store, readonly options: LocalSourcesOptions = {}) {}

  private async capture(agentId: string, row?: LocalRecord, freshConsent = false) {
    const entry = await getAgent(this.store, agentId);
    if (!entry?.revision || entry.agent.archivedAt || entry.agent.purgedAt || entry.agent.externalRef) throw denied();
    const moved = sourceSyncOf(entry.revision.body), source = await this.store.settings.get(sourceKey(agentId)) as SourceRecord | undefined;
    if (source?.connection) throw denied("This agent already syncs through its source connector.");
    if (moved && (!row || source?.id !== moved.id || source.capture_revision !== row.capture_revision)) throw denied();
    const revision = moved ? await this.store.agents.revision(row!.capture_revision) : entry.revision;
    if (!revision || revision.agentId !== agentId) throw denied();
    const cli = cliLearningOf(revision.body), native = nativeOf(revision.body);
    if (cli) {
      const connection = await this.store.settings.get(`cli-learning-connection:${cli.connection_id}`) as CliConnection | undefined;
      if (!connection?.active || connection.agent_id !== agentId || connection.runtime !== cli.runtime || connection.project !== cli.project
        || connection.native.remote || connection.native.selector.kind !== "project" || connection.native.runtime !== cli.runtime || connection.native.project !== cli.project) throw denied();
      if (row && (row.cli?.connection_id !== connection.connection_id || !freshConsent && row.cli.generation !== connection.generation)) throw denied();
      return { target: connection.native, revision: revision.id, cli: { connection_id: connection.connection_id, generation: connection.generation },
        guards: [{ key: `cli-learning-connection:${cli.connection_id}`, fields: { active: true, generation: connection.generation, agent_id: agentId } }] satisfies SettingsGuard[] };
    }
    if (!native?.connected || native.remote || row?.cli) throw denied();
    return { target: native, revision: revision.id, guards: [] as SettingsGuard[] };
  }

  /** Called after explicit CLI consent, before SourceSync.grant. An owner-disabled source record stays disabled;
   * this proves export scope, not permission to undo the owner's pause or move execution back to the source. */
  async grant(agentId: string, consent: unknown): Promise<SourceAuthority> {
    if (!consentOf(consent)) throw denied("This connection did not grant configuration and project sync from its source.");
    const previous = await this.store.settings.get(sourceLocalKey(agentId)) as LocalRecord | undefined;
    const capture = await this.capture(agentId, previous, true), env = { ...(this.options.env?.() ?? nativeEnvironment()) };
    // Check the scope before discovery can inspect source config, then repeat over its independently found target.
    if ((await sourceLocalConsent(identity(capture.target), env)).scope !== consent.scope) throw denied();
    const target = await (this.options.selected ?? selectedNative)(identity(capture.target), env);
    if (nativeIdentity(target) !== nativeIdentity(capture.target) || (await sourceLocalConsent(identity(target), env)).scope !== consent.scope) throw denied();
    const candidate: LocalRecord = { version: 1, agent_id: agentId, active: true, generation: randomBytes(24).toString("base64url"), scope: consent.scope,
      source: identity(target), capture_revision: capture.revision, ...(capture.cli ? { cli: capture.cli } : {}) };
    if (previous && canonical(previous.source) !== canonical(candidate.source)) throw denied();
    if (previous?.active && previous.scope === candidate.scope && canonical(previous.cli ?? null) === canonical(candidate.cli ?? null)) return this.authorize(agentId);
    if (previous) {
      if (!await this.store.settings.replaceIf(sourceLocalKey(agentId), previous, candidate, undefined, capture.guards)) throw changed();
    } else {
      const saved = await this.store.settings.putIfAbsent(sourceLocalKey(agentId), candidate) as LocalRecord;
      if (saved.generation !== candidate.generation) throw changed();
    }
    return this.authorize(agentId);
  }

  private async checked(agentId: string) {
    const row = await this.store.settings.get(sourceLocalKey(agentId)) as LocalRecord | undefined;
    if (!row?.active || row.version !== 1 || row.agent_id !== agentId) throw denied();
    const capture = await this.capture(agentId, row), env = { ...(this.options.env?.() ?? nativeEnvironment()) };
    if (capture.target.runtime !== row.source.runtime || nativeIdentity(capture.target) !== nativeIdentity({ ...row.source, runtime: capture.target.runtime })) throw denied();
    const location = await folders(row.source, env);
    if (location.consent.scope !== row.scope) throw denied();
    const target = await (this.options.selected ?? selectedNative)(row.source, env);
    if (target.runtime !== row.source.runtime || nativeIdentity(target) !== nativeIdentity({ ...row.source, runtime: target.runtime }) || (await sourceLocalConsent(identity(target), env)).scope !== row.scope) throw denied();
    const authority: SourceAuthority = { source: row.source, captureRevision: row.capture_revision,
      guards: [{ key: sourceLocalKey(agentId), fields: { active: true, generation: row.generation, scope: row.scope } }, ...capture.guards] };
    return { row, target, env, location, authority };
  }
  async authorize(agentId: string): Promise<SourceAuthority> { return (await this.checked(agentId)).authority; }

  /** Native disconnect calls this before changing its binding. CLI disconnect also fences through active/generation.
   * It does not edit a managed revision, kill a run or delete any captured snapshot. */
  async revoke(agentId: string): Promise<void> {
    for (let n = 0; n < 8; n++) {
      const key = sourceLocalKey(agentId), row = await this.store.settings.get(key) as LocalRecord | undefined;
      if (!row?.active) return;
      if (await this.store.settings.replaceIf(key, row, { ...row, active: false, generation: randomBytes(24).toString("base64url") })) return;
    }
    throw changed();
  }

  publisher(sync: SourceSync, options: {
    limit?: number; agentWrite?: <T>(agentId: string, call: () => Promise<T>) => Promise<T>;
  } = {}) {
    const limit = options.limit ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError("local source batch limit must be between 1 and 32");
    let cursor = "";
    return { tick: async (signal?: AbortSignal) => {
      const rows = (await this.store.settings.all({ prefix: "source-sync.local." })).filter(item => (item.value as LocalRecord).active).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const ordered = [...rows.filter(row => row.key > cursor), ...rows.filter(row => row.key <= cursor)].slice(0, limit);
      const result = { published: 0, unchanged: 0, refused: 0, failed: 0 };
      for (const item of ordered) {
        signal?.throwIfAborted(); cursor = item.key;
        const agentId = (item.value as LocalRecord).agent_id, record = await sync.get(agentId);
        if (!record?.enabled || record.connection) { result.refused++; continue; }
        let checked: Awaited<ReturnType<LocalSources["checked"]>>;
        try { checked = await this.checked(agentId); } catch (error) { if (error instanceof ApiError && error.status < 500) { result.refused++; continue; } throw error; }
        const scoped = new SourceSync(this.store, { ...sync.options, authorize: async id => {
          const now = await this.checked(id);
          if (id !== agentId || now.row.generation !== checked.row.generation) throw changed();
          return now.authority;
        } });
        const write = <T>(call: () => Promise<T>): Promise<T> => options.agentWrite ? options.agentWrite(agentId, call) : call();
        const reconcile = async (): Promise<void> => {
          try { await scoped.reconcile(agentId); }
          catch (error) { if (!(error instanceof SourcePreparationError) && !(error instanceof ApiError && error.status < 500)) throw error; }
        };
        const secrets = this.options.secrets?.() ?? runnerSecrets(checked.env, runnerSecrets(process.env));
        try {
          const snapshot = await (this.options.export ?? exportSourceSnapshot)({ target: checked.target, home: checked.location.home, environment: checked.env,
            authorizedRoots: checked.location.roots, expectedRoots: checked.location.expectedRoots,
            ...(checked.location.explicit ? (NATIVE_RUNTIME_FACTS[checked.target.runtime].protocol === "codex-json" ? { codexHome: checked.location.explicit } : { claudeHome: checked.location.explicit }) : {}),
            secretValues: secrets, ...(signal ? { signal } : {}) });
          signal?.throwIfAborted();
          if (snapshot.digest === record.attempt?.digest && !record.attempt.code) {
            if (snapshot.complete && !snapshot.blockers.length) await write(reconcile);
            result.unchanged++; continue;
          }
          await write(async () => {
            await scoped.publish(agentId, { generation: record.generation, sequence: record.sequence + 1, snapshot });
            if (snapshot.complete && !snapshot.blockers.length) await reconcile();
          });
          result.published++;
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof SourceSnapshotError)) throw error;
          const code = error.code === "limit" ? "snapshot_too_large" : error.code;
          await write(() => scoped.failed(agentId, { generation: record.generation, sequence: record.sequence + 1, code })); result.failed++;
        }
      }
      return result;
    } };
  }
}
