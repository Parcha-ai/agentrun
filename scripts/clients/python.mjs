// The Python client's operations (python/agentrun/_generated.py), from the projection generate-clients.mjs makes
// (operationsOf) and the same map (resources.json) as the TypeScript client, under the same hash: per operation it
// offers, its request and response types as TypedDicts, Literals and aliases, a method on its resource group named in
// snake_case (`client.runs.start(agent_id, body)`, `client.mcp_servers.save(name, body)`), and the table the
// hand-written runtime reads. An omitted operation, or one this server turns off, gets no method, as it gets no command.
// Python has no anonymous object type and no intersection, so an object type with no name of its own is named for where
// it sits (`CreateAgentBodyDefinition`), and an allOf of objects is one TypedDict holding every part's fields.
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;
// Headers the runtime sets itself, as the CLI does.
const OWN_HEADERS = ['authorization', 'content-type', 'accept'];
// The client's hand-written members: no generated method may take one of these names, and a group named here is built
// by the client (Resources leaves it out).
const HAND = { runs: ['wait', 'follow'] };
const OWN = ['base_url', 'timeout', 'max_retries'];
// A method's own keyword arguments: no query or header parameter may take one of these names.
const OWN_KWARGS = ['self', 'body', 'timeout', 'stream', 'body_type'];
const KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// What the generated module imports or defines itself: no type may take one of these names.
const TAKEN = new Set(['annotations', 'Any', 'Literal', 'TypeAlias', 'TypedDict', 'overload', 'Call', 'Group', 'Operation', 'OperationBody', 'RawBody', 'Tagged', 'StreamedResponse', 'Resources', 'OPERATIONS']);
// Names a type expression is made of. A TypedDict with a field of one of these names is written in the functional
// syntax, whose field types are read at module scope: in a class body the field would hide the name.
const TYPE_WORDS = new Set(['str', 'int', 'float', 'bool', 'list', 'dict', 'None', 'Any', 'Literal']);

