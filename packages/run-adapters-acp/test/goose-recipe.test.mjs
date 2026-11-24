// Goose's recipe as the package ships it (recipes/goose.json) and as the loader types it for a run: what was measured on
// Goose 1.59.2, and nothing the proxy sets. No binary is run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gooseRecipe, recipeFile, recipeProblems, RESERVED_ENV } from '@parcha/agentrun-harness-acp';

const BINARY = '/opt/agents/goose-1.59.2/goose';

test('the recipe file runs `<binary> acp`, declares session/load and MCP over HTTP, and bills through the proxy', () => {
  const file = recipeFile('goose');
  assert.equal(file.id, 'goose');
  assert.equal('command' in file, false, 'the binary is the install\'s, never the file\'s');
  assert.deepEqual(file.args, ['acp']);
  assert.deepEqual(file.declares, { load: true, mcp: 'http' });
  assert.deepEqual(file.billing, { kind: 'proxy' });
  assert.deepEqual(file.state, ['.local/share/goose/sessions']);
});

test('its variables: the provider, approve mode, naming and keyring off, and the dead proxy with loopback exempt', () => {
  assert.deepEqual(recipeFile('goose').env, {
    GOOSE_PROVIDER: 'anthropic',
    GOOSE_MODE: 'approve',
    GOOSE_DISABLE_SESSION_NAMING: 'true',
    GOOSE_DISABLE_KEYRING: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
});

test('its config turns every one of the eight bundled extensions off, and names no other', () => {
  const yaml = recipeFile('goose').files['.config/goose/config.yaml'];
  const lines = yaml.trim().split('\n');
  assert.equal(lines[0], 'extensions:');
  const named = lines.slice(1).map((line) => /^ {2}([a-z]+): \{(.*)\}$/.exec(line));
  assert.ok(named.every(Boolean), yaml);
  assert.deepEqual(named.map((m) => m[1]).sort(), ['analyze', 'apps', 'chatrecall', 'developer', 'extensionmanager', 'skills', 'summon', 'todo']);
  for (const m of named) {
    assert.match(m[2], /^enabled: false, /, `${m[1]} is off`);
    assert.match(m[2], new RegExp(`name: ${m[1]}, bundled: true`));
  }
  assert.deepEqual(Object.keys(recipeFile('goose').files), ['.config/goose/config.yaml']);
});

test("its allowFile is Goose's permission file, in Goose's own form, and it declares no title tie: Goose asks nothing for our tools, and every request it does make goes to the host's gate", () => {
  const file = recipeFile('goose');
  assert.deepEqual(file.allowFile, { path: '.config/goose/permission.yaml', form: 'goose-permission' });
  assert.equal(file.quirks?.permissionTie, undefined);
});

test('recipeProblems refuses an allowFile outside HOME, one in a form no agent reads, one at a path the recipe also writes, and a title tie other than "title"', () => {
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'proxy' } };
  assert.deepEqual(recipeProblems({ ...base, allowFile: { path: '.config/goose/permission.yaml', form: 'goose-permission' }, announces: { tool: '_meta.goose.toolCall.toolName' }, quirks: { permissionTie: 'title' } }), []);
  assert.match(recipeProblems({ ...base, allowFile: { path: '/etc/goose/permission.yaml', form: 'goose-permission' } }).join(' '), /allowFile .*inside the private HOME/);
  assert.match(recipeProblems({ ...base, allowFile: { path: '.config/goose/permission.yaml', form: 'yaml' } }).join(' '), /allowFile .*form/);
  assert.match(recipeProblems({ ...base, allowFile: { path: '.config/goose/permission.yaml' } }).join(' '), /allowFile .*form/);
  assert.match(recipeProblems({ ...base, allowFile: { path: 'p.yaml', form: 'goose-permission' }, files: { 'p.yaml': '' } }).join(' '), /allowFile .*files/);
  assert.match(recipeProblems({ ...base, quirks: { permissionTie: 'name' } }).join(' '), /permissionTie/);
});

test('a run\'s recipe adds the binary and GOOSE_MODEL, and recipeProblems finds none', () => {
  const recipe = gooseRecipe({ command: BINARY, model: 'claude-sonnet-5-5' });
  assert.deepEqual(recipeProblems(recipe), []);
  assert.equal(recipe.command, BINARY);
  assert.equal(recipe.env.GOOSE_MODEL, 'claude-sonnet-5-5');
  // The proxy's variables come from the proxy hook, for each process: never the recipe's.
  for (const name of ['ANTHROPIC_HOST', 'ANTHROPIC_API_KEY']) assert.equal(name in recipe.env, false, name);
  for (const name of Object.keys(recipe.env)) assert.equal(RESERVED_ENV.has(name), false, name);
});

