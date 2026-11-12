// Generates how a model sees a computer from packages/computer/src/surface/api.ts (and the protocol types it names), so
// the words a model reads cannot drift from the code that answers them:
//   spec/computer/computer.d.ts                                     the `computer` object a script drives, whole;
//   packages/run-adapters/src/kernel/registry/computer-surface.generated.ts
//       the per-step tools' JSON schemas (computer_observe, computer_act, computer_screenshot, computer_script), and the
//       same declarations split by group, so a run's prompt declares only what its computer offers.
// node scripts/generate-computer-surface.mjs writes them; --check compares them with what is committed and fails on any
// difference (a test runs it). Key and role unions are read from packages/computer/dist/protocol.js: build it first.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import TJS from 'typescript-json-schema';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiPath = resolve(root, 'packages/computer/src/surface/api.ts');
const protocolPath = resolve(root, 'packages/computer/src/protocol.ts');
const dtsPath = resolve(root, 'spec/computer/computer.d.ts');
const kernelPath = resolve(root, 'packages/run-adapters/src/kernel/registry/computer-surface.generated.ts');

const protocol = await import(pathToFileURL(resolve(root, 'packages/computer/dist/protocol.js')).href);
if (typeof protocol.PROTOCOL_VERSION !== 'string') throw new Error('packages/computer/dist/protocol.js has no PROTOCOL_VERSION: build the package first');

// --- the declarations ---------------------------------------------------------------------------------------------
const sourceOf = async (path) => ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.ES2022, true);
const api = await sourceOf(apiPath);
const wire = await sourceOf(protocolPath);

/** A file's type declarations by name: interfaces and type aliases. */
const declarationsOf = (source) => {
  const found = new Map();
  for (const statement of source.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) found.set(statement.name.text, statement);
  }
  return found;
};
const apiTypes = declarationsOf(api);
const wireTypes = declarationsOf(wire);

/** The names of the types a node refers to. */
const referencesOf = (node) => {
  const names = new Set();
  const visit = (child) => {
    if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) names.add(child.typeName.text);
    if (ts.isExpressionWithTypeArguments(child) && ts.isIdentifier(child.expression)) names.add(child.expression.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
};

// The types a script or a tool's arguments reach, from Computer and the tools' arguments: the protocol's first, in the
// order they are reached, then the surface's in its file's order.
const TOOL_ARGS = { computer_observe: 'ObserveArgs', computer_act: 'ActArgs', computer_screenshot: 'ScreenshotArgs', computer_script: 'ScriptArgs' };
// A name in api.ts is its own type there, else the protocol's it imports; a name in protocol.ts is always the protocol's.
const reachedApi = new Set();
const reachedWire = new Set();
const walk = (name, inApi) => {
  const own = inApi && apiTypes.has(name);
  const seen = own ? reachedApi : reachedWire;
  const node = own ? apiTypes.get(name) : wireTypes.get(name);
  if (seen.has(name) || !node) return; // seen, or a built-in: Promise, Record, RegExp
  seen.add(name);
  for (const next of referencesOf(node)) walk(next, own);
};
walk('Computer', true);
// Every type a script reaches that is not Computer itself, which is split by group below.
const wireNames = [...wireTypes.keys()].filter((name) => reachedWire.has(name));
const apiNames = [...apiTypes.keys()].filter((name) => reachedApi.has(name) && name !== 'Computer');
// The tools' arguments reach their own types too; a name both files declare would read as one type, so it is an error.
for (const name of Object.values(TOOL_ARGS)) walk(name, true);
for (const name of reachedWire) if (reachedApi.has(name)) throw new Error(`${name} is both the surface's and the protocol's: rename the surface's`);

/** A declaration's text with its doc comment, without `export`, and `(typeof X)[number]` as X's literals. */
const textOf = (node, source) => {
  const text = node.getFullText(source).replace(/^\s*\n/, '').replace(/^(\s*)export /m, '$1');
  return text.trim().replace(/\(typeof (\w+)\)\[number\]/g, (_whole, name) => {
    const values = protocol[name];
    if (!Array.isArray(values) || values.length === 0) throw new Error(`(typeof ${name})[number]: dist/protocol.js has no array ${name}`);
    return values.map((value) => JSON.stringify(value)).join(' | ');
  });
};
const types = [...wireNames.map((name) => textOf(wireTypes.get(name), wire)), ...apiNames.map((name) => textOf(apiTypes.get(name), api))].join('\n\n');

// Computer's members, each with the groups its JSDoc names (`@group ui`; there with any of them), or none: always there.
const computerNode = apiTypes.get('Computer');
const members = computerNode.members.map((member) => {
  const tag = ts.getJSDocTags(member).find((each) => each.tagName.text === 'group');
  const groups = typeof tag?.comment === 'string' ? tag.comment.trim().split(/\s+/).filter(Boolean) : [];
  if (tag && groups.length === 0) throw new Error(`Computer.${member.name?.getText(api)}: @group names no group`);
  for (const group of groups) if (!protocol.GROUPS.includes(group)) throw new Error(`Computer.${member.name?.getText(api)}: @group ${group} is not one of the protocol's groups`);
  const text = member.getFullText(api).replace(/^\s*\n/, '').split('\n').map((line) => line.replace(/^\t/, '')).join('\n').trim().replace(/\t/g, '  ');
  return { ...(groups.length > 0 ? { groups } : {}), text: text.replace(/\n/g, '\n  ') };
});
const computerDoc = textOf(computerNode, api).split('\ninterface Computer')[0].trim();

const HEADER = '// Generated by scripts/generate-computer-surface.mjs from packages/computer/src/surface/api.ts and protocol.ts. Do not edit.';
const indent = (text) => text.replace(/\t/g, '  ');
/** The declarations for a computer with these groups (all of them: every group). */
const declarations = (keep) => [
  indent(types),
  `${computerDoc}\ninterface Computer {\n${members.filter((member) => !member.groups || member.groups.some(keep)).map((member) => `  ${member.text}`).join('\n')}\n}`,
  '/** The computer this script drives. */\ndeclare const computer: Computer;',
].join('\n\n');
const dts = `${HEADER}\n// The \`computer\` object a script drives. A member marked @group exists only on a computer that declares that group.\n\n${declarations(() => true)}\n`;

// --- the tools' schemas -------------------------------------------------------------------------------------------
const program = TJS.programFromConfig(resolve(root, 'packages/computer/tsconfig.json'), [apiPath]);
const generator = TJS.buildGenerator(program, { required: true, strictNullChecks: true, ref: false, aliasRef: false, titles: false, noExtraProps: true, ignoreErrors: false });
if (!generator) throw new Error('packages/computer did not compile for the schema generator');
// Inline, a type's doc repeats at every use: the long ones a tool's schema says in a few words instead, keyed by how
// they start. A key that no longer matches fails the generator, so the list can't go stale.
const SHORT = {
  "A driver's name for one element": 'An element\'s ref from computer_observe, as "@e12".',
  'In screen and input, pixels of the full screenshot': "[x, y]: in the window's points (an element's bounds); with no ui group, in screenshot pixels.",
};
const shortened = new Set();
/** A tool's schema: inline (no $ref), closed, its long repeated docs short, and without the $schema line and the
 *  top-level description a tool's parameters never carry (the tool's own description says it). */
const schemaOf = (name) => {
  const { $schema: _schema, description: _description, ...schema } = generator.getSchemaForSymbol(name);
  return JSON.parse(JSON.stringify(schema), (key, value) => {
    // A tuple ([x, y]) comes out as draft-04's list of items, which model APIs refuse: one items schema when its
    // members are alike (a Point's numbers), else 2020-12's prefixItems.
    if (value && typeof value === 'object' && Array.isArray(value.items)) {
      const items = value.items.map(({ title: _title, ...item }) => item);
      const alike = items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]));
      const { items: _items, ...rest } = value;
      return alike ? { ...rest, items: items[0] } : { ...rest, prefixItems: items };
    }
    if (key !== 'description' || typeof value !== 'string') return value;
    const start = Object.keys(SHORT).find((each) => value.startsWith(each));
    if (!start) return value.replace(/\n/g, ' ');
    shortened.add(start);
    return SHORT[start];
  });
};
const schemas = Object.fromEntries(Object.entries(TOOL_ARGS).map(([tool, name]) => [tool, schemaOf(name)]));
if (!JSON.stringify(schemas.computer_act).includes('"press"')) throw new Error('computer_act did not take the protocol\'s steps');
for (const start of Object.keys(SHORT)) if (!shortened.has(start)) throw new Error(`SHORT["${start}"] matches no description: remove it`);

