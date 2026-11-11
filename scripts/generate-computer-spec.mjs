// Generates spec/computer's machine-readable files from packages/computer/src/protocol.ts, so the published wire is the
// code's and cannot drift from it:
//   spec/computer/schema/methods.schema.json  each method's params and result, as JSON Schema, from DaemonMethods;
//   spec/computer/protocol.json                the protocol's version, its limits, the JSON-RPC codes and cancel method,
//                                               the groups and the key table, read from the built protocol module.
// node scripts/generate-computer-spec.mjs writes them; --check compares them with what is committed and fails on any
// difference (a test runs it). The constants are read from packages/computer/dist/protocol.js: build the package first.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import TJS from 'typescript-json-schema';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'spec/computer');
const schemaPath = resolve(outDir, 'schema/methods.schema.json');
const protocolPath = resolve(outDir, 'protocol.json');

const protocol = await import(pathToFileURL(resolve(root, 'packages/computer/dist/protocol.js')).href);
const version = protocol.PROTOCOL_VERSION;
if (typeof version !== 'string' || version === '') throw new Error('packages/computer/dist/protocol.js has no PROTOCOL_VERSION: build the package first');

// --- the methods, as JSON Schema --------------------------------------------------------------------------------
const program = TJS.programFromConfig(resolve(root, 'packages/computer/tsconfig.json'));
const generator = TJS.buildGenerator(program, {
  required: true,
  strictNullChecks: true,
  ref: true,
  aliasRef: false,
  titles: true,
  ignoreErrors: false,
  noExtraProps: false,
});
if (!generator) throw new Error('packages/computer did not compile for the schema generator');
// The wire's own names: the method table, and the types a reader looks up on their own.
const symbols = ['DaemonMethods', 'DaemonErrorKind', 'Group', 'ComputerKind', 'ComputerOs', 'InputAction'];
const generated = generator.getSchemaForSymbols(symbols, true, true);

// Imported type aliases may be named by an absolute compiler path: replace those names and their references, so the
// published schema holds no build machine's paths. A type asked for by name and reached through an import is the same
// type under two names; they are kept once, and two different definitions under one name are an error.
const names = new Map(Object.keys(generated.definitions ?? {}).map((name) => [name, name.replace(/^import\(.*\)\.([^.]*)$/, '$1')]));
function portable(value) {
  if (Array.isArray(value)) return value.map(portable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/definitions/')) {
      const original = decodeURIComponent(item.slice('#/definitions/'.length));
      return [key, `#/definitions/${names.get(original) ?? original}`];
    }
    if (key === 'title' && typeof item === 'string') return [key, names.get(item) ?? item];
    return [key, portable(item)];
  }));
}
// After renaming, the name asked for may be only a reference to the same type under its import path: a reference to
// itself, which the full definition replaces.
const merged = new Map();
const selfRef = (named, value) => value?.$ref === `#/definitions/${named}`;
for (const [name, value] of Object.entries(portable(generated).definitions ?? {})) {
  const named = names.get(name) ?? name;
  const seen = merged.get(named);
  if (seen === undefined || selfRef(named, seen)) merged.set(named, value);
  else if (!selfRef(named, value) && JSON.stringify(seen) !== JSON.stringify(value)) throw new Error(`two different schema definitions are both named ${named}`);
}
for (const [named, value] of merged) if (selfRef(named, value)) throw new Error(`${named} is only a reference to itself`);
// A map type (Record<string, V>) comes out as an object that takes anything: it is named StringMap and its values held to
// V, so { env: { FOO: 123 } } is refused by the schema as the daemon refuses it. A map of anything else is an error here,
// never an open object in the published schema.
const MAPS = { 'Record<string,string>': ['StringMap', { type: 'string' }] };
for (const [name, value] of [...merged]) {
  if (!name.startsWith('Record<')) continue;
  const map = MAPS[name];
  if (!map) throw new Error(`${name}: a map type the generator has no value schema for; add it to MAPS`);
  merged.delete(name);
  merged.set(map[0], { ...value, title: map[0], additionalProperties: map[1] });
}
const renamed = (value) => JSON.parse(JSON.stringify(value), (_key, item) =>
  typeof item === 'string' && item.startsWith('#/definitions/Record<') ? `#/definitions/${MAPS[item.slice('#/definitions/'.length)][0]}` : item);
for (const [name, value] of [...merged]) merged.set(name, renamed(value));

const methodTable = merged.get('DaemonMethods');
if (!methodTable?.properties?.hello || !methodTable.properties['exec.run']) throw new Error('DaemonMethods did not produce the method table');
// The definitions a schema reaches through its references.
const reach = (value, into = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => reach(item, into));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string' && item.startsWith('#/definitions/')) {
        const named = item.slice('#/definitions/'.length);
        if (!into.has(named)) {
          into.add(named);
          reach(merged.get(named), into);
        }
      } else reach(item, into);
    }
  }
  return into;
};
// Params are strict, as the daemon decodes them (an unknown field is invalid), except hello's and ping's, which read
// none (wire.md). Results stay open, so a later minor version may add a field. A definition reached from both a strict
// params and a result (Empty) is given a strict twin, Strict<name>, which the params refer to instead.
const LENIENT = new Set(['hello', 'ping']);
const strictNames = new Set();
const resultNames = new Set();
const paramsOf = Object.entries(methodTable.properties).filter(([method]) => !LENIENT.has(method)).map(([, entry]) => entry.properties);
for (const params of paramsOf) reach(params.params, strictNames);
for (const entry of Object.values(methodTable.properties)) reach(entry.properties.result, resultNames);
const holdsObject = (value) => Array.isArray(value) ? value.some(holdsObject) : !!value && typeof value === 'object' && (value.type === 'object' || Object.values(value).some(holdsObject));
const shared = [...strictNames].filter((name) => resultNames.has(name) && holdsObject(merged.get(name)));
for (const name of shared) {
  if (reach(merged.get(name)).size > 0) throw new Error(`${name}: reached from both a method's params and a result, and it refers to other definitions; give its params a type of their own`);
  strictNames.delete(name);
  strictNames.add(`Strict${name}`);
  merged.set(`Strict${name}`, { ...merged.get(name), title: `Strict${name}` });
}
const twin = (value) => JSON.parse(JSON.stringify(value), (_key, item) =>
  typeof item === 'string' && shared.some((name) => item === `#/definitions/${name}`) ? `#/definitions/Strict${item.slice('#/definitions/'.length)}` : item);