test('a recipe that could not run is refused: a relative binary, a model that is no model id', () => {
  assert.throws(() => gooseRecipe({ command: 'goose', model: 'claude-sonnet-5-5' }), /absolute path/);
  for (const model of ['', 'two\nlines', 'a b', '-flag', 'x'.repeat(300)]) assert.throws(() => gooseRecipe({ command: BINARY, model }), /not a model id/, JSON.stringify(model));
});

test('the package ships its recipes', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('recipes'));
});

test('recipeProblems refuses the title tie without an announces field: the tie answers only a request for a call that field named, so without it the tie never fires', () => {
  // Before: both loaded, and every request for our tools then went to the gate, parked or denied.
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'proxy' } };
  assert.match(recipeProblems({ ...base, quirks: { permissionTie: 'title' } }).join(' '), /title tie .*needs announces/);
  assert.deepEqual(recipeProblems({ ...base, announces: { tool: 'rawInput.toolName', server: 'rawInput.providerIdentifier', args: 'rawInput.args' }, quirks: { permissionTie: 'title' } }), []);
});

test("recipeProblems refuses an announces path that starts at the update's title, toolCallId, kind, status, rawOutput, content, locations or sessionUpdate: one through them would let a title or a tool's output name a call again", () => {
  // Before: any dotted path loaded, so `{ "tool": "title" }` named a call by a title of exactly `agentrun__write`, and
  // `{ "tool": "rawOutput.toolName" }` by a native read whose output held `toolName: "agentrun__write"`.
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'proxy' } };
  for (const said of [{ tool: 'title' }, { tool: 'title.text' }, { tool: 'toolCallId' }, { tool: 'toolCallId.x' }, { tool: 'kind.name' }, { tool: 'status' }, { tool: 'rawInput.toolName', server: 'kind' }, { tool: 'rawInput.toolName', args: 'status' }, { tool: 'rawOutput.toolName' }, { tool: 'rawOutput' }, { tool: 'rawInput.toolName', server: 'rawOutput.server' }, { tool: 'content.text' }, { tool: 'locations.path' }, { tool: 'sessionUpdate' }]) {
    assert.match(recipeProblems({ ...base, announces: said }).join(' '), /announces is/, JSON.stringify(said));
  }
});

test("recipeProblems takes an announces path anywhere else in the update: only Goose's _meta path is read from a real release, so no other agent's shape is pinned", () => {
  // Before: only paths under _meta or rawInput loaded, a rule fitted to Cursor's rawInput as only our fake sends it.
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'proxy' } };
  for (const said of [{ tool: 'toolName' }, { tool: 'titled.toolName' }, { tool: 'statusOf.tool' }, { tool: 'rawInput.toolName', args: 'rawInput' }]) {
    assert.deepEqual(recipeProblems({ ...base, announces: said }), [], JSON.stringify(said));
  }
});

test("its announces field names a call by Goose 1.59.2's _meta.goose.toolCall.toolName (`agentrun__<tool>`, the name the model calls), never by its title", () => {
  // Goose's tool_call carries the tool's prefixed name in _meta (goose-acp conversion.rs goose_tool_call_meta); its title
  // is for people (`agentrun: write · proof.txt`) and is never read.
  assert.deepEqual(recipeFile('goose').announces, { tool: '_meta.goose.toolCall.toolName' });
});

test('recipeProblems refuses an announces field with no tool path, a path that is not dotted names, or a key it does not know', () => {
  const base = { id: 'x', command: BINARY, declares: { load: true, mcp: 'http' }, billing: { kind: 'proxy' } };
  assert.deepEqual(recipeProblems({ ...base, announces: { tool: '_meta.goose.toolCall.toolName' } }), []);
  assert.deepEqual(recipeProblems({ ...base, announces: { tool: 'rawInput.toolName', server: 'rawInput.providerIdentifier', args: 'rawInput.args' } }), []);
  assert.match(recipeProblems({ ...base, announces: {} }).join(' '), /announces/);
  assert.match(recipeProblems({ ...base, announces: { tool: 7 } }).join(' '), /announces/);
  assert.match(recipeProblems({ ...base, announces: { tool: 'rawInput..toolName' } }).join(' '), /announces/);
  assert.match(recipeProblems({ ...base, announces: { tool: 'rawInput.toolName', server: '' } }).join(' '), /announces/);
  assert.match(recipeProblems({ ...base, announces: { tool: 'rawInput.toolName', title: 'title' } }).join(' '), /announces/);
});
