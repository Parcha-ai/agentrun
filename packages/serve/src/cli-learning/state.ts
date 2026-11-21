import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type CliLearningRuntime = 'codex' | 'claude-code';
export type CliLearningConnection = {
  version: 1;
  runtime: CliLearningRuntime;
  project: string;
  url: string;
  connection_id: string;
  agent_id: string;
  token: string;
};
export const stateHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const connectionFile = (dataDir: string, runtime: CliLearningRuntime, project: string): string =>
  join(resolve(dataDir), 'cli-learning', 'connections', `${stateHash(`${runtime}\0${resolve(project)}`)}.json`);

/** The scoped credential changes on re-enrollment. Hash it with the destination; never persist or show it in paths. */
export const connectionScope = (connection: CliLearningConnection): string => stateHash(JSON.stringify([
  'agentrun-cli-journal-v1', new URL(connection.url).origin, connection.runtime, resolve(connection.project),
  connection.connection_id, connection.agent_id, connection.token,
]));
export const journalParent = (dataDir: string, runtime: CliLearningRuntime, project: string): string =>
  join(resolve(dataDir), 'cli-learning', 'sessions', stateHash(`${runtime}\0${resolve(project)}`));
export const journalRoot = (dataDir: string, connection: CliLearningConnection): string =>
  join(journalParent(dataDir, connection.runtime, connection.project), 'epochs', connectionScope(connection));

/** Credentials and prompt receipts belong to private AgentRun data, never source control or hook arguments. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function readConnection(dataDir: string, runtime: CliLearningRuntime, project: string): Promise<CliLearningConnection | undefined> {
  const value = await readPrivateJson<CliLearningConnection>(connectionFile(dataDir, runtime, project));
  if (!value) return undefined;
  if (value.version !== 1 || value.runtime !== runtime || resolve(value.project) !== resolve(project)
    || !value.connection_id || !value.agent_id || !value.token || typeof value.url !== 'string') {
    throw new Error('Invalid CLI learning connection. Reconnect this project.');
  }
  return value;
}

export async function saveConnection(dataDir: string, connection: CliLearningConnection): Promise<void> {
  await writePrivateJson(connectionFile(dataDir, connection.runtime, connection.project), connection);
}
