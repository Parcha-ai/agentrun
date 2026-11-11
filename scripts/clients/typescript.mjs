// The TypeScript client's operations (packages/client/src/operations.generated.ts), from the projection
// generate-clients.mjs makes (operationsOf) and the same map (resources.json): per operation it offers, its request and
// response types and a typed method on its resource group, `client.runs.start(agentId, body)`, plus the table the
// client's hand-written runtime reads (route, parameters, body and answer types, secret body). An omitted operation, or
// one this server turns off, gets no method, as it gets no command. One the document marks browser-only
// (x-agentrun-browser-only: an MCP sign-in's start, Connect GitHub and its returns) gets no method either, and stays in
// the table. The types are emitted here from each schema's
// structure: the document's schemas use type, enum, const, properties, items, additionalProperties, oneOf, anyOf and
// allOf, nothing a few lines can't write.
const IDENT = /^[A-Za-z_$][\w$]*$/;
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;
// Headers the runtime sets itself, as the CLI does.
const OWN_HEADERS = ['authorization', 'content-type', 'accept'];
// The client's hand-written members: no generated method may take one of these names.
const HAND = { runs: ['wait', 'follow'] };
const OWN = ['baseUrl'];
const WORDS = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval'.split(' '));

const camel = (name) => name.replace(/[-_\s]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (name) => camel(name).replace(/^./, (c) => c.toUpperCase());
/** A path parameter's argument name: camelCase, and never a reserved word. */
const argName = (name) => {
  const n = camel(name.toLowerCase()).replace(/[^\w$]/g, '_');
  return WORDS.has(n) || !IDENT.test(n) ? `${n}_` : n;
};
const key = (name) => (IDENT.test(name) ? name : JSON.stringify(name));
const doc = (text) => text.replace(/\*\//g, '*\\/');

/** What the projection's media types say an operation answers: JSON, text, bytes, several of them or nothing. */
function answerOf(op) {
  const others = [...new Set(op.answers)].filter((type) => !JSON_TYPE.test(type) && type !== 'text/event-stream');
  const kinds = [...(op.answer !== null ? ['json'] : []), ...(others.some((t) => t.startsWith('text/')) ? ['text'] : []), ...(others.some((t) => !t.startsWith('text/')) ? ['bytes'] : [])];
  return kinds.length ? kinds.join('+') : 'none';
}

/** The emitter of named types: a component marked with its name (typeOf in generate-clients.mjs) is written once, by
 *  that name, and referred to everywhere else. */
function typesOf() {
  const named = new Map();
  const problems = [];
  const literal = (value) => JSON.stringify(value);
  const wrap = (text) => (text.includes(' | ') ? `(${text})` : text);
  function object(node, indent) {
    const inner = `${indent}  `;
    const lines = Object.entries(node.properties ?? {}).map(([name, value]) => `${inner}${key(name)}${node.required?.includes(name) ? '' : '?'}: ${ts(value, inner)};`);
    const extra = node.additionalProperties;
    if (!lines.length) return extra === false ? 'Record<string, never>' : `Record<string, ${extra && typeof extra === 'object' ? ts(extra, indent) : 'unknown'}>`;
    if (extra === true || (extra && typeof extra === 'object')) lines.push(`${inner}[key: string]: unknown;`);
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  function structural(node, indent) {
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : node.properties || node.additionalProperties !== undefined ? ['object'] : node.items ? ['array'] : [];
    if (!types.length) return undefined;
    const one = (type) => ({ string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' })[type]
      ?? (type === 'array' ? `Array<${node.items ? ts(node.items, indent) : 'unknown'}>` : type === 'object' ? object(node, indent) : 'unknown');
    return types.map(one).join(' | ');
  }
  function ts(node, indent = '') {
    if (node.name !== undefined) return refer(node);
    if (node.not) return 'never';
    if (node.const !== undefined) return literal(node.const);
    if (node.enum) return node.enum.map(literal).join(' | ');
    const parts = [];
    const base = structural(node, indent);
    if (base !== undefined) parts.push(base);
    const choices = node.oneOf ?? node.anyOf;
    if (choices) parts.push(choices.map((part) => ts(part, indent)).join(' | '));
    if (node.allOf) parts.push(...node.allOf.map((part) => ts(part, indent)));
    if (!parts.length) return 'unknown';
    return parts.length === 1 ? parts[0] : parts.map(wrap).join(' & ');
  }
  function refer(node) {
    const { name, ...rest } = node;
    const type = IDENT.test(name) ? pascal(name) : pascal(name.replace(/[^\w$]+/g, '_'));
    const text = JSON.stringify(rest);
    const had = named.get(type);
    if (had === undefined) {
      named.set(type, { source: text, text: null });
      named.get(type).text = ts(rest, '');
    } else if (had.source !== text) problems.push(`two schemas are both the type ${type}`);
    return type;
  }
  return { ts, named, problems };
}

/** Each offered operation's method: its group (none for a one-word command), its name, and what the runtime needs. */
function methodsOf(ops, map, commandOf) {
  return ops.filter((op) => !op.unsupported && map.omit[op.operationId] === undefined).map((op) => {
    const command = commandOf(op, map);
    const [group, name] = command.length === 1 ? [null, camel(command[0])] : [camel(command[0]), camel(command.slice(1).join('-'))];
    return { op, command, group, name };
  }).sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

/** What keeps the client from being written: two operations with one method, a method that is also a group, one that
 *  takes a name the runtime writes by hand. */
export function clientProblems(ops, map, commandOf) {
  const problems = [];
  const seen = new Map();
  const methods = methodsOf(ops, map, commandOf);
  const groups = new Set(methods.filter((m) => m.group).map((m) => m.group));
  for (const { op, group, name } of methods) {
    const at = group ? `${group}.${name}` : name;
    if (seen.has(at)) problems.push(`${seen.get(at)} and ${op.operationId} are both client.${at}`);
    seen.set(at, op.operationId);
    if (!group && (groups.has(name) || OWN.includes(name))) problems.push(`${op.operationId} is client.${name}, which the client already has`);
    if (group && HAND[group]?.includes(name)) problems.push(`${op.operationId} is client.${at}, a method the client writes by hand`);
    if (group && OWN.includes(group)) problems.push(`${op.operationId}'s group ${group} is a name the client already has`);
  }
  for (const group of Object.keys(HAND)) if (!groups.has(group)) problems.push(`the client writes ${HAND[group].map((n) => `${group}.${n}`).join(' and ')} by hand, and no operation is in the group ${group}`);
  return problems;
}

/** The generated file. */
export function clientText(ops, map, commandOf, hash) {
  const types = typesOf();
  const decls = [];
  const table = [];
  const groups = new Map();
  for (const { op, group, name } of methodsOf(ops, map, commandOf)) {
    const id = op.operationId;
    const P = pascal(id);
    const route = `${op.method} ${op.path}`;
    const pathParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const query = op.parameters.filter((p) => p.in === 'query');
    const headers = op.parameters.filter((p) => p.in === 'header' && !OWN_HEADERS.includes(p.name.toLowerCase()));
    const secret = map.secretBody.includes(id);
    const answer = answerOf(op);
    const rawBody = (op.body?.types ?? []).some((type) => !JSON_TYPE.test(type));
    const lines = [`/** ${doc(op.summary)} (${route}).${secret ? ' Its body\'s string values are secrets: each copy is cut from the answer, and a refusal keeps only its code.' : ''} */`];
    if (op.body?.type) lines.push(`export type ${P}Body = ${types.ts(op.body.type)};`);
    const params = [...query, ...headers];
    if (params.length) {
      const field = (p) => {
        const type = p.in === 'header' ? 'string' : p.enum ? p.enum.map((v) => JSON.stringify(v)).join(' | ') : types.ts({ type: p.type });
        return `  ${key(p.name)}${p.required ? '' : '?'}: ${type};`;
      };
      lines.push(`export interface ${P}Params {\n${params.map(field).join('\n')}\n}`);
    }
    const json = op.answer !== null ? `${P}Response` : undefined;
    // An answer that carries an ETag comes back with it, for the If-Match of a later write.
    const tagged = op.answerHeaders.some((name) => name.toLowerCase() === 'etag');
    if (json) lines.push(`export type ${P}Response = ${types.ts(op.answer)};`);
    decls.push(lines.join('\n'));

    const args = pathParams.map((p) => ({ name: argName(p), type: 'string', required: true }));
    if (op.body) args.push({ name: 'body', type: [op.body.type ? `${P}Body` : null, rawBody ? 'RawBody' : null].filter(Boolean).join(' | '), required: op.body.required });
    if (params.length) args.push({ name: 'params', type: `${P}Params`, required: params.some((p) => p.required) });
    const download = answer === 'bytes';
    args.push({ name: 'options', type: download ? 'DownloadOptions<S>' : rawBody ? 'BodyOptions' : 'RequestOptions', required: false });
    // An optional argument before a required one is required, `undefined` allowed.
    const lastRequired = args.findLastIndex((a) => a.required);
    const signature = args.map((a, i) => (a.required ? `${a.name}: ${a.type}` : i < lastRequired ? `${a.name}: ${a.type} | undefined` : `${a.name}?: ${a.type}`)).join(', ');
    const plain = { none: 'void', json, text: 'string', bytes: 'S extends true ? Response : Uint8Array', 'json+text': `${json} | string`, 'json+bytes': `${json} | Uint8Array`, 'text+bytes': 'string | Uint8Array', 'json+text+bytes': `${json} | string | Uint8Array` }[answer];
    const result = tagged && !download ? `Tagged<${plain}>` : plain;
    const argOf = (n) => (args.some((a) => a.name === n) ? n : 'undefined');
    const method = [
      `      /** ${doc(op.summary)} (${route}). */`,
      `      ${key(name)}: ${download ? '<S extends boolean = false>' : ''}(${signature}): Promise<${result}> => call(${JSON.stringify(id)}, [${pathParams.map(argName).join(', ')}], ${argOf('body')}, ${argOf('params')}, options),`,
    ].join('\n');
    // A browser-only operation (x-agentrun-browser-only) gets no method; it stays in the table, so a raw call's body bound
    // for it, a secret route, is still cut.
    if (!op.browserOnly) groups.set(group, [...(groups.get(group) ?? []), method]);
    table.push(`  ${id}: ${JSON.stringify({
      method: op.method, path: op.path, pathParams,
      multiSegment: map.multiSegment[id] ? [map.multiSegment[id]] : [],
      query: query.map((p) => p.name), headers: headers.map((p) => p.name),
      body: op.body ? { required: op.body.required, types: op.body.types } : null,
      answer, secret, publicFields: secret ? map.publicFields[id] ?? [] : [], tagged: tagged && !download,
    })},`);
  }
  if (types.problems.length) throw new Error(types.problems.join('\n'));
  const members = [...groups].flatMap(([group, methods]) => (group === null ? methods.map((m) => m.replace(/^ {6}/gm, '    ')) : [`    ${key(group)}: {\n${methods.join('\n')}\n    },`]));
  return [
    '// Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `// SHA-256 of what the clients are made of (operationsOf in scripts/generate-clients.mjs): ${hash}`,
    'import type { BodyOptions, Call, DownloadOptions, Operation, RawBody, RequestOptions, Tagged } from "./types.js";',
    '',
    ...[...types.named].map(([name, { text }]) => `export type ${name} = ${text};\n`),
    ...decls.map((text) => `${text}\n`),
    '/** Each operation as the runtime sends it, by operationId. */',
    `export const OPERATIONS: Readonly<Record<string, Operation>> = {\n${table.join('\n')}\n};`,
    '',
    '/** The resource groups, each operation a method that sends it through `call`. */',
    'export function resources(call: Call) {',
    `  return {\n${members.join('\n')}\n  };`,
    '}',
    '',
    'export type Resources = ReturnType<typeof resources>;',
    '',
  ].join('\n');
}
