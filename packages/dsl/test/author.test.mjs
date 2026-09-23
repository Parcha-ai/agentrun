import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorContract, authorWorkflow, renderAuthorHostAddendum, candidatePolicyErrors, validateWorkflow, applyHostOutputTypes, runWorkflow,
  authorSkillDirectory, loadAuthorReference, loadAuthorSkillBundle, AUTHOR_SKILL_NAME,
  WORKFLOW_NODE_KINDS, NODE_FIELDS, IGNORED_NODE_FIELDS, WORKFLOW_PREDICATES, MECHANICAL_PREDICATES, PREDICATE_FIELDS,
  EFFORT_LEVELS, THINKING_LEVELS, MODEL_TIERS, CALL_TRANSPORTS, CALL_RETRY_CLASSES,
} from '../dist/index.js';

const host = {
  name: 'Example records host',
  initialState: { question: 'the case request text', context: 'reference files by name' },
  outputTypes: { case_report: { kind: 'prose', description: 'the reviewer-facing report' }, slide_deck: { kind: 'file', description: 'a presentation file' } },
  nodeKinds: ['chain', 'extract', 'decide', 'agent', 'escalate', 'artifact'],
  rules: ['Cite the reference file a decision relies on.'],
};

/** A scripted author session: submits each candidate through the review hook in order. */
function scriptedAuthor(candidates) {
  const seen = { requests: [], messages: [] };
  const runNode = async request => {
    seen.requests.push(request);
    for (const candidate of candidates) {
      const verdict = await request.review(structuredClone(candidate));
      if (verdict.accepted) return candidate;
      seen.messages.push(verdict.message);
    }
    throw new Error('the scripted author ran out of candidates');
  };
  return { runNode, seen };
}

const Result = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false };
const workflow = { v: 2, name: 'summary', schemas: { Result }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'extract', label: 'extract', instructions: 'Extract the count from the text field in the JSON input.', requires: ['text'], out: 'Result', as: 'result' } };
const withTemp = async (prefix, body) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('the contract renders the host addendum only when a host supplies one', () => {
  const plain = authorContract();
  const hosted = authorContract({ host });
  assert.ok(hosted.startsWith(plain), 'the host addendum follows the unchanged language');
  const addendum = renderAuthorHostAddendum(host);
  assert.equal(hosted, `${plain}\n\n${addendum}`);
  for (const vocabulary of ['Example records host', 'case_report', 'slide_deck', 'the case request text', 'Cite the reference file']) {
    assert.ok(hosted.includes(vocabulary), vocabulary);
    assert.ok(!plain.includes(vocabulary), `${vocabulary} must not appear without the host`);
  }
  assert.equal(renderAuthorHostAddendum(undefined), '');
  assert.match(addendum, /runs only these node kinds: `chain`, `extract`, `decide`, `agent`, `escalate`, `artifact`/);
});

test('the contract names every node kind, field and predicate the validator admits, and nothing it ignores', () => {
  const contract = authorContract();
  for (const kind of WORKFLOW_NODE_KINDS) {
    const line = contract.split('\n').find(entry => entry.startsWith(`- \`${kind}\`: `));
    assert.ok(line, `node kind ${kind} has a field line`);
    for (const field of NODE_FIELDS[kind].filter(name => name !== 'node')) assert.ok(line.includes(`\`${field}\``), `${kind}.${field}`);
    for (const ignored of IGNORED_NODE_FIELDS[kind] ?? []) assert.ok(!contract.includes(`\`${ignored}\``), `ignored field ${kind}.${ignored} is never taught`);
  }
  for (const name of WORKFLOW_PREDICATES) {
    assert.ok(contract.includes(`- \`${name}\` {${PREDICATE_FIELDS[name].join(', ')}}`), `predicate ${name}`);
  }
  for (const values of [EFFORT_LEVELS, THINKING_LEVELS, MODEL_TIERS, CALL_TRANSPORTS]) assert.ok(contract.includes(values.join('|')), values.join('|'));
  assert.ok(contract.includes(CALL_RETRY_CLASSES.join(', ')));
  assert.match(contract, new RegExp(`\`poll\` takes only the first ${MECHANICAL_PREDICATES.length}`));
});

