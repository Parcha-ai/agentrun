// A host for orphan.test.mjs: opens a Claude Agent session on the pinned CLI and SDK (built-ins off, the host's tools
// only, as every host runs it), whose model is the scripted provider at argv[2], with private directories under argv[3],
// under the confinement V1's serve gives it (`setpriv --no-new-privs --`, where setpriv is), and sends one prompt. It
// reports on stdout, a JSON object per line, and then waits to be SIGKILLed:
//   {"tool": "started"}  when its one host tool (wait, which never returns) is called;
//   {"idle": true}       when the turn has ended (argv[4] is "idle").
import { existsSync } from 'node:fs';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';

const [url, dir, point] = process.argv.slice(2);
const say = (report) => process.stdout.write(`${JSON.stringify(report)}\n`);
const confine = existsSync('/usr/bin/setpriv') ? (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] }) : undefined;
const adapter = claudeAgentAdapter({ model: 'claude-test', provider: { origin: url, credential: () => 'not-a-key' }, sessionsDir: dir, ...(confine ? { confine } : {}) });
const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object', properties: {} }, replay: 'never', call: () => { say({ tool: 'started' }); return new Promise(() => {}); } };
const spec = { key: `step:orphan-${point}`, label: 'orphan', system: [], tools: [wait], context: 'fresh' };
const store = memorySessionStore();
const models = { beforeRequest: async () => ({}), afterRequest: async () => {} };
const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
await session.send('Go.');
if (point === 'idle') {
  await session.turnEnd();
  say({ idle: true });
}
setInterval(() => {}, 1000);
