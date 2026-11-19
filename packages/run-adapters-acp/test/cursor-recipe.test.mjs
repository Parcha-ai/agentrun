// Cursor's recipe as the package ships it (recipes/cursor.json) and as the loader types it for a run: what was measured
// on Cursor 2026.11.13-eacade1 over ACP (harness S0), its pin, its facts and the card its owner reads. No binary is run.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACP_CODES, CURSOR_CODES, CURSOR_INSTALL, CURSOR_LIMITS, CURSOR_PIN, cursorAdapter, cursorCard, cursorFacts, cursorRecipe, cursorRelease, cursorRootOf, recipeFile, recipeProblems, RESERVED_ENV, treeDigest, verifyPinnedTree } from '@parcha/agentrun-harness-acp';
import { onCursorPin, scratch } from './helpers.mjs';

const BINARY = '/opt/agents/cursor-2026.11.13/dist-package/cursor-agent';

test('the recipe file runs `<binary> --disable-auto-update acp`, declares session/load and MCP over HTTP, and is billed to the plan', () => {
  const file = recipeFile('cursor');
  assert.equal(file.id, 'cursor');
  assert.equal(file.label, 'Cursor');
  assert.equal('command' in file, false, "the binary is the install's, never the file's");
  assert.deepEqual(file.args, ['--disable-auto-update', 'acp']);
  assert.deepEqual(file.declares, { load: true, mcp: 'http' });
  assert.equal(file.billing.kind, 'plan');
  assert.deepEqual(file.billing, { kind: 'plan', ...CURSOR_LIMITS });
  assert.ok(Number.isInteger(CURSOR_LIMITS.maxTurns) && CURSOR_LIMITS.maxTurns >= 1);
  assert.ok(Number.isInteger(CURSOR_LIMITS.maxToolCalls) && CURSOR_LIMITS.maxToolCalls >= 1);
  // Where Cursor keeps them with XDG_CONFIG_HOME set, as the adapter sets it ($HOME/.config): its config directory.
  assert.deepEqual(file.state, ['.config/cursor/acp-sessions']);
});

test('its key is CURSOR_API_KEY alone, on its own row: no other key and no variable of the env names it', () => {
  const file = recipeFile('cursor');
  assert.deepEqual(file.keys, ['CURSOR_API_KEY']);
  assert.deepEqual(file.env ?? {}, {}, 'the key is handed by name at each start, never written in the recipe');
});

test('its CLI config denies every Write and allows nothing: Cursor makes no file edit, since it never asks for one', () => {
  const file = recipeFile('cursor');
  assert.deepEqual(Object.keys(file.files), ['.config/cursor/cli-config.json'], "in Cursor's config directory under the adapter's XDG_CONFIG_HOME, never ~/.cursor, which it does not read then");
  const config = JSON.parse(file.files['.config/cursor/cli-config.json']);
  assert.deepEqual(config.permissions, { allow: [], deny: ['Write(**)'] });
  assert.equal(config.approvalMode, 'allowlist');
});

test('the credential Cursor derives from its key is named, so its HOME goes when its process ends', () => {
  assert.deepEqual(recipeFile('cursor').credentials, ['.config/cursor/auth.json']);
});

test("the team admin's headless switch is a named refusal, matched on Cursor's own words", () => {
  const [refusal, ...rest] = recipeFile('cursor').refusals;
  assert.equal(rest.length, 0);
  assert.equal(refusal.code, CURSOR_CODES.headlessDisabled);
  assert.equal(CURSOR_CODES.headlessDisabled, 'CURSOR_HEADLESS_DISABLED');
  assert.equal(refusal.says, 'disabled headless Cursor CLI usage');
  assert.match(refusal.words, /team administrator/);
});

test("a run's recipe adds the binary, the run's model and the owner's limits, and recipeProblems finds none", () => {
  const recipe = cursorRecipe({ command: BINARY, model: 'gpt-5.4-nano' });
  assert.deepEqual(recipeProblems(recipe), []);
  assert.equal(recipe.command, BINARY);
  assert.equal(recipe.model, 'gpt-5.4-nano');
  assert.deepEqual(recipe.billing, { kind: 'plan', ...CURSOR_LIMITS });
  const owned = cursorRecipe({ command: BINARY, limits: { maxTurns: 3, maxToolCalls: 7 } });
  assert.deepEqual(owned.billing, { kind: 'plan', maxTurns: 3, maxToolCalls: 7 });
  assert.equal('model' in owned, false, "no model: Cursor's own default");
  for (const name of Object.keys(recipe.env ?? {})) assert.equal(RESERVED_ENV.has(name), false, name);
});

test('a recipe that could not run is refused: a relative binary, a model that is no model id, limits that are no limits', () => {
  assert.throws(() => cursorRecipe({ command: 'cursor-agent' }), /absolute path/);
  for (const model of ['', 'two\nlines', 'a b', '-flag', 'x'.repeat(300)]) assert.throws(() => cursorRecipe({ command: BINARY, model }), /not a model id/, JSON.stringify(model));
  assert.throws(() => cursorRecipe({ command: BINARY, limits: { maxTurns: 0, maxToolCalls: 5 } }), /maxTurns/);
  assert.throws(() => cursorRecipe({ command: BINARY, limits: { maxTurns: 2, maxToolCalls: -1 } }), /maxToolCalls/);
});

