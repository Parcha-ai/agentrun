// A host's sessions directory may sit inside a git repository. None of that repository (its branch, commit or remote)
// may reach the session's records, which the adapter mirrors into the session store, or the provider. The pinned binary,
// through the adapter, with a scripted provider behind the session's proxy. No network.
//
// This passes with and without the ceiling. Codex 0.164.0 records git state in a session's metadata under `codex exec`,
// but on the app-server path the adapter runs it records none and leaves the repository untouched. The child's
// GIT_CEILING_DIRECTORIES (asserted in test/machine.test.mjs) keeps it that way; this test guards the outcome against a
// Codex release that starts recording it.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-git-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A repository with a branch, a commit and a remote, each with a name that appears nowhere else. */
function plantedRepo(dir) {
  const branch = 'planted-branch-q7v2';
  const remote = 'https://git.invalid/planted-owner-q7v2/planted-repo-q7v2.git';
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planted', '-c', 'user.email=planted@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', branch);
  writeFileSync(join(dir, 'README'), 'planted\n');
  git('add', 'README');
  git('commit', '-q', '-m', 'planted commit');
  git('remote', 'add', 'origin', remote);
  return { branch, remote, commit: git('rev-parse', 'HEAD') };
}

test("a repository above the sessions directory: none of its branch, commit or remote reaches the session's records or the provider", { skip, timeout: 120_000 }, async () => {
  const repo = join(ROOT, 'host-repo');
  const planted = plantedRepo(repo);
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(init.body);
    const n = seen.length;
    const items = n === 1 ? [{ type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' }] : [{ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] }];
    return new Response(sse(n, items), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const store = memorySessionStore();
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(repo, 'sessions'), fetch });
  const runNode = createHarnessRunner(codex, { store, timeoutMs: 90_000 });
  const output = await runNode({ kind: 'agent', label: 'git', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: [] });
  assert.deepEqual(output, { answer: 'ok' });

  const records = [];
  for (const key of store.keys()) records.push(...(await store.read(key)));
  assert.ok(records.length > 0, 'the session mirrored its records');
  const stored = JSON.stringify(records);
  const sent = seen.join('\n');
  for (const [what, value] of [['branch', planted.branch], ['commit', planted.commit], ['short commit', planted.commit.slice(0, 7)], ['remote', planted.remote], ['remote owner', 'planted-owner-q7v2']]) {
    assert.ok(!stored.includes(value), `the repository's ${what} is not in the session's records`);
    assert.ok(!sent.includes(value), `the repository's ${what} is not sent to the provider`);
  }
});