const kernel = `${HEADER}
// The computer's per-step tools' schemas and the \`computer\` object's declarations, split by group.

/** Each per-step tool's parameters, as JSON Schema. */
export const COMPUTER_TOOL_SCHEMAS: { readonly [tool in ${Object.keys(TOOL_ARGS).map((tool) => JSON.stringify(tool)).join(' | ')}]: object } = ${JSON.stringify(schemas, null, 2)};

/** The types \`computer\` names. */
const TYPES = ${JSON.stringify(indent(types))};
/** Computer's doc comment. */
const DOC = ${JSON.stringify(computerDoc)};
/** Computer's members, each with the groups it needs one of. */
const MEMBERS: readonly { groups?: readonly string[]; text: string }[] = ${JSON.stringify(members, null, 2)};

/** The declarations a script on a computer with these groups reads: the types, Computer with only the members its
 *  groups offer, and \`declare const computer\`. */
export function computerDeclarations(groups: readonly string[]): string {
  const members = MEMBERS.filter((member) => member.groups === undefined || member.groups.some((group) => groups.includes(group)));
  return [TYPES, \`\${DOC}\\ninterface Computer {\\n\${members.map((member) => \`  \${member.text}\`).join("\\n")}\\n}\`, "/** The computer this script drives. */\\ndeclare const computer: Computer;"].join("\\n\\n");
}
`;

// --- write, or check ----------------------------------------------------------------------------------------------
const outputs = [
  [dtsPath, dts],
  [kernelPath, kernel],
];
if (process.argv.includes('--check')) {
  const stale = [];
  for (const [path, text] of outputs) {
    const committed = await readFile(path, 'utf8').catch(() => '');
    if (committed !== text) stale.push(path.slice(root.length));
  }
  if (stale.length > 0) {
    console.error(`stale: ${stale.join(', ')}. Run node scripts/generate-computer-surface.mjs and commit the result.`);
    process.exit(1);
  }
  console.log('computer surface: up to date');
} else {
  for (const [path, text] of outputs) await writeFile(path, text);
  console.log(`wrote ${outputs.map(([path]) => path.slice(root.length)).join(', ')}`);
}
