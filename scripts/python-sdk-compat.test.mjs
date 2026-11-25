import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandOf, operationsOf } from './generate-clients.mjs';
import { pythonText } from './clients/python.mjs';
import { NATIVE_PATHS } from '../packages/serve/dist/native/schema.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PYRIGHT = join(ROOT, 'node_modules', 'pyright', 'index.js');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const source = (properties = {}, required = Object.keys(properties)) => ({
  'x-agentrun-python-preserve-object': true,
  oneOf: [
    object({ runtime: { enum: ['claude-agent-sdk', 'codex-sdk', 'eve'] }, ...properties }, ['runtime', ...required]),
    object({ runtime: { const: 'external' }, platform: { type: 'string' }, ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'workflow_tools')) }, ['runtime', 'platform', ...required]),
  ],
});
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ content: { 'application/json': { schema } } });
const runSource = source({ usage: object({ input_tokens: { type: 'integer' } }, []) });
const doc = {
  openapi: '3.1.0',
  components: { schemas: {
    Definition: object({ sdk: source() }), DefinitionInput: object({ sdk: source() }),
    Run: object({ sdk: runSource }), RunSummary: object({ sdk: runSource }),
  } },
  paths: {
    '/agents': { get: { operationId: 'getDefinition', responses: { 200: json(ref('Definition')) } },
      post: { operationId: 'createDefinition', requestBody: { required: true, ...json(ref('DefinitionInput')) }, responses: {} } },
    '/runs': { get: { operationId: 'getRun', responses: { 200: json(ref('Run')) } } },
    '/summaries': { get: { operationId: 'getRunSummary', responses: { 200: json(ref('RunSummary')) } } },
    '/sdk-runs': { post: { operationId: 'startSdkRun', requestBody: { required: true, ...json(source({
      input: { type: 'string' }, instructions: { type: 'string' },
      workflow_tools: { type: 'array', items: object({ name: { type: 'string' } }) },
    }, ['input', 'instructions'])) }, responses: {} } },
  },
};
const map = { secretBody: [], omit: {}, multiSegment: {}, commands: {
  getDefinition: ['agents', 'get'], createDefinition: ['agents', 'create'], getRun: ['runs', 'get'], getRunSummary: ['runs', 'summary'], startSdkRun: ['sdk-runs', 'start'],
} };