test('the validator admits exactly the vocabulary the contract names', () => {
  const minimal = node => ({ v: 2, name: 'kinds', schemas: { Result }, output: { schemaId: 'Result' }, root: node });
  for (const kind of WORKFLOW_NODE_KINDS) {
    const verdict = validateWorkflow(minimal({ node: kind, label: kind }));
    const errors = verdict.ok ? [] : verdict.errors;
    assert.ok(!errors.some(error => /^root: unknown node kind/.test(error)), `${kind} is a known kind`);
    const child = kind === 'workflow' ? { workflow: { v: 2, name: 'child', schemas: {}, output: { schemaId: 'Result' }, root: { node: 'chain', steps: [] } } } : {};
    const extra = validateWorkflow(minimal({ node: kind, label: kind, ...child, unlisted: true }));
    assert.ok(!extra.ok && extra.errors.some(error => /unknown key\(s\).*unlisted/.test(error)), `${kind} refuses a field outside its list`);
  }
  const unknown = validateWorkflow(minimal({ node: 'branch', label: 'x' }));
  assert.ok(!unknown.ok && unknown.errors.some(error => /unknown node kind "branch"/.test(error)));
  const escalate = predicate => minimal({ node: 'chain', steps: [
    { node: 'escalate', label: 'stop', when: predicate, kind: 'k', stage: 's', summary: 'why' },
    { node: 'code', label: 'done', code: 's => ({ result: { count: 1 } })' },
  ] });
  for (const name of WORKFLOW_PREDICATES) {
    const verdict = validateWorkflow(escalate({ predicate: name, path: 'flag', key: 'flag', value: true, values: [true], n: 1, instructions: 'Is it?' }));
    assert.ok(verdict.ok || !verdict.errors.some(error => /unknown predicate/.test(error)), `${name} is a known predicate`);
  }
  const enumEquals = validateWorkflow(escalate({ predicate: 'enum_equals', path: 'flag', value: 'x' }));
  assert.ok(!enumEquals.ok && enumEquals.errors.some(error => /unknown predicate "enum_equals"/.test(error)));
});

