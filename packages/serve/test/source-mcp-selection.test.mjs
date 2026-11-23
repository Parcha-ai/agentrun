import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { missingMcpTools, selectedMcpServer, selectedMcpTool, sourceMcpSelection } from '../dist/native/source-mcp-selection.js';

test('an exact empty allowlist never aliases the unrestricted null allowlist', () => {
  assert.equal(selectedMcpTool({ dialect: 'exact', allow: [], deny: [] }, 'docs', 'read'), false);
  assert.equal(selectedMcpTool({ dialect: 'exact', allow: null, deny: [] }, 'docs', 'read'), true);
  assert.equal(selectedMcpTool({ dialect: 'exact', allow: ['read'], deny: ['read'] }, 'docs', 'read'), false);
  assert.deepEqual(missingMcpTools({ dialect: 'exact', allow: ['read', 'delete'], deny: ['delete'] }, 'docs', []), ['read']);
});
test('Claude full qualified names preserve double underscores and do not grant another server', () => {
  const selection = { dialect: 'claude', allow: ['mcp__docs__v2__*'], deny: ['mcp__docs__v2__delete'] };
  assert.equal(selectedMcpTool(selection, 'docs__v2', 'read'), true);
  assert.equal(selectedMcpTool(selection, 'docs__v2', 'delete'), false);
  assert.equal(selectedMcpTool(selection, 'docs', 'read'), false);
  assert.equal(selectedMcpServer(selection, 'other'), false);
  assert.deepEqual(missingMcpTools({ ...selection, allow: ['mcp__docs__v2__read', 'mcp__other__read'] }, 'docs__v2', []), ['mcp__docs__v2__read']);
});
test('Claude bare server denies retain native prefix semantics and global deny wins', () => {
  const selection = { dialect: 'claude', allow: ['mcp__docs__v2__*'], deny: ['mcp__docs'] };
  assert.equal(selectedMcpTool(selection, 'docs__v2', 'read'), false);
  assert.equal(selectedMcpServer(selection, 'docs__v2'), false);
  assert.equal(selectedMcpTool({ ...selection, deny: ['mcp__*'] }, 'docs__v2', 'read'), false);
});
test('selection validation refuses missing or ambiguous allowlists without coercion', () => {
  for (const allow of [undefined, '', false, {}, [1], ['']]) assert.equal(sourceMcpSelection({ dialect: 'exact', allow, deny: [] }), false);
  assert.equal(sourceMcpSelection({ dialect: 'claude', allow: ['mcp__docs__*'], deny: [] }), true);
  assert.equal(sourceMcpSelection({ dialect: 'claude', allow: ['mcp__docs__read(path)'], deny: [] }), false);
});
test('a repeated wildcard selector cannot stall catalog resolution on a nonmatching tool', () => {
  // Use a subprocess deadline: a regression to a backtracking regexp would otherwise block the test runner itself.
  const module = new URL('../dist/native/source-mcp-selection.js', import.meta.url).href;
  const script = `import { selectedMcpTool } from ${JSON.stringify(module)};
    const selection = { dialect: 'claude', allow: ['mcp__docs__' + '*a'.repeat(40) + 'b'], deny: [] };
    if (selectedMcpTool(selection, 'docs', 'a'.repeat(100))) process.exit(2);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000, encoding: 'utf8' });
  assert.equal(child.status, 0, child.error?.code ?? child.stderr);
});
test('bounded wildcard matching preserves anchored literal-and-star semantics including overlapping chunks', () => {
  const words = (alphabet, depth) => depth === 0 ? [''] : ['', ...words(alphabet, depth - 1).flatMap(word => alphabet.map(char => word + char))];
  for (const pattern of new Set(words(['a', 'b', '*'], 4))) for (const value of new Set(words(['a', 'b'], 4))) {
    const expected = new RegExp('^' + pattern.replaceAll('*', '.*') + '$').test(value);
    assert.equal(selectedMcpTool({ dialect: 'claude', allow: ['mcp__docs__' + pattern], deny: [] }, 'docs', value), expected, `${pattern} vs ${value}`);
  }
});
