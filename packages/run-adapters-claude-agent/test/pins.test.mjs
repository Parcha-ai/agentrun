// The Claude Agent SDK and its CLI are the host's (an optional peer dependency): the adapter checks them against its pins
// when it is made, and refuses a mismatch with a typed error a host maps to the run's failure line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLAUDE_AGENT_CLI_VERSION, CLAUDE_AGENT_PACKAGE, CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION, ClaudeAgentNotInstalled, ClaudeAgentPinMismatch, claudeAgentAdapter, claudeAgentExecutable, verifyClaudeAgent, verifyClaudeAgentCli } from '@parcha/agentrun-claude-agent';
import { fakeSdk } from '@parcha/agentrun-claude-agent/testing';
import { sandboxSpawn } from '../dist/spawn.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-pins-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** An executable that says `version` when asked. */
function cli(name, version) {
  const path = join(ROOT, name);
  writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(path, 0o755);
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
const mismatch = (pin, expected, found) => (e) => e instanceof ClaudeAgentPinMismatch && e.code === 'CLAUDE_AGENT_PIN_MISMATCH' && e.pin === pin && e.expected === expected && e.found === found;

test('the pins are the production deployment\'s: SDK 0.3.286, whose CLI is 2.1.286', () => {
  assert.deepEqual([CLAUDE_AGENT_SDK_VERSION, CLAUDE_AGENT_CLI_VERSION], ['0.3.286', '2.1.286']);
});

// The install line names the constant, a consumer's npm resolves the peer pin, and this repository's tests (CI's real-CLI
// suites among them) run the dev pin: a drift in any one means the CLI tested is not the CLI installed.
test('the SDK pin is one version everywhere: the constant, the peer and dev pins, and the lock', () => {
  const sdk = '@anthropic-ai/claude-agent-sdk';
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  const workspace = lock.packages['packages/run-adapters-claude-agent'];
  const installed = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${sdk}`));
  assert.ok(installed.length > 0, `the lock resolves ${sdk}`);
  const found = {
    peer: manifest.peerDependencies[sdk],
    dev: manifest.devDependencies[sdk],
    lockPeer: workspace.peerDependencies[sdk],
    lockDev: workspace.devDependencies[sdk],
    ...Object.fromEntries(installed.map(([path, entry]) => [path, entry.version])),
  };
  assert.deepEqual(found, Object.fromEntries(Object.keys(found).map((key) => [key, CLAUDE_AGENT_SDK_VERSION])));
});

test("a CLI whose sha256 is not the pinned build's is refused, typed, with the pin, what was expected and what was found", () => {
  const other = cli('other', '2.1.286 (stand-in)');
  const result = verifyClaudeAgentCli(other.path, { sha256: 'f'.repeat(64), version: '2.1.286' });
  assert.ok(mismatch('cli_sha256', 'f'.repeat(64), other.sha256)(result), String(result));
  assert.equal(result.path, other.path);
});

test("a CLI that is not the pinned version is refused, typed; the pinned one passes", () => {
  const wrong = cli('wrong', '2.1.999 (stand-in)');
  assert.ok(mismatch('cli_version', '2.1.286', '2.1.999')(verifyClaudeAgentCli(wrong.path, { sha256: wrong.sha256, version: '2.1.286' })));
  const right = cli('right', '2.1.286 (stand-in)');
  assert.deepEqual(verifyClaudeAgentCli(right.path, { sha256: right.sha256, version: '2.1.286' }), { path: right.path });
});

test('an injected SDK that is not the pinned release is refused, typed, before anything else is checked', () => {
  assert.throws(() => verifyClaudeAgent({ sdk: fakeSdk(), sdkVersion: '0.3.296', cliPath: join(ROOT, 'none') }), mismatch('sdk_version', '0.3.286', '0.3.296'));
});

test('no SDK, no MCP library or no CLI is "Claude Agent SDK not installed", typed, in one line that ends with the exact install line', () => {
  const LINE = 'npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.286';
  assert.equal(CLAUDE_AGENT_SDK_INSTALL, LINE);
  assert.equal(CLAUDE_AGENT_PACKAGE, '@parcha/agentrun-claude-agent');
  const withLine = (e) => e instanceof ClaudeAgentNotInstalled && e.code === 'CLAUDE_AGENT_NOT_INSTALLED' && e.install === LINE
    && e.message.startsWith('Claude Agent SDK not installed: ') && e.message.endsWith(`; install it with: ${LINE}`) && !/\n/.test(e.message);
  // No SDK beside the adapter.
  assert.throws(() => verifyClaudeAgent({}, () => undefined), (e) => withLine(e) && e.message.includes(`@anthropic-ai/claude-agent-sdk 0.3.286 is not installed beside ${CLAUDE_AGENT_PACKAGE}`));
  // The SDK, but not the MCP library it brings as a peer (installing the SDK with npm installs it).
  assert.throws(() => verifyClaudeAgent({ sdk: fakeSdk(), sdkVersion: '0.3.286' }, (name) => (name === '@modelcontextprotocol/sdk' ? undefined : '0.3.286')), (e) => withLine(e) && /@modelcontextprotocol\/sdk/.test(e.message));
  // The SDK, but no CLI of its platform packages.
  const none = verifyClaudeAgentCli(undefined);
  assert.ok(withLine(none) && /CLI/.test(none.message), none.message);
  // A cliPath the host gave that holds nothing: the host's path to fix, so no install line.
  assert.throws(() => verifyClaudeAgent({ sdk: fakeSdk(), sdkVersion: '0.3.286', cliPath: join(ROOT, 'missing') }), (e) => e instanceof ClaudeAgentNotInstalled && e.message === `Claude Agent SDK not installed: no CLI at ${join(ROOT, 'missing')}` && e.install === undefined);
});

test('making the adapter checks the pins, so a mismatch is thrown to the host before any run', () => {
  const wrong = cli('made', '2.1.999 (stand-in)');
  assert.throws(() => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, sdk: fakeSdk(), sdkVersion: '0.3.286', cliPath: wrong.path }), (e) => e instanceof ClaudeAgentPinMismatch);
  // A stand-in CLI is for a test runner that asked for one.
  assert.equal(process.env.AGENTRUN_CLAUDE_AGENT_STANDIN, undefined);
  assert.throws(() => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, sdk: fakeSdk(), standIn: { command: process.execPath } }), /tests only/);
});

test('an SDK whose own spawn marker says another release starts no CLI: the spawn is refused, typed', async () => {
  const errors = [];
  let started = 0;
  const machine = { root: ROOT, start: () => { started += 1; throw new Error('started'); } };
  const spawn = sandboxSpawn({ machine, executable: '/pinned/claude', env: { HOME: '/h' }, signal: new AbortController().signal, onError: (e) => errors.push(e) });
  const proc = spawn({ command: '/pinned/claude', args: [], env: { HOME: '/h', CLAUDE_AGENT_SDK_VERSION: '0.3.296' }, signal: new AbortController().signal });
  const failed = await new Promise((resolve) => proc.once('error', resolve));
  assert.equal(started, 0);
  assert.ok(mismatch('sdk_version', '0.3.286', '0.3.296')(failed));
  assert.ok(mismatch('sdk_version', '0.3.286', '0.3.296')(errors[0]));
});

test('the installed SDK and its pinned CLI pass', { skip: !claudeAgentExecutable() && 'no pinned CLI installed here' }, () => {
  const { cliPath } = verifyClaudeAgent({});
  assert.equal(cliPath, claudeAgentExecutable());
});

test('an injected SDK with no MCP library beside the adapter is refused when the adapter is made, typed, before any turn', () => {
  const noMcp = (name) => (name === '@modelcontextprotocol/sdk' ? undefined : '0.3.286');
  assert.throws(() => verifyClaudeAgent({ sdk: fakeSdk(), sdkVersion: '0.3.286', cliPath: join(ROOT, 'none') }, noMcp), (e) => e instanceof ClaudeAgentNotInstalled && /@modelcontextprotocol\/sdk/.test(e.detail));
});

test("the pinned CLI is found beside the adapter's install, whatever the process's working directory", { skip: !claudeAgentExecutable() && 'the pinned CLI is not installed here' }, () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'agentrun-cwd-'));
  try {
    const url = new URL('../dist/binary.js', import.meta.url).href;
    const found = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.findClaudeExecutable() ?? '')`], { cwd: elsewhere, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(found, claudeAgentExecutable(), 'the same binary from a directory with no node_modules');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
