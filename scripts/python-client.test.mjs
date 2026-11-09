// The Python client's generated module (scripts/clients/python.mjs): its methods, types and table from a small document,
// pinned; the committed python/agentrun/_generated.py is the server's document's (--check catches a stale one) and
// holds no omitted operation; and pyright passes a consumer of the documented calls and fails a wrong one on its lines.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandOf, operationsOf } from './generate-clients.mjs';
import { pythonProblems, pythonText } from './clients/python.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATOR = join(ROOT, 'scripts', 'generate-clients.mjs');
const GENERATED = join(ROOT, 'python', 'agentrun', '_generated.py');
const PYRIGHT = join(ROOT, 'node_modules', 'pyright', 'index.js');
const TYPECHECK = join(ROOT, 'python', 'tests', 'typecheck');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, headers) => ({ description: 'ok', ...(headers ? { headers } : {}), content: { 'application/json': { schema } } });
const DOC = {
  openapi: '3.1.0',
  components: {
    schemas: {
      Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, from: { type: ['string', 'null'] }, kind: { enum: ['a', 'b'] }, live: { const: true } } },
      Page: { allOf: [ref('Thing')], required: ['from'] },
    },
  },
  paths: {
    '/things': {
      get: {
        operationId: 'listThings', summary: 'List things',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } },
          { name: 'from', in: 'query', schema: { type: 'string' } }, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
        ],
        responses: { 200: json({ type: 'object', required: ['things'], properties: { things: { type: 'array', items: ref('Thing') }, next: { oneOf: [{ type: 'object', properties: { cursor: { type: 'string' } } }, { type: 'null' }] }, choice: { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } }] } } }) },
      },
    },
    '/things/{thing_id}': {
      parameters: [{ name: 'thing_id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getThing', summary: 'Read a thing', responses: { 200: json(ref('Page'), { ETag: { schema: { type: 'string' } } }) } },
      put: {
        operationId: 'saveThing', summary: 'Save a thing',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url', 'token'], properties: { url: { type: 'string' }, token: { type: 'string' } } } } } },
        responses: { 204: { description: 'saved' } },
      },
    },
    '/things/{thing_id}/files/{path}': {
      parameters: [{ name: 'thing_id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readThingFile', summary: 'Read a file', responses: { 200: { description: 'the bytes', content: { 'application/octet-stream': { schema: { type: 'string' } } } } } },
      put: { operationId: 'writeThingFile', summary: 'Write a file', requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string' } } } }, responses: { 200: json({ type: 'object', properties: { size: { type: 'integer' } } }) } },
    },
    '/things/{thing_id}/start': {
      post: { operationId: 'startThing', summary: 'Start a thing', parameters: [{ name: 'thing_id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { secret: { type: 'string' } } } } } }, responses: { 200: json({ type: 'object' }) } },
    },
    '/runs/{run_id}': {
      get: { operationId: 'getRun', summary: 'Read a run', parameters: [{ name: 'run_id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { status: { type: 'string' } } }) } },
    },
  },
};
const MAP = {
  secretBody: ['saveThing', 'startThing'], publicFields: { saveThing: ['url'] }, multiSegment: { readThingFile: 'path', writeThingFile: 'path' },
  omit: { startThing: 'It starts in the owner\'s browser.' },
  commands: { listThings: ['things', 'list'], getThing: ['things', 'get'], saveThing: ['things', 'save'], readThingFile: ['things', 'read-file'], writeThingFile: ['things', 'write-file'], startThing: ['things', 'start'], getRun: ['runs', 'get'] },
};
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

test('the Python module is made of the projection: snake_case methods by resource, keyword parameters, TypedDicts and Literals, the table, no omitted operation', () => {
  const ops = operationsOf(DOC);
  assert.deepEqual(pythonProblems(ops, MAP, commandOf), []);
  const text = pythonText(ops, MAP, commandOf, 'h'.repeat(64));
  assert.match(text, /^# Generated by scripts\/generate-clients\.mjs from the server's OpenAPI document\. Do not edit: run node scripts\/generate-clients\.mjs\.\n# SHA-256 of what the clients are made of \(operationsOf in scripts\/generate-clients\.mjs\): h{64}\n/);
  // A field named by a keyword is written in the functional form; required and optional fields are two bases.
  assert.ok(text.includes('_ThingRequired = TypedDict("_ThingRequired", {"id": "str"})'), text);
  assert.ok(text.includes('_ThingOptional = TypedDict("_ThingOptional", {"from": "str | None", "kind": "Literal[\\"a\\", \\"b\\"]", "live": "Literal[True]"}, total=False)'));
  assert.ok(text.includes('class Thing(_ThingRequired, _ThingOptional):\n    pass'));
  // An allOf is one TypedDict with every part's fields, its own required counted.
  assert.ok(text.includes('_PageRequired = TypedDict("_PageRequired", {"id": "str", "from": "str | None"})'), 'Page holds Thing\'s fields, from required');
  assert.ok(text.includes('class ListThingsResponseNext(TypedDict, total=False):\n    cursor: str'), 'an unnamed object is named for where it sits');
  assert.ok(text.includes('class _ListThingsResponseRequired(TypedDict):\n    things: list[Thing]\n\n\nclass ListThingsResponse(_ListThingsResponseRequired, total=False):\n    next: ListThingsResponseNext | None'));
  assert.ok(text.includes('class ThingsResource(Group):'));
  assert.ok(text.includes('    def list(self, *, limit: int | None = None, status: Literal["a", "b"] | None = None, from_: str | None = None, idempotency_key: str | None = None, timeout: float | None = None) -> ListThingsResponse:'));
  assert.ok(text.includes('        return self._call("listThings", (), None, {"limit": limit, "status": status, "from": from_, "Idempotency-Key": idempotency_key}, timeout=timeout)'));
  assert.ok(text.includes('    def get(self, thing_id: str, *, timeout: float | None = None) -> Tagged[GetThingResponse]:'), 'an answer with an ETag is Tagged');
  // A union holding a list of a union keeps the list's members whole (a pin's value: a scalar, or a list of them).
  assert.ok(text.includes('choice: str | float | bool | None | list[str | float | bool | None]'), text.match(/choice: .*/)?.[0]);
  assert.ok(text.includes('GetThingResponse: TypeAlias = "Page"'));
  assert.ok(text.includes('    def save(self, thing_id: str, body: SaveThingBody, *, timeout: float | None = None) -> None:\n        """Save a thing (PUT /things/{thing_id}). Its body\'s string values are secrets'));
  assert.ok(text.includes('    def read_file(self, thing_id: str, path: str, *, stream: Literal[True], timeout: float | None = None) -> StreamedResponse: ...'));
  assert.ok(text.includes('    def read_file(self, thing_id: str, path: str, *, stream: bool = False, timeout: float | None = None) -> bytes | StreamedResponse:'));
  assert.ok(text.includes('    def write_file(self, thing_id: str, path: str, body: RawBody, *, body_type: str | None = None, timeout: float | None = None) -> WriteThingFileResponse:'));
  assert.ok(text.includes('    "saveThing": Operation(method="PUT", path="/things/{thing_id}", path_params=("thing_id",), multi_segment=(), query=(), headers=(), body=OperationBody(required=True, types=("application/json",)), answer="none", secret=True, public_fields=("url",), tagged=False),'));
  assert.ok(text.includes('multi_segment=("path",)'));
  assert.ok(!text.includes('startThing') && !text.includes('def start('), 'an omitted operation has neither a method nor an entry');
  // runs is the client's own group: its class is generated, and Resources leaves it to the client.
  assert.ok(text.includes('class RunsResource(Group):') && !text.includes('self.runs = '));
  assert.ok(text.includes('        self.things = ThingsResource(call)'));
  if (python) {
    const parsed = spawnSync('python3', ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: text, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test('the Python module cannot be written when two operations take one method, a method takes a hand-written name, or two arguments take one name', () => {
  const ops = operationsOf(DOC);
  const problems = (commands) => pythonProblems(ops, { ...MAP, commands: { ...MAP.commands, ...commands } }, commandOf);
  assert.match(problems({ getThing: ['things', 'list'] }).join('\n'), /listThings and getThing are both client\.things\.list in Python/);
  assert.match(problems({ getRun: ['runs', 'wait'] }).join('\n'), /getRun is client\.runs\.wait in Python, a method the client writes by hand/);
  assert.match(problems({ getRun: ['things'] }).join('\n'), /getRun is client\.things in Python, which the client already has/);
  assert.match(problems({ getRun: ['base-url', 'get'] }).join('\n'), /getRun's group base_url is a name the Python client already has/);
  const renamed = structuredClone(DOC);
  renamed.paths['/things'].get.parameters.push({ name: 'Limit', in: 'header', schema: { type: 'string' } }, { name: 'timeout', in: 'query', schema: { type: 'number' } });
  assert.match(pythonProblems(operationsOf(renamed), MAP, commandOf).join('\n'), /listThings's arguments take the Python name limit, timeout twice, or one the method keeps/);
  assert.match(pythonProblems(ops, { ...MAP, commands: { ...MAP.commands, getRun: ['jobs', 'get'] } }, commandOf).join('\n'), /no operation is in the group runs/);
});

test('generate-clients --check passes on the committed Python module and fails on a hand-edited one; its hash is the CLI table\'s, and no omitted operation is in it', { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-python-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = (...args) => spawnSync(process.execPath, [GENERATOR, '--check', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  const committed = check();
  assert.equal(committed.status, 0, committed.stderr);
  const text = readFileSync(GENERATED, 'utf8');
  const edited = join(dir, '_generated.py');
  writeFileSync(edited, text.replace('    def start(self, agent_id: str,', '    def begin(self, agent_id: str,'));
  assert.notEqual(readFileSync(edited, 'utf8'), text);
  const stale = check('--python', edited);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /_generated\.py is not the server's document's; run node scripts\/generate-clients\.mjs/);
  const hash = (file) => /SHA-256 of what the (?:table|clients) (?:is|are) made of [^\n]*: ([0-9a-f]{64})/.exec(readFileSync(file, 'utf8'))?.[1];
  assert.ok(hash(GENERATED));
  assert.equal(hash(GENERATED), hash(join(ROOT, 'packages', 'agentrun', 'lib', 'commands.generated.mjs')));
  const resources = JSON.parse(readFileSync(join(ROOT, 'scripts', 'clients', 'resources.json'), 'utf8'));
  for (const id of Object.keys(resources.omit)) assert.ok(!text.includes(`"${id}"`), `${id} is omitted, and not in the table`);
  assert.ok(!/def oauth_start\b/.test(text), 'an MCP sign-in has no method');
  assert.ok(/def oauth_client\b/.test(text), 'its public client document stays');
});

test('pyright passes a consumer of the documented calls, and fails a wrong body field, a wrong type, a missing field and an unknown method on their lines', { timeout: 240_000, skip: !existsSync(PYRIGHT) && 'pyright is not installed (npm ci)' }, () => {
  const pyright = (file) => spawnSync(process.execPath, [PYRIGHT, '--project', join(ROOT, 'python'), join(TYPECHECK, file)], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const ok = pyright('ok.py');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = pyright('bad.py');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const marked = readFileSync(join(TYPECHECK, 'bad.py'), 'utf8').split('\n').flatMap((line, i) => (line.endsWith('# error') ? [i + 1] : []));
  const failed = [...new Set([...bad.stdout.matchAll(/bad\.py:(\d+):\d+ - error/g)].map((match) => Number(match[1])))];
  assert.deepEqual(failed, marked, bad.stdout);
  assert.match(bad.stdout, /"definitio" is an undefined item/);
});
