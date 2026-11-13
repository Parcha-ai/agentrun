// Step guards: `guard: {signal, threshold, question?, fit?}` on a step. validateWorkflow refuses a wrong one in words an
// author (or a compile loop feeding its errors back to a model) can act on; the engine reads the step's own confidence
// (an agent or decide node submits one beside its record, a judge's is its weakest answer's), asks the host's guardStep
// for p with what the step saw and wrote, and below the threshold the run escalates (kind `guard`) at the step with the
// state it reached. A host with no guardStep is refused before any node runs; a dry run never hands back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunWorkflow, runWorkflow, validateWorkflow, GUARD_SIGNALS, SELF_CONFIDENCE_FIELD, confidenceKey, stepGuardOf } from '@parcha/agentrun-dsl';

const schemas = {
  In: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
  Answer: { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'number' } } },
  Sure: { type: 'object', properties: { right: { type: 'boolean', description: 'Is the answer right?' } } },
};
/** One guarded agent step, answering the question. */
const flow = (guard, node = {}) => ({
  v: 2, name: 'answer', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'agent', label: 'answer', instructions: 'Answer the question.', out: 'Answer', as: 'answer', tools: [], ...(guard === undefined ? {} : { guard }), ...node },
});
const messagesOf = (doc) => {
  const checked = validateWorkflow(doc);
  return checked.ok ? [] : checked.errors;
};

