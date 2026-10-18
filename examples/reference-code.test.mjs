// The code a recording names (`code` in its header) for a run whose root is not this repository: the root's own GitHub
// origin as owner/name (never a raw URL or its credentials), its commit, and the @parcha packages the run loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeOf } from '@parcha/agentrun-reference';

const git = (dir, ...args) => {
  const ran = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-code-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"name":"a-project","private":true}\n');
  mkdirSync(join(dir, 'node_modules', '@parcha', 'agentrun-reference'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@parcha', 'agentrun-reference', 'package.json'), '{"name":"@parcha/agentrun-reference","version":"9.9.9"}\n');
  return dir;
}

test('a project with a GitHub origin names it as owner/name, without the token in its URL, and its HEAD', (t) => {
  const dir = project(t);
  git(dir, 'init', '-q');
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', 'https://not-a-real-token@github.com/acme/widgets.git');
  const code = codeOf(dir);
  assert.equal(code.repo, 'acme/widgets');
  assert.equal(code.commit, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(code.packages['@parcha/agentrun-reference'], '9.9.9', 'the @parcha packages the project installed');
  assert.ok(!JSON.stringify(code).includes('not-a-real-token'));
});

test('a project whose origin is not on GitHub names no repository, never the URL', (t) => {
  const dir = project(t);
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', 'https://git.internal.example/acme/widgets.git');
  const code = codeOf(dir);
  assert.equal(code.repo, 'unknown');
  assert.equal(code.commit, 'unknown', 'no commit yet');
  assert.ok(!JSON.stringify(code).includes('internal.example'));
});

test('a project with no git names no repository and no commit', (t) => {
  const dir = project(t);
  const code = codeOf(dir);
  assert.deepEqual([code.repo, code.commit], ['unknown', 'unknown']);
});
