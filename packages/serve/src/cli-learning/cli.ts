import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { secret } from '../secrets.js';
import { defaultData } from '../server-fs.js';
import { cliLearningUrl, installCliLearning, removeCliLearning, statusCliLearning, type CliLearningRuntime } from './install.js';
import { connectionFile, readConnection, saveConnection, type CliLearningConnection } from './state.js';

const USAGE = 'usage: agentrun-serve learning connect|status|disconnect|retry --runtime codex|claude-code [--project PATH] [--url LOOPBACK_URL] [--data SERVER_DATA]';
type CliIO = {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdin?: AsyncIterable<string | Uint8Array>;
  fetch?: typeof fetch;
  /** Test/packaging boundary: executable plus arguments, never evaluated while installing. */
  command?: string[];
};

async function ownerToken(data: string): Promise<string> {
  const fromEnvironment = secret('AGENTRUN_API_KEY') || secret('AGENTRUN_TOKEN');
  if (fromEnvironment) return fromEnvironment;
  let value: string;
  try { value = (await readFile(join(data, '.token'), 'utf8')).trim(); }
  catch { throw new Error('Cannot read the local server token. Start AgentRun and use its --data directory.'); }
  if (!value) throw new Error('The local server token is empty.');
  return value;
}

async function serverUrl(value: string | undefined, data: string): Promise<string> {
  if (value) return cliLearningUrl(value);
  let recorded: string | undefined;
  try {
    const record = JSON.parse(await readFile(join(data, '.server.json'), 'utf8')) as { base_url?: unknown };
    if (typeof record.base_url === 'string') recorded = record.base_url;
  } catch { /* A stopped/default server has no record. */ }
  return cliLearningUrl(recorded);
}