const camel = (name) => name.replace(/[-_\s]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (name) => camel(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^./, (c) => c.toUpperCase());
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
/** A Python name for a command word or a parameter: snake_case, a keyword with `_` after it. */
const pyName = (name) => {
  const n = snake(name);
  return KEYWORDS.has(n) || !IDENT.test(n) ? `${n}_` : n;
};
const str = (value) => JSON.stringify(value);
const tuple = (values) => (values.length === 1 ? `(${str(values[0])},)` : `(${values.map(str).join(', ')})`);
const docstring = (text) => `"""${text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`;
const fieldOk = (name) => IDENT.test(name) && !KEYWORDS.has(name) && !TYPE_WORDS.has(name);

/** What the projection's media types say an operation answers: JSON, text, bytes, several of them or nothing. */
function answerOf(op) {
  const others = [...new Set(op.answers)].filter((type) => !JSON_TYPE.test(type) && type !== 'text/event-stream');
  const kinds = [...(op.answer !== null ? ['json'] : []), ...(others.some((t) => t.startsWith('text/')) ? ['text'] : []), ...(others.some((t) => !t.startsWith('text/')) ? ['bytes'] : [])];
  return kinds.length ? kinds.join('+') : 'none';
}

/** The emitter of named types. A component (marked with its name by typeOf in generate-clients.mjs) is written once, by
 *  that name; an object type with no name is written as a TypedDict named for where it sits. A name two different
 *  types would take is a problem, never a silent second meaning. */
function typesOf() {
  const named = new Map();
  const problems = [];
  const literal = (values) => {
    const plain = values.filter((v) => v !== null);
    for (const v of plain) if (!['string', 'boolean'].includes(typeof v) && !Number.isInteger(v)) problems.push(`a Literal cannot hold ${str(v)}`);
    const parts = plain.length ? [`Literal[${plain.map((v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : str(v))).join(', ')}]`] : [];
    if (values.includes(null)) parts.push('None');
    return parts.join(' | ');
  };
  const union = (parts) => [...new Set(parts.flatMap((part) => part.split(' | ')))].join(' | ');
  /** An allOf as one object: every part's fields and every part's required, the node's own included. */
  function merged(node) {
    const out = { type: 'object', properties: {}, required: [] };
    for (const part of [...node.allOf, { properties: node.properties, required: node.required }]) {
      const whole = part.allOf ? merged(part) : part;
      const types = Array.isArray(whole.type) ? whole.type : whole.type ? [whole.type] : [];
      if (whole.oneOf || whole.anyOf || whole.enum || whole.const !== undefined || types.some((t) => t !== 'object')) {
        problems.push(`an allOf of ${str(whole).slice(0, 80)}, which is not an object: Python has no intersection`);
        continue;
      }
      Object.assign(out.properties, whole.properties ?? {});
      out.required.push(...(whole.required ?? []));
    }
    out.required = [...new Set(out.required)];
    return out;
  }
  function register(name, source, define) {
    if (TAKEN.has(name) || name.startsWith('_')) problems.push(`the type ${name} takes a name the module keeps for itself`);
    const had = named.get(name);
    if (had === undefined) {
      named.set(name, { source, text: null });
      named.get(name).text = define();
    } else if (had.source !== source) problems.push(`two types are both ${name}`);
    return name;
  }
  /** A TypedDict named `name`, or the functional form when a field cannot be a class attribute. */
  function typedDict(name, node) {
    const required = new Set(node.required ?? []);
    const fields = Object.entries(node.properties).map(([key, value]) => ({ key, type: py(value, `${name}${pascal(key)}`), required: required.has(key) }));
    const needed = fields.filter((f) => f.required);
    const optional = fields.filter((f) => !f.required);
    const functional = fields.some((f) => !fieldOk(f.key));
    const body = (list) => list.map((f) => `    ${f.key}: ${f.type}`).join('\n');
    const dict = (list) => `{${list.map((f) => `${str(f.key)}: ${str(f.type)}`).join(', ')}}`;
    if (!functional) {
      if (!optional.length) return `class ${name}(TypedDict):\n${body(needed)}`;
      if (!needed.length) return `class ${name}(TypedDict, total=False):\n${body(optional)}`;
      return `class _${name}Required(TypedDict):\n${body(needed)}\n\n\nclass ${name}(_${name}Required, total=False):\n${body(optional)}`;
    }
    if (!optional.length) return `${name} = TypedDict(${str(name)}, ${dict(needed)})`;
    if (!needed.length) return `${name} = TypedDict(${str(name)}, ${dict(optional)}, total=False)`;
    return [
      `_${name}Required = TypedDict(${str(`_${name}Required`)}, ${dict(needed)})`,
      `_${name}Optional = TypedDict(${str(`_${name}Optional`)}, ${dict(optional)}, total=False)`,
      '',
      '',
      `class ${name}(_${name}Required, _${name}Optional):\n    pass`,
    ].join('\n');
  }
  /** A type named `name` at the top level: a TypedDict when it is an object with fields, else an alias. */
  function define(name, node) {
    const object = node.name !== undefined ? {} : node.allOf ? merged(node) : node;
    if (object.properties && Object.keys(object.properties).length && !object.oneOf && !object.anyOf) return typedDict(name, object);
    return `${name}: TypeAlias = ${str(py(node, `${name}Object`))}`;
  }
  function refer(node) {
    const { name, ...rest } = node;
    return register(pascal(name), JSON.stringify(rest), () => define(pascal(name), rest));
  }
  /** The Python type expression of a schema; `hint` names an object type that has no name of its own. */
  function py(node, hint) {
    if (node.name !== undefined) return refer(node);
    if (node.not) {
      problems.push(`${hint} is a type no value has (not): Python cannot write it`);
      return 'Any';
    }
    if (node.const !== undefined) return literal([node.const]);
    if (node.enum) return literal(node.enum);
    if (node.allOf) return register(hint, JSON.stringify(node), () => typedDict(hint, merged(node)));
    const parts = [];
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : node.properties || node.additionalProperties !== undefined ? ['object'] : node.items ? ['array'] : [];
    for (const type of types) {
      if (type === 'array') parts.push(`list[${node.items ? py(node.items, `${hint}Item`) : 'Any'}]`);
      else if (type === 'object') {
        if (node.properties && Object.keys(node.properties).length) parts.push(register(hint, JSON.stringify(node), () => typedDict(hint, node)));
        else parts.push(`dict[str, ${node.additionalProperties && typeof node.additionalProperties === 'object' ? py(node.additionalProperties, `${hint}Value`) : 'Any'}]`);
      } else parts.push({ string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'None' }[type] ?? 'Any');
    }
    const choices = node.oneOf ?? node.anyOf;
    if (choices) {
      if (parts.length) problems.push(`${hint} is both ${parts.join(' | ')} and one of its choices: Python has no intersection`);
      const anonymous = choices.filter((c) => c.name === undefined && (c.properties || c.allOf || c.oneOf || c.anyOf)).length;
      let n = 0;
      parts.push(...choices.map((choice) => py(choice, anonymous > 1 && choice.name === undefined && (choice.properties || choice.allOf || choice.oneOf || choice.anyOf) ? `${hint}${++n}` : hint)));
    }
    return parts.length ? union(parts) : 'Any';
  }
  return { py, define, register, named, problems };
}

/** Each offered operation's method: its group (none for a one-word command), its name, and what the runtime needs. */
function methodsOf(ops, map, commandOf) {
  return ops.filter((op) => !op.unsupported && map.omit[op.operationId] === undefined).map((op) => {
    const command = commandOf(op, map);
    const [group, name] = command.length === 1 ? [null, pyName(command[0])] : [pyName(command[0]), pyName(command.slice(1).join('-'))];
    const pathParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const params = op.parameters.filter((p) => p.in === 'query' || (p.in === 'header' && !OWN_HEADERS.includes(p.name.toLowerCase())));
    return { op, command, group, name, pathParams, params };
  }).sort((a, b) => a.command.join(' ').localeCompare(b.command.join(' ')));
}

/** What keeps the Python client from being written: two operations with one method, a method that is also a group, one
 *  that takes a name the client writes by hand, or an operation two of whose arguments take one Python name. */
export function pythonProblems(ops, map, commandOf) {
  const problems = [];
  const seen = new Map();
  const methods = methodsOf(ops, map, commandOf);
  const groups = new Set(methods.filter((m) => m.group).map((m) => m.group));
  for (const { op, group, name, pathParams, params } of methods) {
    const at = group ? `${group}.${name}` : name;
    if (seen.has(at)) problems.push(`${seen.get(at)} and ${op.operationId} are both client.${at} in Python`);
    seen.set(at, op.operationId);
    if (!group && (groups.has(name) || OWN.includes(name))) problems.push(`${op.operationId} is client.${name} in Python, which the client already has`);
    if (group && HAND[group]?.includes(name)) problems.push(`${op.operationId} is client.${at} in Python, a method the client writes by hand`);
    if (group && OWN.includes(group)) problems.push(`${op.operationId}'s group ${group} is a name the Python client already has`);
    const names = [...pathParams.map(pyName), ...params.map((p) => pyName(p.name))];
    const twice = names.filter((n, i) => names.indexOf(n) !== i || OWN_KWARGS.includes(n));
    if (twice.length) problems.push(`${op.operationId}'s arguments take the Python name ${[...new Set(twice)].join(', ')} twice, or one the method keeps`);
  }
  for (const group of Object.keys(HAND)) if (!groups.has(group)) problems.push(`the Python client writes ${HAND[group].map((n) => `${group}.${n}`).join(' and ')} by hand, and no operation is in the group ${group}`);
  return problems;
}

/** The generated module. */
export function pythonText(ops, map, commandOf, hash) {
  const types = typesOf();
  const table = [];
  const groups = new Map();
  for (const { op, group, name, pathParams, params } of methodsOf(ops, map, commandOf)) {
    const id = op.operationId;
    const P = pascal(id);
    const route = `${op.method} ${op.path}`;
    const query = op.parameters.filter((p) => p.in === 'query');
    const headers = op.parameters.filter((p) => p.in === 'header' && !OWN_HEADERS.includes(p.name.toLowerCase()));
    const secret = map.secretBody.includes(id);
    const answer = answerOf(op);
    const rawBody = (op.body?.types ?? []).some((type) => !JSON_TYPE.test(type));
    const tagged = op.answerHeaders.some((h) => h.toLowerCase() === 'etag');
    const download = answer === 'bytes';
    const body = op.body?.type ? types.register(`${P}Body`, `body ${id}`, () => types.define(`${P}Body`, op.body.type)) : undefined;
    const json = op.answer !== null ? types.register(`${P}Response`, `answer ${id}`, () => types.define(`${P}Response`, op.answer)) : undefined;

    const positional = pathParams.map((p) => `${pyName(p)}: str`);
    if (op.body) {
      const type = [body, rawBody ? 'RawBody' : null].filter(Boolean).join(' | ');
      positional.push(op.body.required ? `body: ${type}` : `body: ${type} | None = None`);
    }
    const kwarg = (p) => {
      const type = p.in === 'header' ? 'str' : p.enum ? types.py({ enum: p.enum }, '') : ({ string: 'str', integer: 'int', number: 'float', boolean: 'bool' })[p.type] ?? 'str';
      return `${pyName(p.name)}: ${type} | None = None`;
    };
    const keywords = [...params.map(kwarg), ...(rawBody ? ['body_type: str | None = None'] : [])];
    const plain = { none: 'None', json, text: 'str', bytes: 'bytes', 'json+text': `${json} | str`, 'json+bytes': `${json} | bytes`, 'text+bytes': 'str | bytes', 'json+text+bytes': `${json} | str | bytes` }[answer];
    const result = tagged && !download ? `Tagged[${plain}]` : plain;
    // Path parameters and the body by position; every other argument by name, so a call reads as the route it sends.
    const signature = (stream) => ['self', ...positional, '*', ...keywords, ...(stream ? [stream] : []), 'timeout: float | None = None'].join(', ');
    const call = [
      str(id),
      pathParams.length === 1 ? `(${pyName(pathParams[0])},)` : `(${pathParams.map(pyName).join(', ')})`,
      op.body ? 'body' : 'None',
      params.length ? `{${params.map((p) => `${str(p.name)}: ${pyName(p.name)}`).join(', ')}}` : 'None',
      'timeout=timeout',
      ...(download ? ['stream=stream'] : []),
      ...(rawBody ? ['body_type=body_type'] : []),
    ].join(', ');
    const doc = `${op.summary} (${route}).${secret ? ' Its body\'s string values are secrets: each copy is cut from the answer, and a refusal keeps only its code.' : ''}`;
    const lines = download ? [
      '@overload',
      `def ${name}(${signature('stream: Literal[False] = False')}) -> bytes: ...`,
      '@overload',
      `def ${name}(${signature('stream: Literal[True]')}) -> StreamedResponse: ...`,
      `def ${name}(${signature('stream: bool = False')}) -> bytes | StreamedResponse:`,
    ] : [`def ${name}(${signature()}) -> ${result}:`];
    const self = group === null ? 'self._operation' : 'self._call';
    const method = [...lines, `    ${docstring(doc)}`, `    return ${self}(${call})`];
    groups.set(group, [...(groups.get(group) ?? []), method]);
    table.push(`    ${str(id)}: Operation(method=${str(op.method)}, path=${str(op.path)}, path_params=${tuple(pathParams)}, multi_segment=${tuple(map.multiSegment[id] ? [map.multiSegment[id]] : [])}, query=${tuple(query.map((p) => p.name))}, headers=${tuple(headers.map((p) => p.name))}, body=${op.body ? `OperationBody(required=${op.body.required ? 'True' : 'False'}, types=${tuple(op.body.types)})` : 'None'}, answer=${str(answer)}, secret=${secret ? 'True' : 'False'}, public_fields=${tuple(secret ? map.publicFields[id] ?? [] : [])}, tagged=${tagged && !download ? 'True' : 'False'}),`);
  }
  if (types.problems.length) throw new Error(`generate-clients: the Python client's types: ${[...new Set(types.problems)].join('; ')}`);
  const indent = (lines, by) => lines.map((line) => (line ? `${by}${line}` : line)).join('\n');
  const classOf = (group) => `${pascal(group)}Resource`;
  const groupClasses = [...groups].filter(([group]) => group !== null).map(([group, methods]) => [
    `class ${classOf(group)}(Group):`,
    `    ${docstring(`client.${group}: ${HAND[group] ? `its generated methods (the client adds ${HAND[group].join(' and ')})` : 'one method per operation'}.`)}`,
    '',
    methods.map((m) => indent(m, '    ')).join('\n\n'),
  ].join('\n'));
  const built = [...groups.keys()].filter((group) => group !== null && !HAND[group]);
  const resources = [
    'class Resources:',
    `    ${docstring(`The resource groups, each operation a method that sends it through \`call\`. ${Object.keys(HAND).map((g) => `\`${g}\``).join(', ')} is the client's own: ${Object.keys(HAND).map(classOf).join(', ')} with the methods it writes by hand.`)}`,
    '',
    ...built.map((group) => `    ${group}: ${classOf(group)}`),
    '',
    '    def __init__(self, call: Call) -> None:',
    '        self._operation = call',
    ...built.map((group) => `        self.${group} = ${classOf(group)}(call)`),
    ...(groups.get(null) ?? []).flatMap((m) => ['', indent(m, '    ')]),
  ].join('\n');
  const typeNames = [...types.named.keys()];
  const exported = [...typeNames, ...[...groups.keys()].filter((g) => g !== null).map(classOf), 'Resources', 'OPERATIONS'].sort();
  return [
    '# Generated by scripts/generate-clients.mjs from the server\'s OpenAPI document. Do not edit: run node scripts/generate-clients.mjs.',
    `# SHA-256 of what the clients are made of (operationsOf in scripts/generate-clients.mjs): ${hash}`,
    'from __future__ import annotations',
    '',
    'from typing import Any, Literal, TypeAlias, TypedDict, overload',
    '',
    'from ._http import StreamedResponse',
    'from ._types import Call, Group, Operation, OperationBody, RawBody, Tagged',
    '',
    `__all__ = [\n${exported.map((n) => `    ${str(n)},`).join('\n')}\n]`,
    '',
    ...[...types.named.values()].flatMap(({ text }) => ['', text, '']),
    '',
    '# Each operation as the runtime sends it, by operationId.',
    `OPERATIONS: dict[str, Operation] = {\n${table.join('\n')}\n}`,
    '',
    ...groupClasses.flatMap((text) => ['', text, '']),
    '',
    resources,
    '',
  ].join('\n');
}
