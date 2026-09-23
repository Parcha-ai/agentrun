import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorWorkflow, createPiRunner, PiRunError } from '../dist/index.js';

const request = { kind: 'agent', label: 'test', system: ['Host instructions'], user: 'Return a count', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } };
function scripted(script, extra = {}) {
  const seen = { sessions: 0, prompts: [], results: [], disposed: false, options: undefined, turns: 0 };
  const options = {
    model: {}, modelRuntime: {}, maxTurns: 5, timeoutMs: 1000,
    sessionFactory: async config => {
      seen.sessions++;
      seen.options = config;
      let listener = () => {}, aborted = false;
      const submit = config.customTools.find(t => t.name === 'submit');
      const session = {
        subscribe(fn) { listener = fn; return () => {}; },
        async abort() { aborted = true; },
        dispose() { seen.disposed = true; },
        async prompt(text) {
          seen.prompts.push(text);
          while (!aborted && seen.turns < script.length) {
            const item = script[seen.turns++];
            listener({ type: 'turn_start' });
            if (typeof item === 'function') await item({ session, config, seen });
            else if (item !== undefined) seen.results.push(await submit.execute('test', { value: item }, undefined, undefined, {}));
            listener({ type: 'turn_end' });
            if (item === undefined) break;
          }
        },
      };
      return { session };
    }, ...extra,
  };
  return { options, seen };
}
test('schema and semantic repairs happen in one session; host tools/context are isolated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-pi-'));
  try {
    await writeFile(join(dir, 'AGENTS.md'), 'AMBIENT INSTRUCTION MUST NOT LOAD');
    const { options, seen } = scripted([{ count: 'bad' }, { count: 1 }, { count: 2 }], { cwd: dir });
    const reviewed = [];
    const value = await createPiRunner(options)({ ...request, review: async v => { reviewed.push(v); return v.count > 1 ? { accepted: true } : { accepted: false, message: 'Count must exceed one' }; } });
    assert.deepEqual(value, { count: 2 });
    assert.equal(seen.sessions, 1);
    assert.equal(seen.results.length, 3);
    assert.match(seen.results[1].content[0].text, /Count must exceed one/);
    assert.equal(reviewed.length, 2);
    assert.equal(seen.disposed, true);
    assert.deepEqual(seen.options.tools, ['submit']);
    assert.deepEqual(seen.options.resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(seen.options.resourceLoader.getSkills().skills, []);
    assert.deepEqual(seen.options.resourceLoader.getExtensions().extensions, []);
    assert.doesNotMatch(seen.options.resourceLoader.getSystemPrompt(), /AMBIENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('submission supports primitive schemas through the value envelope', async () => {
  const { options } = scripted([true]);
  assert.equal(await createPiRunner(options)({ ...request, schema: { type: 'boolean' } }), true);
});
test('host verification exceptions stop immediately and preserve original failure', async () => {
  const error = new Error('Verifier exhausted');
  const { options, seen } = scripted([{ count: 1 }, { count: 2 }]);
  await assert.rejects(createPiRunner(options)({ ...request, review: async () => { throw error; } }), value => value === error);
  assert.equal(seen.turns, 1);
  assert.equal(seen.disposed, true);
});
test('turn and submission limits reject instead of returning a draft', async () => {
  let run = scripted([undefined, undefined, undefined], { maxTurns: 2 });
  await assert.rejects(createPiRunner(run.options)(request), e => e instanceof PiRunError && e.reason === 'turn_limit');
  assert.equal(run.seen.turns, 2);
  run = scripted([{ count: 'bad' }, { count: 'bad' }, { count: 2 }], { maxSubmissions: 2 });
  await assert.rejects(createPiRunner(run.options)(request), e => e.reason === 'submission_limit');
  assert.equal(run.seen.turns, 2);
});
test('explicit null removes turn, submission and timeout limits without fake finite ceilings', async () => {
  const run = scripted([...Array(12).fill(undefined), ...Array.from({ length: 7 }, () => ({ count: 'invalid' })), { count: 2 }],
    { maxTurns: null, maxSubmissions: null, timeoutMs: null });
  assert.deepEqual(await createPiRunner(run.options)(request), { count: 2 });
  assert.equal(run.seen.turns, 20);
  assert.equal(run.seen.options.maxTurns, undefined, 'native session has no internal turn ceiling');
  assert.equal(run.seen.disposed, true);
});
test('unlimited runner still obeys operator cancellation during an uncooperative session', async () => {
  const controller = new AbortController();
  let disposed = false;
  const options = { model: {}, maxTurns: null, maxSubmissions: null, timeoutMs: null, signal: controller.signal,
    sessionFactory: async () => ({ session: {
      subscribe: () => () => {}, prompt: () => { controller.abort(); return new Promise(() => {}); },
      abort: async () => {}, dispose: () => { disposed = true; },
    } }),
  };
  await assert.rejects(createPiRunner(options)(request), error => error.reason === 'aborted');
  assert.equal(disposed, true);
});
test('abort before session creation prevents any model work; mid-session abort disposes', async () => {
  const controller = new AbortController();
  controller.abort();
  const early = scripted([{ count: 2 }]);
  await assert.rejects(createPiRunner(early.options)({ ...request, signal: controller.signal }), e => e.reason === 'aborted');
  assert.equal(early.seen.sessions, 0);
  const active = new AbortController();
  const run = scripted([async () => active.abort(), { count: 2 }]);
  await assert.rejects(createPiRunner(run.options)({ ...request, signal: active.signal }), e => e.reason === 'aborted');
  assert.equal(run.seen.turns, 1);
  assert.equal(run.seen.disposed, true);
});
test('unregistered tool requests fail before a session starts', async () => {
  const run = scripted([]);
  await assert.rejects(createPiRunner(run.options)({ ...request, tools: ['bash'] }), /not explicitly registered/);
  assert.equal(run.seen.sessions, 0);
});
test('production adapter rejects a structural runtime stub before any SDK work', () => {
  assert.throws(() => createPiRunner({ model: {}, modelRuntime: { getModel() {}, getAvailableSnapshot() { return []; } } }), /ModelRuntime instance/);
});
test('timeout bounds a hanging session factory and cleans up a late session', async () => {
  let finish;
  let disposed = false;
  const options = { model: {}, modelRuntime: {}, timeoutMs: 15, sessionFactory: () => new Promise(resolve => { finish = resolve; }) };
  await assert.rejects(createPiRunner(options)(request), error => error.reason === 'timeout');
  finish({ session: { abort: () => new Promise(() => {}), dispose() { disposed = true; } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
});
test('timeout bounds an uncooperative prompt and abort cleanup', async () => {
  let disposed = false;
  const options = { model: {}, modelRuntime: {}, timeoutMs: 15, sessionFactory: async () => ({ session: {
    subscribe: () => () => {}, prompt: () => new Promise(() => {}), abort: () => new Promise(() => {}), dispose() { disposed = true; },
  } }) };
  await assert.rejects(createPiRunner(options)(request), error => error.reason === 'timeout');
  assert.equal(disposed, true);
});
test('timeout bounds a hanging host verifier', async () => {
  const run = scripted([{ count: 2 }], { timeoutMs: 15 });
  await assert.rejects(createPiRunner(run.options)({ ...request, review: () => new Promise(() => {}) }), error => error.reason === 'timeout');
  assert.equal(run.seen.disposed, true);
});

const workflow = { v: 2, name: 'summary', schemas: { Result: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } }, output: { schemaId: 'Result', path: 'result' }, root: { node: 'extract', label: 'extract', instructions: 'Extract the count from the text field in the JSON input.', requires: ['text'], out: 'Result', as: 'result' } };
test('author retains rejected and accepted versions and protects host acceptance callback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-'));
  try {
    const invalid = { ...workflow, output: { schemaId: 'Missing' } };
    const run = scripted([invalid, workflow]);
    let checked = 0;
    const authored = await authorWorkflow({ request: 'Extract a count', outputDir: dir, pi: run.options, inputKeys: ['text'], acceptance: candidate => { checked++; candidate.name = 'mutated'; return []; } });
    assert.equal(authored.candidates, 2);
    assert.equal(authored.workflow.name, 'summary');
    assert.equal(authored.checks, 'structural-and-host');
    assert.equal(checked, 1);
    assert.equal(JSON.parse(await readFile(join(authored.directory, '001.review.json'))).accepted, false);
    assert.equal(JSON.parse(await readFile(join(authored.directory, '002.review.json'))).accepted, true);
    assert.deepEqual(JSON.parse(await readFile(authored.path)), workflow);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('author refuses generated executable nodes before validation and retains failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-'));
  try {
    const executable = { ...workflow, root: { node: 'code', label: 'unsafe', code: '() => ({})' } };
    const run = scripted([executable]);
    await assert.rejects(authorWorkflow({ request: 'Do work', outputDir: dir, pi: run.options, maxCandidates: 1 }), e => e.reason === 'submission_limit');
    const [folder] = await readdir(dir);
    const review = JSON.parse(await readFile(join(dir, folder, '001.review.json')));
    assert.match(review.errors.join(), /allowExecutableCandidates/);
    assert.equal(JSON.parse(await readFile(join(dir, folder, 'result.json'))).status, 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('author preserves every supplied rubric section on judgments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-'));
  try {
    const missing = { ...workflow, root: { ...workflow.root, node: 'decide', sopSection: ['Ratings'] } };
    const fixed = { ...missing, root: { ...missing.root, sopSection: ['Ratings', 'Blockers'] } };
    const run = scripted([missing, fixed]);
    const authored = await authorWorkflow({ request: 'Judge counts', outputDir: dir, pi: run.options, inputKeys: ['text'], rubricSections: { Ratings: 'Full rating rubric.', Blockers: 'Full blocking rubric.' } });
    assert.equal(authored.candidates, 2);
    assert.match(run.seen.results[0].content[0].text, /Blockers/);
    assert.match(run.seen.options.resourceLoader.getSystemPrompt(), /Full blocking rubric/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('author rejects hidden semantic judgments without a reviewed rubric contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-'));
  try {
    for (const root of [
      { node: 'escalate', label: 'check', when: { predicate: 'ask', instructions: 'Accept?' }, kind: 'review', stage: 'check', summary: 'Review' },
      { ...workflow.root, sopSection: ['Policy'], verify: { out: 'Result' } },
    ]) {
      const run = scripted([{ ...workflow, root }]);
      await assert.rejects(authorWorkflow({ request: 'Apply policy', outputDir: dir, pi: run.options, maxCandidates: 1, rubricSections: { Policy: 'Original complete rubric.' } }), error => error.reason === 'submission_limit');
      assert.match(run.seen.results[0].content[0].text, /separately reviewed question contract/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('author refuses inherited schema names and malformed fields before host acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-shape-'));
  try {
    const absent = { ...workflow, schemas: {}, root: { ...workflow.root, out: 'constructor' }, output: { schemaId: 'constructor' } };
    const malformed = { ...workflow, root: { ...workflow.root, sopSection: 42 } };
    const run = scripted([absent, malformed, workflow]);
    let hostChecks = 0;
    const authored = await authorWorkflow({ request: 'Extract a count', outputDir: dir, pi: run.options, inputKeys: ['text'], acceptance: () => { hostChecks++; return []; } });
    assert.equal(authored.candidates, 3);
    assert.equal(hostChecks, 1);
    for (const number of ['001', '002']) {
      const review = JSON.parse(await readFile(join(authored.directory, `${number}.review.json`)));
      assert.equal(review.accepted, false);
      assert.ok(review.errors.length);
    }
    assert.equal(JSON.parse(await readFile(join(authored.directory, '003.review.json'))).accepted, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('author treats schema keywords and examples as data, including in child workflows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-data-'));
  try {
    const safe = structuredClone(workflow);
    safe.root.sopSection = ['Policy'];
    safe.schemas.Input = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    safe.input = { schemaId: 'Input' };
    safe.schemas.Result.properties.verify = { type: 'boolean' };
    safe.schemas.Result.properties.node = { type: 'string', examples: ['code'] };
    safe.schemas.Result.examples = [{ count: 3, node: 'code', verify: {}, predicate: 'ask' }];
    const parent = {
      ...safe,
      root: { node: 'workflow', label: 'child', workflow: safe, input: { text: '{text}' }, out: 'Result', as: 'result' },
    };
    for (const candidate of [safe, parent]) {
      const run = scripted([candidate]);
      const authored = await authorWorkflow({ request: 'Extract counts', outputDir: dir, pi: run.options, inputKeys: ['text'], rubricSections: { Policy: 'Keep the original count.' } });
      assert.equal(authored.candidates, 1);
      assert.equal(JSON.parse(await readFile(join(authored.directory, '001.review.json'))).accepted, true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('author follows every graph edge and rejects actual executable children before probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-graph-'));
  try {
    globalThis.__authorPolicyProbe = 0;
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
      const run = scripted([{ ...workflow, root }]);
      await assert.rejects(authorWorkflow({ request: 'Do work', outputDir: dir, pi: run.options, maxCandidates: 1 }), error => error.reason === 'submission_limit');
      assert.match(run.seen.results[0].content[0].text, /code requires allowExecutableCandidates/);
      assert.equal(globalThis.__authorPolicyProbe, 0, `${root.node} must be rejected before evaluating code`);
    }
  } finally { delete globalThis.__authorPolicyProbe; await rm(dir, { recursive: true, force: true }); }
});

test('child workflow semantic predicates and incomplete rubric remain subject to author policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-author-child-policy-'));
  try {
    const childRoots = [
      { ...workflow.root, sopSection: [] },
      { node: 'escalate', label: 'check', when: { predicate: 'ask', instructions: 'Accept?' }, kind: 'review', stage: 'check', summary: 'Review' },
      { node: 'judge', label: 'judge', state: {}, out: 'Result', as: 'result' },
    ];
    const messages = [/must include rubric section Policy/, /separately reviewed question contract/, /cannot carry supplied SOP sections/];
    for (const [i, root] of childRoots.entries()) {
      const candidate = { ...workflow, root: { node: 'workflow', label: 'child', workflow: { ...workflow, root }, input: { text: '{text}' }, out: 'Result', as: 'result' } };
      const run = scripted([candidate]);
      await assert.rejects(authorWorkflow({ request: 'Apply policy', outputDir: dir, pi: run.options, maxCandidates: 1, inputKeys: ['text'], rubricSections: { Policy: 'Original full rubric.' } }), error => error.reason === 'submission_limit');
      assert.match(run.seen.results[0].content[0].text, messages[i]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('LLM instruction braces remain literal and the runner receives state as JSON', async () => {
  const { runWorkflow } = await import('@parcha/agentrun-dsl');
  const run = scripted([{ count: 3 }]);
  const literal = { ...workflow, root: { ...workflow.root, instructions: 'Read text from JSON. These braces are literal: {text}.' } };
  const result = await runWorkflow(literal, { text: 'There are 3 apples.' }, { runNode: createPiRunner(run.options) });
  assert.equal(result.status, 'complete');
  assert.match(run.seen.options.resourceLoader.getSystemPrompt(), /These braces are literal: \{text\}\./);
  assert.deepEqual(JSON.parse(run.seen.prompts[0]), { text: 'There are 3 apples.' });
});