// Each prescriptive sentence of the contract, the fragment that states it, and a candidate the checks refuse for it.
const extract = (extra = {}) => ({ node: 'extract', label: 'read', instructions: 'Read the count.', out: 'Result', as: 'result', ...extra });
const doc = (root, extra = {}) => ({ v: 2, name: 'rule', schemas: { Result, Q: { type: 'object', properties: { ok: { type: 'boolean', description: 'Is it supported?' } } } }, output: { schemaId: 'Result', path: 'result' }, root, ...extra });
const backed = [
  ['Every schema id a node, `input` or `output` names must exist there', doc(extract({ out: 'Missing' })), /not in workflow.schemas/],
  ['reference a catalog schema or an inline definition only as', doc(extract(), { schemas: { Result: { type: 'object', properties: { n: { $ref: 'Result' } } } } }), /unsupported \$ref form/],
  ['A node may read only input keys and keys an earlier node wrote', doc(extract({ requires: ['missing'] })), /no upstream node produces it/],
  ['must name an input key or a key an earlier node wrote', { ...doc(extract()), output: { schemaId: 'Result', path: 'elsewhere' } }, /output: path "elsewhere" has no input or upstream producer/],
  ['No `as` may begin with `$`', doc(extract({ as: '$host' })), /engine-owned/],
  ['neither may the label of an agent, decide, extract or code node without `as`', doc({ node: 'code', label: '$x', code: 's => ({ result: { count: 1 } })' }), /label must not begin with "\$"/],
  ['Every key a state map, call or child input interpolates must be produced upstream', doc(extract({ state: { t: '{nowhere}' } })), /interpolates \{nowhere\}/],
  ['Each kind accepts exactly these fields; any other field is an error', doc(extract({ colour: 'red' })), /unknown key\(s\) for a extract node: colour/],
  ['`instructions` (required, non-empty)', doc(extract({ instructions: ' ' })), /instructions required/],
  ['`thinking` is low|medium|high (never off)', doc(extract({ thinking: 'off' })), /thinking is never off/],
  ['`tier` is fast|default|strong', doc(extract({ tier: 'huge' })), /tier must be fast\|default\|strong/],
  ['`effort` is minimal|low|medium|high', doc(extract({ effort: 'max' })), /effort/],
  ['a question schema with at least one boolean question', doc(extract({ verify: { out: 'Result' } })), /question schema is|not a question|no yes\/no question|needs a description/],
  ['"maxDrives"?: 1..4', doc(extract({ verify: { out: 'Q', maxDrives: 9 } })), /maxDrives must be an integer 1..4/],
  ['no decide or extract `out` schema carries `report_markdown`', { ...doc({ node: 'chain', steps: [extract({ out: 'Draft' }), { node: 'report', label: 'report', instructions: 'Render the record.' }] }), schemas: { Result, Draft: { type: 'object', properties: { report_markdown: { type: 'string' } } } } }, /must not emit report_markdown/],
  ['A workflow has at most one terminal node', doc({ node: 'chain', steps: [extract(), { node: 'report', label: 'a', instructions: 'Render.' }, { node: 'report', label: 'b', instructions: 'Render.' }] }), /at most ONE terminal node/],
  ['it is the last step of the root chain', doc({ node: 'chain', steps: [{ node: 'report', label: 'a', instructions: 'Render.' }, extract()] }), /must be the LAST step/],
  ['No terminal node sits inside a map, loop, parallel branch, route branch or child workflow', doc({ node: 'loop', label: 'l', body: { node: 'report', label: 'r', instructions: 'Render.' }, until: { predicate: 'field_true', path: 'done' }, maxIters: 2 }), /cannot live inside a loop body/],
  ['`path` is the workspace-relative file an earlier shell call declared in `produces`', doc({ node: 'chain', steps: [extract(), { node: 'artifact', label: 'deck', type: 'pdf', path: 'out/deck.pdf' }] }), /not produced by any earlier shell call/],
  ['the node has no model fields', doc({ node: 'chain', steps: [extract(), { node: 'artifact', label: 'deck', type: 'pdf', path: 'deck.pdf', instructions: 'Render.' }] }), /prose-artifact field/],
  ['`judge`: a non-empty `state` map', doc({ node: 'judge', label: 'j', state: {}, out: 'Q', as: 'result' }), /state must be a non-empty object map/],
  ['never a choice', { ...doc({ node: 'sift', label: 's', itemsPath: 'items', out: 'C', as: 'result', keep: { path: 'pick' } }), schemas: { Result, C: { type: 'object', properties: { pick: { type: 'string', enum: ['a', 'b'], description: 'Which?' } } } } }, /is a choice/],
  ['2 to 240 named `branches`', doc({ node: 'route', label: 'r', state: { x: '{text}' }, instructions: 'Which?', branches: { only: { body: extract() } } }), /at least two named branches/],
  ['{branch: one of the branches, gte: a number in (0, 1]}', doc({ node: 'route', label: 'r', state: { x: '{text}' }, instructions: 'Which?', branches: { a: { body: extract() }, b: { body: extract() } }, unsure: { branch: 'c', gte: 2 } }), /unsure.branch must name one of the branches/],
  ['`maxConcurrency` is a positive integer', doc({ node: 'map', label: 'm', itemsPath: 'items', body: extract(), as: 'result', maxConcurrency: 0 }), /maxConcurrency must be a positive safe integer/],
  ['`itemsPath` (an upstream list)', doc({ node: 'map', label: 'm', itemsPath: 'nowhere', body: extract(), as: 'result' }), /itemsPath "nowhere" has no upstream producer/],
  ['Branches write disjoint keys', doc({ node: 'parallel', label: 'p', branches: [extract(), extract()] }), /parallel branches must write disjoint keys/],
  ['never read a sibling\'s writes', doc({ node: 'chain', steps: [{ node: 'parallel', label: 'p', branches: [extract({ as: 'first' }), extract({ as: 'second', requires: ['first'] })] }, extract()] }), /requires "first" but no upstream node produces it/],
  ['an integer `maxIters` from 1 to 20', doc({ node: 'loop', label: 'l', body: extract(), until: { predicate: 'field_true', path: 'result.count' }, maxIters: 50 }), /maxIters must be 1..20/],
  ['non-empty `kind`, `stage` and `summary`', doc({ node: 'escalate', label: 'e', when: { predicate: 'field_true', path: 'text' }, kind: '', stage: 's', summary: 'x' }), /kind, stage, summary required/],
  ['The child declares `input.schemaId` in its own schemas', doc({ node: 'workflow', label: 'c', workflow: { v: 2, name: 'child', schemas: { Result }, output: { schemaId: 'Result', path: 'result' }, root: extract() }, input: { text: '{text}' }, out: 'Result', as: 'result' }), /must declare input.schemaId/],
  ['contains no report or artifact', doc({ node: 'workflow', label: 'c', workflow: { v: 2, name: 'child', schemas: { Result, In: { type: 'object' } }, input: { schemaId: 'In' }, output: { schemaId: 'Result', path: 'result' }, root: { node: 'report', label: 'r', instructions: 'Render.' } }, input: {}, out: 'Result', as: 'result' }), /cannot render a report/],
  ['`code` is one synchronous function expression', doc({ node: 'code', label: 'c', code: 'return 1;' }), /code/],
  ['`deadline_s` (greater than 0, at most 3600) are required', doc({ node: 'call', label: 'c', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 0 }), /deadline_s must be greater than 0/],
  ['a body that returns its JSON result and uses only `tools` and `input`', doc({ node: 'call', label: 'c', via: 'executor', code: 'const x = require("fs"); return {};', out: 'Result', as: 'result', deadline_s: 5 }), /may use only tools and input/],
  ['UPPER_CASE names to strings', doc({ node: 'call', label: 'c', via: 'shell', command: 'true', env: { lower: 'x' }, as: 'result', deadline_s: 5 }), /env must map UPPER_CASE names/],
  ['Its result has the fixed shape {code, stdout, stderr, truncated?}: no `out`', doc({ node: 'call', label: 'c', via: 'shell', command: 'true', out: 'Result', as: 'result', deadline_s: 5 }), /drop out/],
  ['Only a shell call may declare `produces`', doc({ node: 'call', label: 'c', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 5, produces: ['a.txt'] }), /only a via shell call may declare produces/],
  ['{attempts: 1..5', doc({ node: 'call', label: 'c', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 5, retry: { attempts: 9 } }), /retry.attempts must be 1..5/],
  ['`where` accepts only "sandbox"', doc({ node: 'call', label: 'c', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 5, where: 'host' }), /where accepts only "sandbox"/],
  ['Both are mechanical predicates whose paths are relative to the result and lie in its declared shape', doc({ node: 'call', label: 'c', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 5, poll: { until: { predicate: 'field_true', path: 'status' }, interval_s: 1, deadline_s: 10 } }), /not in the declared result shape/],
  ['takes `key`, not `path`', doc({ node: 'chain', steps: [extract(), { node: 'escalate', label: 'e', when: { predicate: 'no_new_items', key: 'nowhere' }, kind: 'k', stage: 's', summary: 'x' }] }), /reads "nowhere" but no input key or earlier node produces/],
  ['Each path or key reads a state value an input or an earlier node produced', doc({ node: 'chain', steps: [extract(), { node: 'escalate', label: 'e', when: { predicate: 'field_true', path: 'nowhere.flag' }, kind: 'k', stage: 's', summary: 'x' }] }), /the guard can never fire/],
  ['in (0.5, 1], default 0.6', doc({ node: 'chain', steps: [extract(), { node: 'escalate', label: 'e', when: { predicate: 'ask', instructions: 'Stop?', gte: 0.5 }, kind: 'k', stage: 's', summary: 'x' }] }), /ask.gte must be in \(0.5, 1\]/],
];

