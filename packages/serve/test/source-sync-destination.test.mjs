import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourcePolicy } from '../dist/source-sync/destination.js';

const boxes = [{ id: 'docker', available: true, network: 'allowlist' }];
function snapshot(runtime = 'codex', capabilities = ['file_read', 'file_write']) {
  return { source: { runtime }, configuration: { tools: [], permissions: runtime === 'codex'
    ? { sandbox_mode: 'danger-full-access', approval_policy: 'never', web_search: 'disabled', project_trust: 'trusted' }
    : { defaultMode: 'bypassPermissions', tools: ['Read', 'Write'] },
  native_tools: { version: runtime === 'codex' ? '0.171.0' : '2.1.322', complete: true, source: 'versioned-runtime', capabilities, disabled: [] } } };
}
test('Move refuses snapshots without complete native tool evidence', () => {
  const source = snapshot(); delete source.configuration.native_tools;
  assert.equal(sourcePolicy(source, boxes, []).blockers[0].code, 'native_tool_closure');
  source.configuration.native_tools = { complete: false, capabilities: [], disabled: [] };
  assert.equal(sourcePolicy(source, boxes, []).blockers[0].code, 'native_tool_closure');
});
test('a trusted explicitly portable source grants only its required host file tools', () => {
  const resolved = sourcePolicy(snapshot(), boxes, []);
  assert.equal(resolved.blockers, undefined, JSON.stringify(resolved));
  assert.deepEqual(resolved.tools, ['read', 'write']);
  assert.equal(resolved.toolSettings.bash, undefined);
});
test('an unsupported required builtin is a named prerequisite, never omitted', () => {
  const source = snapshot('codex', ['file_read', 'image_generate']);
  const resolved = sourcePolicy(source, boxes, []);
  assert.equal(resolved.blockers[0].code, 'native_capability');
  assert.match(resolved.blockers[0].message, /image_generate/);
});
test('subagent availability is checked against the actual selected harness tool registry', () => {
  const resolved = sourcePolicy(snapshot('codex', ['subagents']), boxes, []);
  assert.equal(resolved.blockers[0].code, 'native_capability');
  assert.match(resolved.blockers[0].message, /subagents/);
});
test('Codex workspace-write cannot lose its protected-path policy in an unrestricted host shell', () => {
  const source = snapshot('codex', ['shell']); source.configuration.permissions.sandbox_mode = 'workspace-write';
  assert.equal(sourcePolicy(source, boxes, []).blockers[0].code, 'policy_mapping');
});
test('untrusted selected source projects cannot inherit a trusted destination policy', () => {
  const source = snapshot(); source.configuration.permissions.project_trust = 'untrusted';
  assert.equal(sourcePolicy(source, boxes, []).blockers[0].code, 'policy_mapping');
});
test('Claude bypass still asks before shell or destructive external operations', () => {
  const source = snapshot('claude-code', ['shell', 'file_read', 'file_write']);
  source.configuration.permissions.tools.push('Bash');
  const resolved = sourcePolicy(source, boxes, ['mcp:files/delete']);
  assert.equal(resolved.blockers, undefined, JSON.stringify(resolved));
  assert.equal(resolved.toolSettings.bash.permission, 'ask');
  assert.equal(resolved.toolSettings['mcp:files/delete'].permission, 'ask');
  assert.equal(resolved.toolSettings.read.permission, 'allow');
});
test('a read-only Claude allowlist never gets shell or write through generic defaults', () => {
  const source = snapshot('claude-code', ['file_read', 'image_read', 'session_end']);
  source.configuration.permissions.tools = ['Read'];
  const resolved = sourcePolicy(source, boxes, []);
  assert.equal(resolved.blockers, undefined, JSON.stringify(resolved));
  assert.deepEqual(resolved.tools, ['read']);
});
test('source search and user input map to actual host tools without adding file mutation', () => {
  const source = snapshot('claude-code', ['web_search', 'web_fetch', 'user_input', 'session_end']);
  source.configuration.permissions.tools = ['WebSearch', 'WebFetch', 'AskUserQuestion'];
  const resolved = sourcePolicy(source, boxes, []);
  assert.equal(resolved.blockers, undefined, JSON.stringify(resolved));
  assert.deepEqual(resolved.tools, ['ask_person', 'web_fetch', 'web_search']);
});
test('file-search-only cannot gain a write-capable shell as an alleged equivalent', () => {
  assert.equal(sourcePolicy(snapshot('claude-code', ['file_search']), boxes, []).blockers[0].code, 'native_capability');
});