test('recipeProblems refuses a key that is no variable name, one the adapter sets, and a credential outside HOME', () => {
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'plan', maxTurns: 1, maxToolCalls: 1 } };
  assert.match(recipeProblems({ ...base, keys: ['lower'] }).join(' '), /key/);
  assert.match(recipeProblems({ ...base, keys: ['HOME'] }).join(' '), /HOME/);
  assert.match(recipeProblems({ ...base, keys: ['A_KEY'], env: { A_KEY: 'x' } }).join(' '), /A_KEY/);
  assert.match(recipeProblems({ ...base, credentials: ['/etc/passwd'] }).join(' '), /inside the private HOME/);
  assert.match(recipeProblems({ ...base, refusals: [{ says: '', code: 'X', words: 'y' }] }).join(' '), /refusal/);
  assert.match(recipeProblems({ ...base, model: 'a b' }).join(' '), /model/);
});

test('the pin: Cursor 2026.11.13-eacade1, its archive by the first digest recorded (the registry lists none), its launcher and every file it unpacks to by theirs', () => {
  assert.equal(CURSOR_PIN.id, 'cursor');
  assert.equal(CURSOR_PIN.version, '2026.11.13-eacade1');
  const linux = CURSOR_PIN.archives['linux-x86_64'];
  assert.equal(linux.url, 'https://downloads.cursor.com/lab/2026.11.13-eacade1/linux/x64/agent-cli-package.tar.gz');
  assert.equal(linux.format, 'tar.gz');
  assert.equal(linux.sha256, 'c02e4321f20d691ee03af94d29948dc3a81c6c34e7328da7bb1afade4c75812f');
  assert.equal(linux.cmd, './dist-package/cursor-agent');
  assert.equal(linux.binarySha256, '2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233');
  assert.equal(linux.treeSha256, 'b224cfc7d2aa702ae4c9335fba6a4fc4b04250584bf615a8dcefa946ac5e64f6');
  assert.deepEqual(Object.keys(CURSOR_PIN.archives), ['linux-x86_64'], 'pinned where it was measured, nowhere else');
});

test('the tree digest is of every file, link and folder by its path, and moves when any one of them changes', async () => {
  const root = scratch();
  mkdirSync(join(root, 'dist-package', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'dist-package', 'cursor-agent'), '#!/bin/sh\n');
  writeFileSync(join(root, 'dist-package', 'node_modules', 'x', 'index.js'), 'one');
  symlinkSync('cursor-agent', join(root, 'dist-package', 'agent'));
  const first = await treeDigest(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  await verifyPinnedTree(root, first);
  writeFileSync(join(root, 'dist-package', 'node_modules', 'x', 'index.js'), 'two');
  await assert.rejects(verifyPinnedTree(root, first), (error) => error.code === ACP_CODES.binaryMismatch && /changed since it was installed/.test(error.message));
  writeFileSync(join(root, 'dist-package', 'node_modules', 'x', 'index.js'), 'one');
  assert.equal(await treeDigest(root), first, 'the same bytes, the same digest');
  writeFileSync(join(root, 'dist-package', 'extra.js'), '');
  assert.notEqual(await treeDigest(root), first, 'a file added moves it');
  await assert.rejects(verifyPinnedTree(join(root, 'nowhere'), first), (error) => error.code === ACP_CODES.binaryUnreadable);
});

test("Cursor's adapter refuses a launcher that is not the pin's, and one outside its pinned path; on a host no release is pinned for, ACP_BINARY_UNPINNED first", () => {
  const root = scratch();
  const binary = join(root, 'dist-package', 'cursor-agent');
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, '#!/bin/sh\necho not cursor\n');
  onCursorPin(() => {
    assert.throws(() => cursorAdapter({ binary, sessionsDir: root }), (error) => error.code === ACP_CODES.binaryMismatch);
    assert.throws(() => cursorAdapter({ binary: join(root, 'cursor-agent'), sessionsDir: root }), /pinned path/);
  }, () => cursorAdapter({ binary, sessionsDir: root }));
  assert.equal(cursorRootOf(binary, './dist-package/cursor-agent'), root);
});

test('cursorRelease is the pin for a platform CURSOR_PIN names, with its digests, and none for any other', () => {
  assert.equal(cursorRelease('linux-x86_64'), CURSOR_PIN.archives['linux-x86_64']);
  for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'windows-x86_64', 'plan9']) assert.equal(cursorRelease(platform), undefined, platform);
});

test("its facts: plan billed (no wire of the host's), its own model, no steer, the owner's install line", () => {
  assert.equal(cursorFacts.id, 'cursor');
  assert.equal(cursorFacts.label, 'Cursor');
  assert.equal(cursorFacts.wire, 'plan');
  assert.equal(cursorFacts.ownModel, true);
  assert.equal(cursorFacts.steer, false);
  assert.equal(cursorFacts.rerunsStarted, false);
  assert.equal(cursorFacts.install.npmLine, CURSOR_INSTALL);
  assert.equal(CURSOR_INSTALL, 'agentrun harness install cursor');
  assert.equal(cursorFacts.install.spec, 'cursor@2026.11.13-eacade1');
  assert.equal(cursorFacts.install.codes.pins, ACP_CODES.binaryMismatch);
  assert.equal(cursorFacts.hostName('agentrun-read: read'), 'read');
  assert.equal(cursorFacts.hostName('read'), 'read');
  assert.throws(() => cursorFacts.policy({ model: 'x', tools: [] }), /plan/);
});

test("the owner's card says who bills it, that nothing caps its spend, where it stops, that it edits no file, and whose terms it runs under", () => {
  const card = cursorCard({ maxTurns: 20, maxToolCalls: 100 });
  assert.match(card, /runs Cursor's CLI on your Cursor API key, under Cursor's terms/);
  assert.match(card, /billed to your Cursor plan/);
  assert.match(card, /no spend cap/);
  assert.match(card, /stops after 20 turns or 100 tool calls/);
  assert.match(card, /makes no file edits/);
  assert.match(card, /team administrator/);
  assert.match(cursorCard({ maxTurns: 1, maxToolCalls: 1 }), /stops after 1 turn or 1 tool call\b/);
});