test('every prescriptive contract sentence has a validator check that refuses its violation', () => {
  const contract = authorContract();
  for (const [sentence, candidate, error] of backed) {
    assert.ok(contract.includes(sentence), `the contract states: ${sentence}`);
    const verdict = validateWorkflow(candidate, { inputKeys: ['text', 'items'] });
    assert.equal(verdict.ok, false, `violating "${sentence}" must be refused`);
    assert.ok(verdict.errors.some(entry => error.test(entry)), `"${sentence}": ${verdict.errors.join(' | ')}`);
  }
});

const policy = [
  ['Code, call and artifact nodes need the host\'s explicit authorization', doc({ node: 'code', label: 'c', code: 's => s' }), {}, /code requires allowExecutableCandidates/],
  ['every generative node\'s `sopSection` lists all of them', doc(extract({ sopSection: 'A' })), { rubricSections: { A: 'a', B: 'b' } }, /must include rubric section B/],
  ['Judgment nodes, `ask` predicates and `verify` clauses are then refused', doc(extract({ sopSection: ['A'], verify: { out: 'Q' } })), { rubricSections: { A: 'a' } }, /separately reviewed question contract/],
  ['Author no other kind', doc({ node: 'map', label: 'm', itemsPath: 'items', body: extract(), as: 'result' }), { host }, /does not run map nodes/],
  ['A terminal artifact\'s `type` is one of', doc({ node: 'chain', steps: [extract(), { node: 'artifact', label: 'a', type: 'video', path: 'v.mp4' }] }), { host, allowExecutableCandidates: true }, /not one of this host's output types/],
];

test('every authority sentence has a candidate-policy check that refuses its violation', () => {
  const contract = authorContract({ host });
  for (const [sentence, candidate, options, error] of policy) {
    assert.ok(contract.includes(sentence), `the contract states: ${sentence}`);
    const errors = candidatePolicyErrors(candidate, options);
    assert.ok(errors.some(entry => error.test(entry)), `"${sentence}": ${errors.join(' | ')}`);
  }
});

test('the contract example is a workflow the validator accepts', () => {
  const example = JSON.parse(authorContract().split('## Example\n\n')[1].trim());
  assert.deepEqual(validateWorkflow(example, { inputKeys: ['text'] }), { ok: true });
});

test('the packaged skill ships the generated language reference beside its guides', async () => {
  const language = loadAuthorReference('language');
  assert.ok(language.includes(authorContract()), 'the skill reference is the SDK contract');
  const skill = await readFile(join(authorSkillDirectory(), 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${AUTHOR_SKILL_NAME}\\n`));
  assert.match(skill, /\]\(references\/language\.md\)/);
  const bundle = loadAuthorSkillBundle();
  for (const part of [language, loadAuthorReference('workflow-format'), loadAuthorReference('jev-decisions')]) assert.ok(bundle.includes(part));
  assert.doesNotMatch(bundle, /\/(?:home|Users)\/|127\.0\.0\.1/);
});

test('the author retains rejected and accepted versions and isolates host acceptance', () => withTemp('agentrun-author-', async dir => {
  const invalid = { ...workflow, output: { schemaId: 'Missing' } };
  const { runNode, seen } = scriptedAuthor([invalid, workflow]);
  let checked = 0;
  const authored = await authorWorkflow({ request: 'Extract a count', outputDir: dir, runNode, inputKeys: ['text'], acceptance: candidate => { checked++; candidate.name = 'mutated'; return []; } });
  assert.equal(authored.candidates, 2);
  assert.equal(authored.workflow.name, 'summary');
  assert.equal(authored.checks, 'structural-and-host');
  assert.equal(checked, 1);
  assert.equal(JSON.parse(await readFile(join(authored.directory, '001.review.json'))).accepted, false);
  assert.equal(JSON.parse(await readFile(join(authored.directory, '002.review.json'))).accepted, true);
  assert.deepEqual(JSON.parse(await readFile(authored.path)), workflow);
  const [request] = seen.requests;
  assert.deepEqual(request.tools, [], 'the author session has no tools');
  assert.equal(request.system[0], authorContract());
}));

test('the author returns the reviewed candidate, never a different value the adapter returns', () => withTemp('agentrun-author-', async dir => {
  const runNode = async request => {
    assert.deepEqual(await request.review(structuredClone(workflow)), { accepted: true });
    return { ...workflow, root: { node: 'code', label: 'swapped', code: 's => s' } };
  };
  const authored = await authorWorkflow({ request: 'Extract a count', outputDir: dir, runNode, inputKeys: ['text'] });
  assert.deepEqual(authored.workflow, workflow);
  assert.deepEqual(JSON.parse(await readFile(authored.path)), workflow);
}));

test('the author stops at its candidate limit and retains the failure', () => withTemp('agentrun-author-', async dir => {
  const executable = { ...workflow, root: { node: 'code', label: 'unsafe', code: '() => ({})' } };
  const { runNode, seen } = scriptedAuthor([executable, executable]);
  await assert.rejects(authorWorkflow({ request: 'Do work', outputDir: dir, runNode, maxCandidates: 1 }), /Candidate limit exceeded: 1/);
  assert.match(seen.messages[0], /allowExecutableCandidates/);
  const [folder] = await readdir(dir);
  assert.equal(JSON.parse(await readFile(join(dir, folder, 'result.json'))).status, 'failed');
}));

test('a host addendum reaches the session and its vocabulary is enforced', () => withTemp('agentrun-author-host-', async dir => {
  const judgment = { ...workflow, root: { node: 'map', label: 'each', itemsPath: 'question', body: extract(), as: 'result' } };
  const prose = { ...workflow, root: { node: 'chain', steps: [
    extract({ requires: ['question'] }),
    { node: 'artifact', label: 'report', type: 'case_report', instructions: 'Render the record as the report.', requires: ['result'] },
  ] } };
  const { runNode, seen } = scriptedAuthor([judgment, prose]);
  const authored = await authorWorkflow({ request: 'Report the count', outputDir: dir, runNode, host, allowExecutableCandidates: true });
  assert.equal(authored.candidates, 2);
  assert.match(seen.messages[0], /does not run map nodes/);
  assert.equal(seen.requests[0].system[0], authorContract({ host }));
  assert.match(seen.requests[0].user, /Available input keys: \["question","context"\]/);
  assert.deepEqual(JSON.parse(await readFile(authored.path)), prose, 'the host prose type is retained as written');
  const view = applyHostOutputTypes(authored.workflow, host);
  assert.equal(view.root.steps[1].type, 'report');
  const run = await runWorkflow(view, { question: 'There are 3 apples.', context: {} }, { runNode: async request => request.kind === 'report' ? { report_markdown: 'The count is three, stated in the request.' } : { count: 3 } });
  assert.equal(run.status, 'complete', 'the accepted candidate runs through the public interpreter in its host view');
}));

test('supplied rubric sections are authoritative on every generative node', () => withTemp('agentrun-author-', async dir => {
  const missing = { ...workflow, root: { ...workflow.root, node: 'decide', sopSection: ['Ratings'] } };
  const fixed = { ...missing, root: { ...missing.root, sopSection: ['Ratings', 'Blockers'] } };
  const { runNode, seen } = scriptedAuthor([missing, fixed]);
  const authored = await authorWorkflow({ request: 'Judge counts', outputDir: dir, runNode, inputKeys: ['text'], rubricSections: { Ratings: 'Full rating rubric.', Blockers: 'Full blocking rubric.' } });
  assert.equal(authored.candidates, 2);
  assert.match(seen.messages[0], /Blockers/);
  assert.match(seen.requests[0].system.join('\n'), /Full blocking rubric/);
}));

test('hidden semantic judgments are refused without a reviewed question contract', () => withTemp('agentrun-author-', async dir => {
  for (const root of [
    { node: 'escalate', label: 'check', when: { predicate: 'ask', instructions: 'Accept?' }, kind: 'review', stage: 'check', summary: 'Review' },
    { ...workflow.root, sopSection: ['Policy'], verify: { out: 'Result' } },
  ]) {
    const { runNode, seen } = scriptedAuthor([{ ...workflow, root }]);
    await assert.rejects(authorWorkflow({ request: 'Apply policy', outputDir: dir, runNode, maxCandidates: 1, rubricSections: { Policy: 'Original complete rubric.' } }), /ran out of candidates/);
    assert.match(seen.messages[0], /separately reviewed question contract/);
  }
}));

test('inherited schema names and malformed fields are refused before host acceptance', () => withTemp('agentrun-author-shape-', async dir => {
  const absent = { ...workflow, schemas: {}, root: { ...workflow.root, out: 'constructor' }, output: { schemaId: 'constructor' } };
  const malformed = { ...workflow, root: { ...workflow.root, sopSection: 42 } };
  const { runNode } = scriptedAuthor([absent, malformed, workflow]);
  let hostChecks = 0;
  const authored = await authorWorkflow({ request: 'Extract a count', outputDir: dir, runNode, inputKeys: ['text'], acceptance: () => { hostChecks++; return []; } });
  assert.equal(authored.candidates, 3);
  assert.equal(hostChecks, 1);
  for (const number of ['001', '002']) {
    const review = JSON.parse(await readFile(join(authored.directory, `${number}.review.json`)));
    assert.equal(review.accepted, false);
    assert.ok(review.errors.length);
  }
}));

test('schema keywords and examples are data, including in child workflows', () => withTemp('agentrun-author-data-', async dir => {
  const safe = structuredClone(workflow);
  safe.root.sopSection = ['Policy'];
  safe.schemas.Input = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  safe.input = { schemaId: 'Input' };
  safe.schemas.Result.properties.verify = { type: 'boolean' };
  safe.schemas.Result.properties.node = { type: 'string', examples: ['code'] };
  safe.schemas.Result.examples = [{ count: 3, node: 'code', verify: {}, predicate: 'ask' }];
  const parent = { ...safe, root: { node: 'workflow', label: 'child', workflow: safe, input: { text: '{text}' }, out: 'Result', as: 'result' } };
  for (const candidate of [safe, parent]) {
    const { runNode } = scriptedAuthor([candidate]);
    const authored = await authorWorkflow({ request: 'Extract counts', outputDir: dir, runNode, inputKeys: ['text'], rubricSections: { Policy: 'Keep the original count.' } });
    assert.equal(authored.candidates, 1);
  }
}));

test('executable nodes are refused on every graph edge before any code is evaluated', () => withTemp('agentrun-author-graph-', async dir => {
  globalThis.__authorPolicyProbe = 0;
  try {
    const unsafe = { node: 'code', label: 'unsafe', code: '((function(){}).constructor("globalThis.__authorPolicyProbe++")(), () => ({ result: { count: 1 } }))' };
    const roots = [
      { node: 'chain', steps: [unsafe] },
      { node: 'parallel', label: 'branches', branches: [unsafe] },
      { node: 'map', label: 'items', itemsPath: 'items', as: 'results', body: unsafe },
      { node: 'loop', label: 'retry', body: unsafe, until: { predicate: 'field_true', path: 'done' }, maxIters: 2 },
      { node: 'route', label: 'route', state: {}, instructions: 'Choose', branches: { chosen: { body: unsafe } } },
      { node: 'workflow', label: 'child', workflow: { ...workflow, root: unsafe }, input: {}, out: 'Result', as: 'result' },
    ];
    for (const root of roots) {
      const { runNode, seen } = scriptedAuthor([{ ...workflow, root }]);
      await assert.rejects(authorWorkflow({ request: 'Do work', outputDir: dir, runNode, maxCandidates: 1 }), /ran out of candidates/);
      assert.match(seen.messages[0], /code requires allowExecutableCandidates/);
      assert.equal(globalThis.__authorPolicyProbe, 0, `${root.node} must be refused before evaluating code`);
    }
  } finally { delete globalThis.__authorPolicyProbe; }
}));

test('child workflows stay subject to rubric and question-contract policy', () => withTemp('agentrun-author-child-policy-', async dir => {
  const childRoots = [
    { ...workflow.root, sopSection: [] },
    { node: 'escalate', label: 'check', when: { predicate: 'ask', instructions: 'Accept?' }, kind: 'review', stage: 'check', summary: 'Review' },
    { node: 'judge', label: 'judge', state: {}, out: 'Result', as: 'result' },
  ];
  const messages = [/must include rubric section Policy/, /separately reviewed question contract/, /cannot carry supplied SOP sections/];
  for (const [i, root] of childRoots.entries()) {
    const candidate = { ...workflow, root: { node: 'workflow', label: 'child', workflow: { ...workflow, root }, input: { text: '{text}' }, out: 'Result', as: 'result' } };
    const { runNode, seen } = scriptedAuthor([candidate]);
    await assert.rejects(authorWorkflow({ request: 'Apply policy', outputDir: dir, runNode, maxCandidates: 1, inputKeys: ['text'], rubricSections: { Policy: 'Original full rubric.' } }), /ran out of candidates/);
    assert.match(seen.messages[0], messages[i]);
  }
}));
