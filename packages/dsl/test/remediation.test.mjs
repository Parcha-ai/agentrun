import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runWorkflow, validateWorkflow, synthesizeAnswers,
  WorkflowInputInvalidError, EscalationSignal, EffectOutcomeUnknownError,
} from '../dist/index.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const valueSchema = object({ value: { type: 'number' } });
const code = (label, source = 's => ({})') => ({ node: 'code', label, code: source });
const call = (label = 'effect') => ({ node: 'call', label, via: 'tool', tool: 'example:write', args: {}, out: 'Value', as: label, deadline_s: 30 });
const agent = (extra = {}) => ({ node: 'agent', label: 'answer', instructions: 'Return a value.', out: 'Value', as: 'answer', ...extra });
const stop = (path = 'stop') => ({ node: 'escalate', label: 'human-review', when: { predicate: 'field_true', path }, kind: 'human_review', stage: 'review', summary: 'A person must review this item.' });
const chain = (...steps) => ({ node: 'chain', steps });
const flow = (root, schemas = {}) => ({ v: 2, name: 'review-regression', schemas: { State: { type: 'object' }, Value: valueSchema, ...schemas }, output: { schemaId: 'State' }, root });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const scriptedJudge = async ({ questions }) => ({ answers: synthesizeAnswers(questions) });