for (const params of paramsOf) params.params = twin(params.params);
for (const name of strictNames) merged.set(name, twin(merged.get(name)));
const closed = (value) => {
  if (Array.isArray(value)) return value.map(closed);
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'additionalProperties' ? item : closed(item)]));
  if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
};
for (const name of strictNames) merged.set(name, closed(merged.get(name)));
// A param's number is a whole number, as the daemon decodes it (Go ints, and the desktop's whole()); the exceptions
// take fractions there: a scroll's dx and dy in pixels (whole in clicks, which the daemon checks) and a pinch's scale.
// An exception that no longer names a field fails the generator, so the list can't go stale.
const FRACTIONAL = { InputAction: ['dx', 'dy', 'scale'] };
const fractionalSeen = new Set();
const whole = (value, name) => {
  if (Array.isArray(value)) return value.map((item) => whole(item, name));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'properties' && item && typeof item === 'object') {
      out[key] = Object.fromEntries(Object.entries(item).map(([field, schema]) => {
        if (!(FRACTIONAL[name] ?? []).includes(field)) return [field, whole(schema, name)];
        fractionalSeen.add(`${name}.${field}`);
        return [field, schema];
      }));
    } else out[key] = whole(item, name);
  }
  if (out.type === 'number') out.type = 'integer';
  return out;
};
for (const name of strictNames) merged.set(name, whole(merged.get(name), name));
const staleFractional = Object.entries(FRACTIONAL).flatMap(([name, fields]) => fields.map((field) => `${name}.${field}`)).filter((one) => !fractionalSeen.has(one));
if (staleFractional.length > 0) throw new Error(`FRACTIONAL names fields no param has: ${staleFractional.join(', ')}`);

const definitions = Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const methods = definitions.DaemonMethods;
const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `https://agentrun.ai/spec/computer/${version}/methods.schema.json`,
  title: `AgentRun computer protocol ${version}: methods`,
  $comment: 'Generated from packages/computer/src/protocol.ts (DaemonMethods) by node scripts/generate-computer-spec.mjs. Each property of DaemonMethods is a method: its params and its result.',
  $ref: '#/definitions/DaemonMethods',
  definitions,
};

// --- the constants ----------------------------------------------------------------------------------------------
const number = (name) => {
  const value = protocol[name];
  if (typeof value !== 'number') throw new Error(`protocol.${name} is not a number`);
  return value;
};
const constants = {
  $comment: 'Generated from packages/computer/src/protocol.ts by node scripts/generate-computer-spec.mjs.',
  protocolVersion: version,
  methods: Object.keys(methods.properties).sort(),
  jsonrpc: { version: '2.0', cancelMethod: protocol.CANCEL_METHOD, codes: { ...protocol.JSONRPC_CODES } },
  limits: {
    maxLineBytes: number('MAX_LINE_BYTES'),
    maxOutputBytes: number('MAX_OUTPUT_BYTES'),
    maxChunkBytes: number('MAX_CHUNK_BYTES'),
    maxListDepth: number('MAX_LIST_DEPTH'),
    maxListEntries: number('MAX_LIST_ENTRIES'),
    processRingBytes: number('PROCESS_RING_BYTES'),
    processLogBytes: number('PROCESS_LOG_BYTES'),
    maxProcesses: number('MAX_PROCESSES'),
    processRetainedBytes: number('PROCESS_RETAINED_BYTES'),
    maxReadWaitMs: number('MAX_READ_WAIT_MS'),
    maxActions: number('MAX_ACTIONS'),
    maxBatchWaitMs: number('MAX_BATCH_WAIT_MS'),
    maxKeyRepeat: number('MAX_KEY_REPEAT'),
    maxUiNodes: number('MAX_UI_NODES'),
  },
  errorKinds: [...(definitions.DaemonErrorKind?.enum ?? [])].sort(),
  groups: [...protocol.GROUPS],
  providerGroups: [...protocol.PROVIDER_GROUPS],
  keys: [...protocol.KEYS],
};
if (constants.errorKinds.length === 0) throw new Error('DaemonErrorKind did not produce its kinds');

const files = [
  [schemaPath, `${JSON.stringify(schema, null, 2)}\n`],
  [protocolPath, `${JSON.stringify(constants, null, 2)}\n`],
];
if (process.argv.includes('--check')) {
  const stale = [];
  for (const [path, bytes] of files) {
    const committed = await readFile(path, 'utf8').catch(() => undefined);
    if (committed !== bytes) stale.push(path.slice(root.length));
  }
  if (stale.length > 0) throw new Error(`spec/computer is stale (${stale.join(', ')}); run node scripts/generate-computer-spec.mjs`);
  console.log('spec/computer matches packages/computer/src/protocol.ts');
} else {
  await mkdir(resolve(outDir, 'schema'), { recursive: true });
  for (const [path, bytes] of files) await writeFile(path, bytes);
  console.log(`Generated ${files.map(([path]) => path.slice(root.length)).join(' and ')}`);
}