test('validateWorkflow: a bad signal, threshold, question or fit is refused in words that say what to write', () => {
  assert.deepEqual(GUARD_SIGNALS, ['self', 'jev', 'both']);
  assert.deepEqual(messagesOf(flow({ signal: 'self', threshold: 0.7 })), [], 'a self guard on an agent node');
  assert.deepEqual(messagesOf(flow({ signal: 'both', threshold: 0.5, question: 'Is the number right?', fit: { w: [2.1, 1.3], b: -1.2, n: 140, fitted_at: '2026-11-13T05:02:00Z' } })), []);
  const [signal] = messagesOf(flow({ signal: 'jevv', threshold: 0.7 }));
  assert.match(signal, /guard\.signal must be "self", "jev" or "both" \(got "jevv"\)/);
  for (const threshold of [0, 1, 1.4, -0.1, '0.7', undefined]) {
    const [said] = messagesOf(flow({ signal: 'jev', threshold }));
    assert.match(said ?? '', /guard\.threshold must be a number between 0 and 1, exclusive: the chance the step is right below which the run hands the job back/, String(threshold));
  }
  assert.match(messagesOf(flow({ signal: 'self', threshold: 0.6, question: 'right?' }))[0], /\.question is Jev's; a "self" guard asks Jev nothing/);
  assert.match(messagesOf(flow({ signal: 'jev', threshold: 0.6, question: '  ' }))[0], /\.question must be non-empty text/);
  assert.match(messagesOf(flow({ signal: 'jev', threshold: 0.6, cutoff: 1 }))[0], /unknown key\(s\) cutoff; a guard takes signal, threshold, question, fit/);
  assert.match(messagesOf(flow({ signal: 'both', threshold: 0.6, fit: { w: [1], b: 0, n: 3, fitted_at: '2026-11-13T05:02:00Z' } }))[0], /\.fit must be \{"w": \[w_self, w_jev\]/);
  assert.match(messagesOf(flow({ signal: 'jev', threshold: 0.6, fit: { w: [1], b: 0, n: 0, fitted_at: 'yesterday' } }))[0], /\.fit must be \{"w": \[w_jev\]/);
  assert.match(messagesOf(flow('high'))[0], /guard must be an object/);
});

test('validateWorkflow: self reads only a node that reports a confidence, and a guard sits only on a step', () => {
  const extract = flow({ signal: 'self', threshold: 0.6 }, { node: 'extract' });
  assert.match(messagesOf(extract)[0], /\.signal "self" reads the step's own confidence, which a extract node does not report \(only agent, decide, judge, pick, sift nodes do\); use "jev"/);
  assert.deepEqual(messagesOf(flow({ signal: 'jev', threshold: 0.6 }, { node: 'extract' })), [], 'jev on an extract');
  const call = { ...flow(undefined), schemas: { ...schemas, Got: { type: 'object' } }, output: { schemaId: 'Got', path: 'got' }, root: { node: 'call', label: 'fetch', via: 'tool', tool: 'web_fetch', args: { url: '{question}' }, out: 'Got', as: 'got', deadline_s: 10, guard: { signal: 'both', threshold: 0.6 } } };
  assert.match(messagesOf(call)[0], /\.signal "both" reads the step's own confidence, which a call node does not report/);
  const map = { ...flow(undefined), schemas: { ...schemas, L: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } }, input: { schemaId: 'L' }, output: { schemaId: 'L', path: 'items' }, root: { node: 'map', label: 'each', itemsPath: 'items', as: 'out', body: { node: 'code', label: 'id', code: '(s) => s.item', as: 'x' }, guard: { signal: 'jev', threshold: 0.5 } } };
  assert.match(messagesOf(map)[0], /guard: a guard sits on a step that writes a value \(agent, decide, extract, code, call, workflow, judge, pick, sift\); a map node takes none/);
  const listOut = flow({ signal: 'self', threshold: 0.6 }, { out: 'List' });
  listOut.schemas = { ...schemas, List: { type: 'array', items: { type: 'number' } } };
  assert.match(messagesOf(listOut).join('\n'), /has the node submit its confidence beside its record, so its out schema "List" must be an object schema/);
});

/** A run of `doc` whose agent node submits `submitted`, with the guard's p from `p(params)`. */
async function run(doc, { submitted = { answer: 42, confidence: 0.9 }, p = (params) => ({ p: params.self ?? 0 }), deps = {} } = {}) {
  const asked = { nodes: [], guards: [], events: [] };
  const result = await runWorkflow(doc, { question: 'six times seven' }, {
    runNode: async (params) => { asked.nodes.push(params); return structuredClone(submitted); },
    guardStep: async (params) => { asked.guards.push(params); return p(params); },
    onEvent: (event) => asked.events.push(event),
    ...deps,
  });
  return { result, ...asked };
}

test('a self guard: the node submits its confidence beside its record; it lands at <as>$confidence, never in its value', async () => {
  const { result, nodes, guards, events } = await run(flow({ signal: 'self', threshold: 0.7 }));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, { answer: 42 }, 'the confidence is not the answer');
  assert.equal(result.state[confidenceKey('answer')], 0.9);
  // The node was asked for it: the field, required, between 0 and 1, beside the record's own.
  const schema = nodes[0].schema;
  assert.ok(schema.required.includes(SELF_CONFIDENCE_FIELD) && schema.required.includes('answer'), JSON.stringify(schema));
  assert.deepEqual({ type: schema.properties.confidence.type, minimum: schema.properties.confidence.minimum, maximum: schema.properties.confidence.maximum }, { type: 'number', minimum: 0, maximum: 1 });
  // The host was asked with the step's input (the state it ran on), its output and its own confidence.
  assert.equal(guards.length, 1);
  assert.deepEqual({ label: guards[0].label, kind: guards[0].kind, self: guards[0].self, output: guards[0].output, input: guards[0].input.question, path: guards[0].executionPath }, { label: 'answer', kind: 'agent', self: 0.9, output: { answer: 42 }, input: 'six times seven', path: '/root' });
  assert.deepEqual(stepGuardOf(flow({ signal: 'self', threshold: 0.7 }).root), { signal: 'self', threshold: 0.7 });
  const evaluated = events.find((event) => event.type === 'guard.evaluated');
  assert.deepEqual(evaluated.detail, { kind: 'agent', signal: 'self', threshold: 0.7, p: 0.9, self: 0.9, jev: null, escalated: false });
});

test('below the threshold the run hands the job back at the step: escalated, kind guard, with the state it reached', async () => {
  const { result, events } = await run(flow({ signal: 'self', threshold: 0.7 }), { submitted: { answer: 41, confidence: 0.35 } });
  assert.equal(result.status, 'escalated');
  assert.deepEqual({ kind: result.escalation.kind, stage: result.escalation.stage, label: result.escalation.label }, { kind: 'guard', stage: 'answer', label: 'answer' });
  assert.match(result.escalation.summary, /its guard put the chance this step is right at 0\.35 \(its own confidence 0\.35\), under its threshold 0\.7/);
  assert.equal(result.state.answer.answer, 41, 'the agent who takes it on sees what the step found');
  assert.deepEqual(events.find((event) => event.type === 'guard.evaluated').detail.escalated, true);
  assert.equal(events.find((event) => event.type === 'node.end').detail.status, 'escalated');
});

test('a jev guard: the host gives p; no p at all hands back, never passes', async () => {
  const jev = flow({ signal: 'jev', threshold: 0.6, question: 'Is the product right?' });
  const high = await run(jev, { submitted: { answer: 42 }, p: () => ({ p: 0.91, jev: 0.91 }) });
  assert.equal(high.result.status, 'complete');
  assert.equal(high.nodes[0].schema.properties.confidence, undefined, 'a jev guard asks the node for no confidence');
  assert.equal(high.guards[0].self, null);
  assert.equal(high.events.find((event) => event.type === 'guard.evaluated').detail.jev, 0.91);
  const low = await run(jev, { submitted: { answer: 41 }, p: () => ({ p: 0.2, jev: 0.2 }) });
  assert.equal(low.result.status, 'escalated');
  assert.match(low.result.escalation.summary, /at 0\.20 \(Jev's 0\.20\), under its threshold 0\.6/);
  const none = await run(jev, { submitted: { answer: 42 }, p: () => ({}) });
  assert.equal(none.result.status, 'escalated', 'no p: handed back');
  assert.match(none.result.escalation.summary, /at none/);
});

test('a host with no guardStep is refused before any node runs', async () => {
  let ran = 0;
  await assert.rejects(runWorkflow(flow({ signal: 'self', threshold: 0.7 }), { question: 'q' }, { runNode: async () => { ran += 1; return { answer: 1, confidence: 1 }; } }), /agent node "answer" requires guardStep/);
  assert.equal(ran, 0);
});

test('a jev guard on a call node is asked with the call\'s resolved args and its result; a judge\'s self is its weakest answer', async () => {
  const callFlow = { v: 2, name: 'c', schemas: { In: schemas.In, Got: { type: 'object', properties: { body: { type: 'string' } } } }, input: { schemaId: 'In' }, output: { schemaId: 'Got', path: 'got' },
    root: { node: 'call', label: 'fetch', via: 'tool', tool: 'web_fetch', args: { url: 'https://example.invalid/{question}' }, out: 'Got', as: 'got', deadline_s: 10, guard: { signal: 'jev', threshold: 0.5 } } };
  const guards = [];
  const result = await runWorkflow(callFlow, { question: 'q' }, { runEffect: async () => ({ body: 'page' }), guardStep: async (params) => { guards.push(params); return { p: 0.8, jev: 0.8 }; } });
  assert.equal(result.status, 'complete');
  assert.deepEqual({ input: guards[0].input, output: guards[0].output, self: guards[0].self, kind: guards[0].kind }, { input: { url: 'https://example.invalid/q' }, output: { body: 'page' }, self: null, kind: 'call' });

  const judgeFlow = { v: 2, name: 'j', schemas: { In: schemas.In, Sure: schemas.Sure }, input: { schemaId: 'In' }, output: { schemaId: 'Sure', path: 'verdict' },
    root: { node: 'judge', label: 'check', state: { q: '{question}' }, out: 'Sure', as: 'verdict', guard: { signal: 'both', threshold: 0.5 } } };
  const seen = [];
  const judged = await runWorkflow(judgeFlow, { question: 'q' }, {
    runJudge: async () => ({ answers: { right: { type: 'noul', noul: 0.8 } } }),
    guardStep: async (params) => { seen.push(params); return { p: Math.min(params.self, 0.9), jev: 0.9 }; },
  });
  assert.equal(judged.status, 'complete');
  assert.equal(seen[0].self, 0.6, 'a noul of 0.8 is a confidence of 0.6, its weakest answer');
  assert.deepEqual(seen[0].input, { q: 'q' });
});

test('a dry run of a guarded workflow passes: a guard never hands back on synthetic values', async () => {
  const dry = await dryRunWorkflow(flow({ signal: 'both', threshold: 0.99 }), { question: 'q' });
  assert.equal(dry.status, 'passed', JSON.stringify(dry));
});

/** A judge that answers every question it is asked yes at `noul(question id)`. */
const answering = (noul, asked = []) => async (params) => {
  asked.push(params);
  return { answers: Object.fromEntries(Object.keys(params.questions).map((id) => [id, { type: 'noul', noul: noul(id) }])) };
};
const listed = { In: { type: 'object', required: ['question', 'items'], properties: { question: { type: 'string' }, items: { type: 'array' } } }, Sure: schemas.Sure, Any: { type: 'object' } };

test('a sift\'s self is its weakest answer over every item (as.answers[i]), so a confident sift passes', async () => {
  const siftFlow = (guard) => ({ v: 2, name: 's', schemas: listed, input: { schemaId: 'In' }, output: { schemaId: 'Any', path: 'sifted' },
    root: { node: 'sift', label: 'sift', itemsPath: 'items', describe: '{item.name}', state: { q: '{question}' }, out: 'Sure', as: 'sifted', guard } });
  const seen = [];
  // Item 0 at noul 0.9 (confidence 0.8), item 1 at 0.85 (0.7): the sift's weakest answer is 0.7.
  const confident = await runWorkflow(siftFlow({ signal: 'self', threshold: 0.6 }), { question: 'q', items: [{ name: 'a' }, { name: 'b' }] }, {
    runJudge: answering((id) => (id.startsWith('1.') ? 0.85 : 0.9)),
    guardStep: async (params) => { seen.push(params); return { p: params.self ?? Number.NaN }; },
  });
  assert.equal(confident.status, 'complete', JSON.stringify(confident.escalation ?? null));
  assert.equal(seen[0].self, 0.7, 'the weakest of the items\' answers');
  // The guard sees what the sift's judge saw: its state and the items it was asked about, by id.
  assert.deepEqual(seen[0].input, { q: 'q', items: [{ id: 'item_0', summary: 'a', item: { name: 'a' } }, { id: 'item_1', summary: 'b', item: { name: 'b' } }] });
  const unsure = await runWorkflow(siftFlow({ signal: 'self', threshold: 0.6 }), { question: 'q', items: [{ name: 'a' }, { name: 'b' }] }, {
    runJudge: answering((id) => (id.startsWith('1.') ? 0.6 : 0.9)),
    guardStep: async (params) => ({ p: params.self ?? Number.NaN }),
  });
  assert.equal(unsure.status, 'escalated', 'one unsure item (0.2) hands the sift back');
  assert.match(unsure.escalation.summary, /its own confidence 0\.20/);
});

test('a pick\'s guard is asked with what its judge chose among: the candidates and the selection instructions', async () => {
  const pickFlow = { v: 2, name: 'p', schemas: listed, input: { schemaId: 'In' }, output: { schemaId: 'Any', path: 'picked' },
    root: { node: 'pick', label: 'pick', itemsPath: 'items', describe: '{item.name}', instructions: 'Pick the item that answers {question}.', state: { q: '{question}' }, allowNone: true, as: 'picked', guard: { signal: 'jev', threshold: 0.5 } } };
  const judged = []; const seen = [];
  const result = await runWorkflow(pickFlow, { question: 'q', items: [{ name: 'a' }, { name: 'b' }] }, {
    runJudge: async (params) => { judged.push(params); return { answers: { pick: { type: 'choice', choice: 'none_of_these', probabilities: { item_0: 0.1, item_1: 0.1, none_of_these: 0.8 }, confidence: 0.8 } } }; },
    guardStep: async (params) => { seen.push(params); return { p: 0.9, jev: 0.9 }; },
  });
  assert.equal(result.status, 'complete', JSON.stringify(result.escalation ?? null));
  assert.deepEqual(seen[0].output, { index: null, item: null, none: true, option: null });
  assert.deepEqual(seen[0].input.candidates, { item_0: 'a', item_1: 'b' }, 'the candidates the judge chose among');
  assert.deepEqual(seen[0].input.candidates, judged[0].state.candidates);
  assert.equal(seen[0].input.q, 'q');
  assert.equal(seen[0].input.instructions, judged[0].questions.pick.instructions, 'the selection instructions');
  assert.equal(seen[0].input.allow_none, true);
});