async function request(fetcher: typeof fetch, url: string, path: string, token: string, method: string, body?: unknown): Promise<Response> {
  return fetcher(new URL(path, cliLearningUrl(url)), {
    method, redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function revoke(fetcher: typeof fetch, connection: Pick<CliLearningConnection, 'url' | 'connection_id'>, token: string): Promise<void> {
  const response = await request(fetcher, connection.url, `/v2/cli-learning/connections/${encodeURIComponent(connection.connection_id)}`, token, 'DELETE');
  if (!response.ok && response.status !== 404) throw new Error(`Server refused disconnection (HTTP ${response.status}).`);
}

async function hookInput(input: AsyncIterable<string | Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) throw new Error('Hook input exceeds the limit.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function connectionLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const path = `${file}.lock`;
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another learning connection change is in progress for this project.');
    throw error;
  }
  try { return await operation(); } finally { await handle.close(); await rm(path, { force: true }); }
}

/** Installer/status command plus the bounded stdin worker invoked by ordinary CLI hooks. */
export async function learningMain(argv: string[], io: CliIO = {}): Promise<number> {
  const output = io.stdout ?? ((text: string) => console.log(text));
  const errorOutput = io.stderr ?? ((text: string) => console.error(text));
  const fetcher = io.fetch ?? fetch;
  const isHook = argv[0] === 'hook';
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      project: { type: 'string' }, runtime: { type: 'string' }, data: { type: 'string' }, url: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) { output(USAGE); return 0; }
    const operation = positionals[0];
    if (positionals.length !== 1 || !['connect', 'status', 'disconnect', 'retry', 'hook'].includes(operation ?? '')) throw new Error(USAGE);
    if (values.runtime !== 'codex' && values.runtime !== 'claude-code') throw new Error(`--runtime must be codex or claude-code.\n${USAGE}`);
    const runtime: CliLearningRuntime = values.runtime;
    const project = await realpath(resolve(values.project ?? process.cwd()));
    const requestedData = resolve(values.data ?? defaultData());
    const dataDir = await realpath(requestedData).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return requestedData;
      throw error;
    });
    const dataRelative = relative(project, dataDir);
    if (dataRelative === '' || (dataRelative !== '..' && !dataRelative.startsWith(`..${sep}`) && !isAbsolute(dataRelative))) {
      throw new Error('Use a server --data directory outside the project so connection credentials stay out of source control.');
    }
    const options = { runtime, project, dataDir };
    if (operation === 'hook') {
      const input = await hookInput(io.stdin ?? process.stdin);
      const { runCliLearningHook } = await import('./hook.js');
      const result = await runCliLearningHook({ ...options, ...(values.url ? { url: cliLearningUrl(values.url) } : {}) }, input);
      if (result !== undefined) output(JSON.stringify(result));
      return 0;
    }

    const execute = async (): Promise<number> => {
    const existing = await readConnection(dataDir, runtime, project);
    if (operation === 'retry') {
      const { flushCliLearning } = await import('./hook.js');
      const result = await flushCliLearning(options, { fetch: fetcher });
      output(JSON.stringify(result));
      if (result.blocked_journals) errorOutput('CLI capture journals from another enrollment or without a destination binding are preserved for review. They were not retried.');
      return result.pending > 0 || result.blocked_journals > 0 ? 1 : 0;
    }
    if (operation === 'status') {
      const installation = await statusCliLearning(options);
      let server: { reachable: boolean; enrolled?: boolean; active?: boolean; last_hook_at?: string; last_run_id?: string } | null = null;
      if (existing) {
        try {
          const response = await request(fetcher, existing.url, '/v2/cli-learning/connections', await ownerToken(dataDir), 'GET');
          if (!response.ok) throw new Error('Unavailable');
          const body = await response.json() as { connections?: unknown };
          if (!Array.isArray(body.connections)) throw new Error('Invalid status');
          const connection = body.connections.find((c: unknown) => c && typeof c === 'object' && (c as { connection_id?: unknown }).connection_id === existing.connection_id);
          server = { reachable: true, enrolled: !!connection, active: connection?.active === true,
            ...(typeof connection?.last_hook_at === 'string' ? { last_hook_at: connection.last_hook_at } : {}),
            ...(typeof connection?.last_run_id === 'string' ? { last_run_id: connection.last_run_id } : {}) };
        } catch { server = { reachable: false }; }
      }
      output(JSON.stringify({ ...installation, connection: existing ? { connection_id: existing.connection_id, agent_id: existing.agent_id, url: existing.url } : null, server }, null, 2));
      return 0;
    }
    if (operation === 'disconnect') {
      // Remove observation first, even if an offline server cannot acknowledge revocation yet.
      const installation = await removeCliLearning(options);
      if (existing) {
        try { await revoke(fetcher, existing, await ownerToken(dataDir)); }
        catch { output(JSON.stringify({ ...installation, revoked: false, warnings: [...installation.warnings, 'Hooks removed; server revocation is pending. Run disconnect again when the server is available.'] }, null, 2)); return 1; }
        await rm(connectionFile(dataDir, runtime, project), { force: true });
      }
      output(JSON.stringify({ ...installation, revoked: true }, null, 2));
      return 0;
    }

    const url = await serverUrl(values.url, dataDir);
    const before = await statusCliLearning(options);
    if (before.state === 'partial') throw new Error('AgentRun hooks were changed or disabled. Run learning disconnect before reconnecting.');
    if (existing) {
      if (existing.url !== url) throw new Error('This project is connected to another server. Run learning disconnect before reconnecting.');
      let active = false;
      try {
        const response = await request(fetcher, url, '/v2/cli-learning/connections', await ownerToken(dataDir), 'GET');
        if (!response.ok) throw new Error('Unavailable');
        const body = await response.json() as { connections?: unknown };
        if (!Array.isArray(body.connections)) throw new Error('Invalid status');
        active = body.connections.some((c: unknown) => c && typeof c === 'object'
          && (c as { connection_id?: unknown }).connection_id === existing.connection_id
          && (c as { active?: unknown }).active === true);
      } catch { throw new Error('Cannot verify the existing learning connection. Retry when the local server is available.'); }
      if (!active) throw new Error('This learning connection is inactive. Run learning disconnect, then learning connect to enroll again.');
      const installation = await installCliLearning({ ...options, url, command: io.command });
      output(JSON.stringify({ ...installation, connection_id: existing.connection_id, agent_id: existing.agent_id }, null, 2));
      return 0;
    }
    const token = await ownerToken(dataDir);
    const response = await request(fetcher, url, '/v2/cli-learning/connections', token, 'POST', { project, runtime });
    if (!response.ok) throw new Error(`Server refused the learning connection (HTTP ${response.status}).`);
    const body = await response.json() as Record<string, unknown>;
    if (!body || typeof body.connection_id !== 'string' || typeof body.agent_id !== 'string' || typeof body.token !== 'string'
      || !body.connection_id || !body.agent_id || !body.token) throw new Error('The server returned an invalid learning connection.');
    const connection: CliLearningConnection = { version: 1, project, runtime, url, connection_id: body.connection_id, agent_id: body.agent_id, token: body.token };
    let saved = false;
    try {
      await saveConnection(dataDir, connection);
      saved = true;
      const installation = await installCliLearning({ ...options, url, command: io.command });
      output(JSON.stringify({ ...installation, connection_id: connection.connection_id, agent_id: connection.agent_id }, null, 2));
      return 0;
    } catch (error) {
      if (before.state === 'not-installed') await removeCliLearning(options).catch(() => undefined);
      try {
        await revoke(fetcher, connection, token);
        if (saved) await rm(connectionFile(dataDir, runtime, project), { force: true });
      } catch {
        throw new Error('Connection setup failed and server revocation is pending. Run learning disconnect when the server is available.');
      }
      throw error;
    }
    };
    return operation === 'status' ? await execute() : await connectionLock(connectionFile(dataDir, runtime, project), execute);
  } catch (error) {
    if (isHook) {
      errorOutput('AgentRun learning hook skipped; use learning status to check the connection.');
      return 0;
    }
    errorOutput(`agentrun learning: ${error instanceof Error ? error.message : 'Command failed.'}`);
    return 2;
  }
}
