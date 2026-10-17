// The DemoSpec JSON Schema, generated from the type `@parcha/agentrun-pi/signin` declares (packages/pi/src/signin/spec.ts),
// so the type and the schema never drift: `node scripts/generate-demo-schema.mjs` writes it, `--check` fails when the
// committed file is not what the type gives. examples/demo.schema.json extends it with the template's own fields.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import TJS from 'typescript-json-schema';

const root = fileURLToPath(new URL('../', import.meta.url));
export const output = resolve(root, 'examples/demo-spec.schema.json');

/** The schema text the type gives now. */
export function generated() {
  const program = TJS.programFromConfig(resolve(root, 'packages/pi/tsconfig.json'), [resolve(root, 'packages/pi/src/signin/spec.ts')]);
  const schema = TJS.generateSchema(program, 'DemoSpec', { required: true, strictNullChecks: true, ref: true, aliasRef: true, titles: true, ignoreErrors: false, noExtraProps: false });
  if (!schema) throw new Error('DemoSpec type did not produce a JSON Schema');
  // A type the compiler names by its path (import("/abs/path").Key) gets its short name, as scripts/generate-schema.mjs
  // does for the workflow schema, so the schema carries no build machine's paths.
  const names = new Map(Object.keys(schema.definitions ?? {}).map((name) => [name, name.replace(/^import\(.*\)\.([^.]*)$/, '$1')]));
  if (new Set(names.values()).size !== names.size) throw new Error('Colliding portable schema definition names');
  const portable = (value) => {
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
  };
  const clean = portable(schema);
  clean.definitions = Object.fromEntries(Object.entries(clean.definitions ?? {}).map(([name, value]) => [names.get(name) ?? name, value]));
  Object.assign(schema, clean);
  if (JSON.stringify(schema).includes('import(')) throw new Error('DemoSpec schema still names a type by its compiler path');
  schema.$id = 'https://agentrun.ai/schema/demo-spec.schema.json';
  schema.title = 'AgentRun demo spec';
  schema.$comment = 'Generated from the DemoSpec TypeScript type of @parcha/agentrun-pi/signin. Generation: node scripts/generate-demo-schema.mjs';
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const bytes = generated();
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8').catch(() => '') !== bytes) throw new Error('The DemoSpec schema is stale; run node scripts/generate-demo-schema.mjs');
    console.log('DemoSpec JSON Schema matches its type');
  } else {
    await mkdir(resolve(root, 'examples'), { recursive: true });
    await writeFile(output, bytes);
    console.log('Generated examples/demo-spec.schema.json');
  }
}