for (const capability of ['planning', 'context_management', 'feedback']) test(`native ${capability} operations need actual managed equivalents`, () => {
  assert.equal(sourcePolicy(snapshot('codex', [capability]), boxes, []).blockers[0].code, 'native_capability');
});

test('an exact source model outside the picker uses the registered route and actual catalog', async () => {
  const { destinationPreparation } = await import('../dist/source-sync/destination.js');
  const deps = destinationPreparation({}, 'source-agent', { env: () => ({ OPENAI_API_KEY: 'fake-test-key' }), boxes: () => boxes,
    projectExecution: async () => ({ storage: 'local', isolation: 'process' }), check: async () => ({ warnings: [], stamp: {} }) });
  const source = snapshot(); source.configuration.model = 'gpt-5.5';
  const result = await deps.model(source);
  assert.equal(result.blockers, undefined, JSON.stringify(result));
  assert.equal(result.model, 'openai/gpt-5.5'); assert.equal(result.sourceModel, 'gpt-5.5');
  source.configuration.model = 'gpt-nonexistent-fixture';
  assert.ok((await deps.model(source)).blockers?.length, 'ordinary catalog still refuses unknown exact IDs');
});

test('Move refuses local project mode rewriting before destination preparation', async () => {
  const { destinationPreparation } = await import('../dist/source-sync/destination.js');
  let execution = { storage: 'local', isolation: 'uid' }, checked = 0;
  const deps = destinationPreparation({}, 'source-agent', { env: () => ({}), boxes: () => boxes,
    projectExecution: async () => { checked++; return execution; }, check: async () => ({ warnings: [], stamp: {} }) });
  assert.equal((await deps.policy(snapshot(), [])).blockers?.[0]?.code, 'project_mode_fidelity');
  execution = { storage: 'local', isolation: 'process' };
  assert.equal((await deps.policy(snapshot(), [])).blockers, undefined);
  execution = { storage: 'archil', isolation: 'uid' };
  assert.equal((await deps.policy(snapshot(), [])).blockers, undefined, 'the separate Archil project is outside local run-folder ownership changes');
  assert.equal(checked, 3, 'each preparation checks its current destination rather than caching a permissive answer');
});

test('a failed isolation probe is a named prerequisite, never a permissive display fallback', async () => {
  const { destinationPreparation } = await import('../dist/source-sync/destination.js');
  const deps = destinationPreparation({}, 'source-agent', { env: () => ({}), boxes: () => boxes,
    projectExecution: async () => { throw new Error('private probe diagnostic'); }, check: async () => ({ warnings: [], stamp: {} }) });
  const result = await deps.policy(snapshot(), []);
  assert.equal(result.blockers?.[0]?.code, 'project_mode_fidelity');
  assert.equal(JSON.stringify(result).includes('private probe diagnostic'), false);
});

for (const runtime of ['codex', 'claude-code']) test(`${runtime} shell family keeps its permission through the ordinary tool-settings validator`, async () => {
  const { settingsIssues } = await import('../dist/tool-plane.js');
  const { permissionFrom, SHELL_FAMILY, SHELL_WATCHERS } = await import('../dist/tool-gate.js');
  const source = snapshot(runtime, ['shell', 'file_read', 'file_write']);
  const resolved = sourcePolicy(source, boxes, []);
  assert.equal(resolved.blockers, undefined);
  assert.deepEqual(settingsIssues(resolved.toolSettings, 'definition.tool_settings', 'agent'), [], 'the ordinary save/prepare validator accepts every emitted setting');
  for (const name of Object.keys(SHELL_FAMILY)) {
    assert.ok(resolved.tools.includes(name));
    assert.equal(permissionFrom(name, {}, resolved.toolSettings, resolved.approvals).permission,
      runtime === 'codex' || SHELL_WATCHERS.has(name) ? 'allow' : 'ask');
  }
  assert.equal(Object.keys(resolved.toolSettings).filter(name => name.startsWith('bash')).length, 1);
});