test('expanded SDK objects keep the published Python imports and TypedDict constructors', { skip: !python }, () => {
  const text = pythonText(operationsOf(doc), map, commandOf);
  const names = ['DefinitionSdk', 'DefinitionInputSdk', 'RunSdk', 'RunSdkUsage', 'RunSummarySdk', 'RunSummarySdkUsage', 'StartSdkRunBodyWorkflowToolsItem', 'StartSdkRunBody'];
  const checked = spawnSync('python3', ['-I', '-c', `
import sys
sys.path.insert(0, sys.argv[1])
namespace = {'__name__': 'agentrun.compatibility', '__package__': 'agentrun'}
exec(compile(sys.stdin.read(), '<generated>', 'exec'), namespace)
for name in ${JSON.stringify(names)}:
    assert name in namespace['__all__'], name
    assert callable(namespace[name]), name
    assert namespace[name]() == {}, name
assert namespace['DefinitionSdk'](runtime='codex-sdk') == {'runtime': 'codex-sdk'}
assert namespace['StartSdkRunBody'](runtime='eve', input='task', instructions='policy') == {'runtime': 'eve', 'input': 'task', 'instructions': 'policy'}
assert namespace['StartSdkRunBody2'](runtime='external', platform='capy', input='task', instructions='policy')['platform'] == 'capy'
`, join(ROOT, 'python')], { input: text, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('preserved SDK constructors remain typed and external calls require platform without a bridge', { skip: !existsSync(PYRIGHT) }, (t) => {
  const text = pythonText(operationsOf(doc), map, commandOf);
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-python-sdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'generated.py'), text.replaceAll('from ._http', 'from agentrun._http').replaceAll('from ._types', 'from agentrun._types'));
  writeFileSync(join(dir, 'pyrightconfig.json'), JSON.stringify({ include: ['consumer.py'], extraPaths: [join(ROOT, 'python')], pythonVersion: '3.11' }));
  writeFileSync(join(dir, 'consumer.py'), [
    'from generated import SdkRunsResource, StartSdkRunBody, DefinitionSdk, DefinitionInputSdk, RunSdk, RunSdkUsage, RunSummarySdk, RunSummarySdkUsage, StartSdkRunBodyWorkflowToolsItem',
    'def check(client: SdkRunsResource) -> None:',
    '    client.start(StartSdkRunBody(runtime="eve", input="task", instructions="policy"))',
    '    client.start({"runtime": "external", "platform": "capy", "input": "task", "instructions": "policy"})',
    '    client.start({"runtime": "external", "input": "task", "instructions": "policy"}) # error',
    '    client.start({"runtime": "external", "platform": "capy", "input": "task", "instructions": "policy", "workflow_tools": []}) # error',
  ].join('\n'));
  const typed = spawnSync(process.execPath, [PYRIGHT, '--project', dir], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(typed.status, 1, typed.stdout + typed.stderr);
  const lines = [...new Set([...typed.stdout.matchAll(/consumer\.py:(\d+):\d+ - error/g)].map(match => Number(match[1])))];
  assert.deepEqual(lines, [5, 6], typed.stdout + typed.stderr);
});

test('unmarked object unions retain their existing numbered public types', () => {
  const unmarked = JSON.parse(JSON.stringify(doc), (key, value) => key === 'x-agentrun-python-preserve-object' ? undefined : value);
  const text = pythonText(operationsOf(unmarked), map, commandOf);
  for (const name of ['DefinitionSdk1', 'DefinitionSdk2', 'RunSdk1Usage', 'StartSdkRunBodyObject1WorkflowToolsItem'])
    assert.ok(text.includes(`    "${name}",`), `${name} is still exported`);
  assert.match(text, /StartSdkRunBody: TypeAlias = "StartSdkRunBodyObject1 \| StartSdkRunBodyObject2"/);
});

test('expanded remote imports keep their published Python constructors and nested names', { skip: !python }, () => {
  const path = '/connectors/{connector_id}/import';
  const text = pythonText(operationsOf({ paths: { [path]: NATIVE_PATHS[path] } }), {
    secretBody: [], omit: {}, multiSegment: {}, commands: { importRemoteTarget: ['connectors', 'import-remote-target'] },
  }, commandOf);
  const names = [
    'ImportRemoteTargetBody', 'ImportRemoteTargetBodyCliAdoption', 'ImportRemoteTargetBodyTarget',
    'ImportRemoteTargetBodyTargetCapabilities', 'ImportRemoteTargetBodyTargetConfigurationItem',
    'ImportRemoteTargetBodyTargetRemote', 'ImportRemoteTargetBodyTargetSelector', 'ImportRemoteTargetResponse',
    'ImportRemoteTargetResponseNative', 'ImportRemoteTargetResponseNativeCapabilities',
    'ImportRemoteTargetResponseNativeConfigurationItem', 'ImportRemoteTargetResponseNativeRemote',
    'ImportRemoteTargetResponseNativeSelector',
  ];
  const checked = spawnSync('python3', ['-I', '-c', `
import sys
sys.path.insert(0, sys.argv[1])
namespace = {'__name__': 'agentrun.compatibility', '__package__': 'agentrun'}
exec(compile(sys.stdin.read(), '<generated>', 'exec'), namespace)
for name in ${JSON.stringify(names)}:
    assert name in namespace['__all__'], name
    assert callable(namespace[name]), name
    assert namespace[name]() == {}, name
body = namespace['ImportRemoteTargetBody'](target_id='target', target={})
assert body == {'target_id': 'target', 'target': {}}
assert namespace['ImportRemoteTargetResponse'](native={}) == {'native': {}}
`, join(ROOT, 'python')], { input: text, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
