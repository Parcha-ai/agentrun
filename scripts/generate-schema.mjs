import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import TJS from 'typescript-json-schema';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'packages/dsl/schema/workflow.schema.json');
const program = TJS.programFromConfig(resolve(root, 'packages/dsl/tsconfig.json'));
const schema = TJS.generateSchema(program, 'Workflow', {
  required: true,
  strictNullChecks: true,
  ref: true,
  aliasRef: false,
  titles: true,
  ignoreErrors: false,
  noExtraProps: false,
});
if (!schema) throw new Error('Workflow type did not produce a JSON Schema');
// Imported type aliases may be named using an absolute compiler path. Replace those names
// and their references so the shipped schema is portable and contains no build-machine paths.
const names = new Map(Object.keys(schema.definitions ?? {}).map(name => [name, name.replace(/^import\(.*\)\.([^.]*)$/, '$1')]));
if (new Set(names.values()).size !== names.size) throw new Error('Colliding portable schema definition names');
function portable(value) {
  if (Array.isArray(value)) return value.map(portable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/definitions/')) {
      const original = decodeURIComponent(item.slice('#/definitions/'.length));
      return [key, '#/definitions/' + (names.get(original) ?? original)];
    }
    if (key === 'title' && typeof item === 'string') return [key, names.get(item) ?? item];
    return [key, portable(item)];
  }));
}
const clean = portable(schema);
clean.definitions = Object.fromEntries(Object.entries(clean.definitions ?? {}).map(([name, value]) => [names.get(name) ?? name, value]));
Object.assign(schema, clean);
schema.$id = 'https://agentrun.ai/schema/v2/workflow.schema.json';
schema.title = 'AgentRun DSL v2 workflow';
schema.$comment = 'Generated from the public Workflow TypeScript type. This schema assists editors; validateWorkflow additionally enforces bounds, state references and node semantics. Generation: node scripts/generate-schema.mjs';
const bytes = `${JSON.stringify(schema, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== bytes) throw new Error('Workflow schema is stale; run node scripts/generate-schema.mjs');
  console.log('Workflow JSON Schema matches source');
} else {
  await mkdir(resolve(root, 'packages/dsl/schema'), { recursive: true });
  await writeFile(output, bytes);
  console.log('Generated packages/dsl/schema/workflow.schema.json');
}