test('SOP preflight rejects absent content or headings before an earlier effect, including untaken routes and children', async () => {
  const sectionAgent = agent({ sopSection: ['Policy', 'Criteria'] });
  const child = {
    ...flow(chain(agent({ ...sectionAgent, as: 'result' })), { Input: object({}) }),
    input: { schemaId: 'Input' }, output: { schemaId: 'Value', path: 'result' },
  };
  const candidates = [
    flow(chain(call(), sectionAgent)),
    flow(chain(call(), { node: 'route', label: 'route', state: { request: 'Review this request' }, instructions: 'Choose a path.', branches: {
      ordinary: { body: code('ordinary') },
      review: { body: sectionAgent },
    } })),
    flow(chain(call(), { node: 'workflow', label: 'child', workflow: child, input: {}, out: 'Value', as: 'child' })),
  ];
  for (const candidate of candidates) {
    assert.deepEqual(validateWorkflow(candidate), { ok: true });
    for (const sop of [undefined, '## Policy\nApply policy.\n']) {
      let effects = 0, models = 0, judges = 0;
      await assert.rejects(runWorkflow(candidate, {}, {
        sop,
        runEffect: async () => { effects++; return { value: 1 }; },
        runNode: async () => { models++; return { value: 1 }; },
        runJudge: async params => { judges++; return scriptedJudge(params); },
      }), /sopSection|SOP/);
      assert.deepEqual({ effects, models, judges }, { effects: 0, models: 0, judges: 0 });
    }
  }
  let effects = 0;
  const result = await runWorkflow(candidates[0], {}, {
    sop: '## Policy\nApply policy.\n## Criteria\nUse the criteria.\n',
    runEffect: async () => { effects++; return { value: 1 }; }, runNode: async () => ({ value: 1 }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(effects, 1);
});

test('declared missing input is input_invalid, and unknown node keys fail without an input-key hint', async () => {
  const candidate = { ...flow(agent({ state: { text: '{text}' } }), { Input: object({ text: { type: 'string' } }) }), input: { schemaId: 'Input' } };
  let calls = 0;
  await assert.rejects(runWorkflow(candidate, {}, { runNode: async () => { calls++; return { value: 1 }; } }), WorkflowInputInvalidError);
  assert.equal(calls, 0);
  const invalid = validateWorkflow(flow(agent({ accidentalOption: true })));
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /accidentalOption/);
});

test('a missing optional input required by a later node fails before earlier effects', async () => {
  const candidate = { ...flow(chain(call(), agent({ requires: ['context'] })), {
    Input: { type: 'object', properties: { context: { type: 'object' } }, additionalProperties: false },
  }), input: { schemaId: 'Input' } };
  assert.deepEqual(validateWorkflow(candidate), { ok: true });
  let effects = 0;
  await assert.rejects(runWorkflow(candidate, {}, {
    runEffect: async () => { effects++; return { value: 1 }; }, runNode: async () => ({ value: 1 }),
  }), /requires.*context|context.*upstream/);
  assert.equal(effects, 0);
});

test('root-ref input schemas validate without supplied input and accept valid concrete input', async () => {
  const candidate = { ...flow(agent({ state: { selected: '{text}' } }), {
    Input: { $ref: '#/definitions/InputFields' }, InputFields: object({ text: { type: 'string' } }),
  }), input: { schemaId: 'Input' } };
  assert.deepEqual(validateWorkflow(candidate), { ok: true });
  assert.deepEqual(validateWorkflow(candidate, { input: { text: 'hello' } }), { ok: true });
  const prompts = [];
  const result = await runWorkflow(candidate, { text: 'hello' }, { runNode: async request => { prompts.push(JSON.parse(request.user)); return { value: 1 }; } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(prompts, [{ selected: 'hello' }]);
  await assert.rejects(runWorkflow(candidate, {}, { runNode: async () => ({ value: 1 }) }), WorkflowInputInvalidError);
});

test('parallel escalation remains publicly identifiable beside a pending effect and its settlement', async () => {
  const admitted = deferred(), pending = deferred();
  const candidate = flow({ node: 'parallel', label: 'fan-out', branches: [
    chain(agent({ label: 'wait-for-effect' }), stop()), call('pending'),
  ] });
  let failure;
  await assert.rejects(runWorkflow(candidate, { stop: true }, {
    runNode: async () => { await admitted.promise; return { value: 1 }; },
    runEffect: async () => { admitted.resolve(); return pending.promise; },
  }), error => { failure = error; return error instanceof AggregateError; });
  const escalation = failure.errors.find(error => error instanceof EscalationSignal);
  const unknown = failure.errors.find(error => error instanceof EffectOutcomeUnknownError);
  assert.ok(escalation, 'public class recognizes the escalation');
  assert.equal(escalation.escalation.kind, 'human_review');
  assert.equal(failure.cause, escalation);
  assert.ok(unknown, 'the uncertain effect remains available for reconciliation');
  assert.equal(unknown.interruption, 'cancelled');
  pending.resolve({ value: 7 });
  assert.deepEqual(await unknown.settlement, { status: 'fulfilled', value: { value: 7 } });
});

test('a pure map escalation emits map.escalated without recording recovery failure', async () => {
  const events = [], failures = [];
  const candidate = flow({ node: 'map', label: 'items', itemsPath: 'items', as: 'results', body: stop('item.review') });
  const result = await runWorkflow(candidate, { items: [{ review: true }] }, {
    onEvent: event => events.push(event),
    recovery: {
      resume: async () => undefined, commit: async () => {}, pollStartedAt: () => 0, wait: async () => {},
      fail: async (...args) => { failures.push(args); },
    },
  });
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.state.item.review, true, 'the escalated item context remains available');
  assert.equal(events.filter(event => event.type === 'map.escalated').length, 1);
  assert.equal(events.some(event => event.type === 'map.failed'), false);
  assert.deepEqual(failures, []);
});

test('loop exits explain condition satisfaction separately from exhausting the bound', async () => {
  for (const [target, reason, iterations] of [[2, 'condition_met', 2], [5, 'bound_reached', 3]]) {
    const events = [];
    const candidate = flow({ node: 'loop', label: 'count', maxIters: 3,
      body: code('increment', 's => ({ count: s.count + 1 })'), until: { predicate: 'gte', path: 'count', n: target },
    });
    const result = await runWorkflow(candidate, { count: 0 }, { onEvent: event => events.push(event) });
    assert.equal(result.state.count, iterations);
    assert.deepEqual(events.filter(event => event.type === 'loop.exited'), [{ type: 'loop.exited', label: 'count', detail: { reason, iterations }, executionPath: '/root' }]);
  }
});

test('all LLM node kinds can scope their JSON state while instructions remain literal', async () => {
  for (const kind of ['agent', 'decide', 'extract', 'report']) {
    const instructions = 'Read {text}; braces like {undeclared.path} are literal instructions.';
    const node = kind === 'report'
      ? { node: kind, label: kind, instructions, state: { selected: '{text}' } }
      : agent({ node: kind, instructions, state: { selected: '{text}' } });
    const observed = [];
    const result = await runWorkflow(flow(node), { text: 'Public content', secret: 'Must remain out of the prompt' }, {
      runNode: async params => {
        observed.push(params);
        return kind === 'report' ? { report_markdown: 'This is a complete report with enough text to satisfy the report schema.' } : { value: 1 };
      },
    });
    assert.equal(result.status, 'complete', kind);
    assert.deepEqual(JSON.parse(observed[0].user), { selected: 'Public content' }, kind);
    assert.ok(observed[0].system.includes(instructions), kind);
  }
  const invalid = validateWorkflow(flow(agent({ state: { text: '{absent}' } })), { inputKeys: ['text'] });
  assert.equal(invalid.ok, false);
  let called = false;
  await assert.rejects(runWorkflow(flow(agent({ state: { text: '{text.missing}' } })), { text: {} }, {
    runNode: async () => { called = true; return { value: 1 }; },
  }), /text.missing/);
  assert.equal(called, false);
});

test('map.resultPath returns only the selected item result; missing paths fail and omitted paths retain legacy results', async () => {
  const map = { node: 'map', label: 'double', itemsPath: 'items', as: 'results',
    body: chain(code('double-item', 's => ({ product: { doubled: s.item * 2 } })')),
  };
  const input = { items: [2, 3], largeParent: { text: 'Parent-only data' } };
  const selected = await runWorkflow(flow({ ...map, resultPath: 'product' }), input, {});
  assert.deepEqual(selected.state.results, [{ doubled: 4 }, { doubled: 6 }]);
  const scalar = await runWorkflow(flow({ ...map, resultPath: 'product.doubled' }), input, {});
  assert.deepEqual(scalar.state.results, [4, 6]);
  await assert.rejects(runWorkflow(flow({ ...map, resultPath: 'product.absent' }), input, {}), /resultPath "product.absent" is missing/);
  const legacy = await runWorkflow(flow(map), input, {});
  assert.deepEqual(legacy.state.results[0].largeParent, input.largeParent);
  assert.deepEqual(legacy.state.results[0].product, { doubled: 4 });
  assert.equal(legacy.state.results[0].item, 2);
  const nullMap = { ...map, body: { node: 'code', label: 'null-value', code: 's => ({ product: null })' } };
  assert.deepEqual((await runWorkflow(flow({ ...nullMap, resultPath: 'product' }), input, {})).output.results, [null, null]);
  await assert.rejects(runWorkflow(flow({ ...nullMap, resultPath: 'product.absent' }), input, {}), /resultPath "product.absent" is missing/);
  assert.equal(validateWorkflow(flow({ ...map, resultPath: '' })).ok, false);
});

test('sift guards expanded question count at 256 before dispatch and permits a deliberate host override', async () => {
  const Questions = object({ first: { type: 'boolean', description: 'Does the first condition hold?' }, second: { type: 'boolean', description: 'Does the second condition hold?' } });
  const candidate = flow({ node: 'sift', label: 'screen', itemsPath: 'items', out: 'Questions', as: 'screened' }, { Questions });
  let calls = 0;
  const deps = { runJudge: async params => { calls++; return scriptedJudge(params); } };
  const input = { items: Array.from({ length: 129 }, (_, index) => ({ index })) };
  await assert.rejects(runWorkflow(candidate, input, deps), /258 questions exceed maxQuestionsPerRequest \(256\)/);
  assert.equal(calls, 0);
  assert.equal((await runWorkflow(candidate, { items: input.items.slice(0, 128) }, deps)).status, 'complete');
  assert.equal(calls, 1);
  assert.equal((await runWorkflow(candidate, input, { ...deps, maxQuestionsPerRequest: 258 })).status, 'complete');
  assert.equal(calls, 2);
});

test('invalid question limits and statically oversized judge schemas fail before prior effects', async () => {
  let effects = 0, judgments = 0;
  const deps = { runEffect: async () => { effects++; return { value: 1 }; }, runJudge: async params => { judgments++; return scriptedJudge(params); } };
  for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(runWorkflow(flow(call()), {}, { ...deps, maxQuestionsPerRequest: limit }), /maxQuestionsPerRequest must be a positive safe integer/);
  }
  const Questions = object(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`q${index}`, { type: 'boolean', description: `Does condition ${index} hold?` }])));
  const candidate = flow(chain(call(), { node: 'judge', label: 'judge', state: { request: 'Evaluate these conditions' }, out: 'Questions', as: 'answers' }), { Questions });
  await assert.rejects(runWorkflow(candidate, {}, deps), /257 questions exceed maxQuestionsPerRequest \(256\)/);
  assert.deepEqual({ effects, judgments }, { effects: 0, judgments: 0 });
  assert.equal((await runWorkflow(candidate, {}, { ...deps, maxQuestionsPerRequest: 257 })).status, 'complete');
  assert.deepEqual({ effects, judgments }, { effects: 1, judgments: 1 });
});
