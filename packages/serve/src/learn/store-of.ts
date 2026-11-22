// Which learning store an agent's learning is in (learn/store.ts): code.storage where this process's start was keyed
// for the data directory (AGENTRUN_CODE_STORAGE_NAME and AGENTRUN_CODE_STORAGE_KEY), else the local git folder under it.
import type { KeyObject } from "node:crypto";
import { held, heldLearningStore } from "../runner/held.js";
import { secret } from "../secrets.js";
import { codeStorageLearningStore } from "./code-storage.js";
import { CODE_STORAGE_ENV, FolderUnreadable, type LearningStore } from "./store.js";

export { CODE_STORAGE_ENV };
import { localLearningStore } from "./store-local.js";

/** code.storage's settings: the org, its signing key, the API's base URL (absent: `https://api.<org>.code.storage`), this
 *  server's id (the repository's middle part), and a `fetch` in place of the network (tests). */
export type CodeStorageSettings = { name: string; key: string | KeyObject; apiUrl?: string; serverId: () => Promise<string>; fetch?: typeof fetch };

/** code.storage's environment set wrong: one of its name and key without the other, or a value it can't take. */
export class CodeStorageEnvInvalid extends Error {
  override readonly name = "CodeStorageEnvInvalid";
}

/** code.storage's settings as the environment gives them (its key read by name, `key`), or undefined when the org's name
 *  is not set: learning stays in the local folder. A key or an API URL set without the name turns nothing on (a
 *  launcher may hold every secret it knows of), and `warn` says so. The name without the key, a name that is no org
 *  name, a key that is no PEM, or an API URL that is no https URL stops the start, naming each variable. */
export function codeStorageFromEnv(env: NodeJS.ProcessEnv, key: (name: string) => string | undefined = secret, warn: (message: string) => void = () => undefined): Omit<CodeStorageSettings, "serverId"> | undefined {
  const name = env[CODE_STORAGE_ENV.name]?.trim() || undefined;
  const pem = key(CODE_STORAGE_ENV.key)?.trim() || undefined;
  const apiUrl = env[CODE_STORAGE_ENV.apiUrl]?.trim() || undefined;
  if (!name) {
    const set = [...(pem ? [CODE_STORAGE_ENV.key] : []), ...(apiUrl ? [CODE_STORAGE_ENV.apiUrl] : [])];
    if (set.length) warn(`${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set without ${CODE_STORAGE_ENV.name}, so learning stays in the local folder: set ${CODE_STORAGE_ENV.name} to keep it on code.storage.`);
    return undefined;
  }
  if (!pem) throw new CodeStorageEnvInvalid(`${CODE_STORAGE_ENV.name} is set without ${CODE_STORAGE_ENV.key}: set both to keep learning on code.storage, or unset the name to keep it in the local folder.`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new CodeStorageEnvInvalid(`${CODE_STORAGE_ENV.name} is a code.storage org name: lowercase letters, digits and dashes.`);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) throw new CodeStorageEnvInvalid(`${CODE_STORAGE_ENV.key} is not a private key in PEM form.`);
  if (apiUrl !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(apiUrl);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:") throw new CodeStorageEnvInvalid(`${CODE_STORAGE_ENV.apiUrl} is an https URL.`);
  }
  return { name, key: pem, ...(apiUrl ? { apiUrl } : {}) };
}

/** The store each data directory this process serves or runs from uses: code.storage's settings where its start was
 *  keyed; the words a runner apart from its server's disk refuses learning with (`refused`); else none (the local
 *  folder). */
const stores = new Map<string, CodeStorageSettings | { refused: string }>();

/** Data directory `data`'s learning on code.storage (`settings`), refused (`{ refused }`: a runner whose data directory
 *  is not its server's, with no code.storage settings, would learn into a folder its server never reads), or back in
 *  its local folder (undefined): what a server's start and a runner's set from their environment. */
export function useLearningStore(data: string, settings: CodeStorageSettings | { refused: string } | undefined): void {
  if (settings) stores.set(data, settings);
  else stores.delete(data);
}

/** The words a runner apart from its server's disk refuses learning with, naming the settings that would let it learn. */
export const LEARNING_APART =
  `this runner's data directory is not the server's, and the server keeps its agents' learning in its own local folder, which this runner can't reach: start the server and this runner with ${CODE_STORAGE_ENV.name} and ${CODE_STORAGE_ENV.key} to keep learning on code.storage, or start the runner on the server's data directory.`;

/** Agent `agentId`'s learning store as data directory `data` keeps it: code.storage when keyed, else its local folder.
 *  In a run's own process, its runner's, for reads alone (runner/held.ts). Refused (every call throws
 *  FolderUnreadable with the words) where the data directory's learning is. */
export function learningStoreOf(data: string, agentId: string): LearningStore {
  if (held()) return heldLearningStore(agentId);
  const settings = stores.get(data);
  if (settings && "refused" in settings) return refusedStore(agentId, settings.refused);
  return settings ? codeStorageLearningStore(settings, agentId) : localLearningStore(data, agentId);
}

/** A store every call of which throws FolderUnreadable with `words`: nothing learned is read, nothing written. */
function refusedStore(agentId: string, words: string): LearningStore {
  const no = async (): Promise<never> => {
    throw new FolderUnreadable(false, words);
  };
  return { id: `refused:${agentId}`, head: no, read: no, log: no, diff: no, save: no, remove: no };
}

/** Data directory `data`'s learning as a start sets it from `env` (codeStorageFromEnv, its key read by `key`): on
 *  code.storage, its server id read once from `store` when first asked (archil-settings.ts serverIdOf); refused for a
 *  runner `apart` from its server's disk with no code.storage settings (LEARNING_APART); else in the local folder.
 *  `warn`: where a key set without the name is said. */
export function learningStoreFromEnv(data: string, env: NodeJS.ProcessEnv, serverId: () => Promise<string>, { apart = false, key = secret, warn }: { apart?: boolean; key?: (name: string) => string | undefined; warn?: (message: string) => void } = {}): void {
  const settings = codeStorageFromEnv(env, key, warn);
  let id: Promise<string> | undefined;
  useLearningStore(data, settings ? { ...settings, serverId: () => (id ??= serverId()) } : apart ? { refused: LEARNING_APART } : undefined);
}
