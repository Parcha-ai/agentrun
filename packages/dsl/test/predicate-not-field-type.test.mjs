// `field_type` and `not`: a guard that fails closed on a value that is present but not of the type it should be.
// `gte` and `lt` read only a finite number, so on "abc" neither fires and "accept unless a guard fires" accepts it;
// {"predicate": "not", "of": {"predicate": "field_type", "path": ..., "type": "number"}} fires instead. `not` takes only
// a mechanical predicate, so a judged question cannot hide inside a negation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow, predicateMatches } from '../dist/index.js';

// The guard reads the score of an answer; an answer without one leaves the path absent.
const notNumber = { predicate: 'not', of: { predicate: 'field_type', path: 'answer.score', type: 'number' } };
const guarded = (when) => ({
  v: 2, name: 'guard', schemas: { Out: { type: 'object' } }, output: { schemaId: 'Out', path: 'accepted' },
  root: { node: 'chain', steps: [
    { node: 'escalate', label: 'gate', when, kind: 'review', stage: 'gate', summary: 'score is {answer.score}' },
    { node: 'code', label: 'accept', code: '(s) => ({ accepted: { score: s.answer.score } })' },
  ] },
});
const run = (when, score) => runWorkflow(guarded(when), { answer: score === undefined ? {} : { score } }, { runCode: async (node, state) => ({ accepted: { score: state.answer.score } }) });
const errorsOf = (when) => { const checked = validateWorkflow(guarded(when), { executeCode: false, input: { answer: { score: 3 } } }); return checked.ok ? [] : checked.errors; };

test('an escalate on not field_type number fires on a present value that is not a number', async () => {
  const result = await run(notNumber, 'abc');
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.label, 'gate');
});

test('not field_type number fires for "abc", null, NaN, Infinity, an object and an absent score, and not for 3', async () => {
  // undefined: the answer has no score at all, so a missing answer fails closed.
  for (const score of ['abc', null, NaN, Infinity, -Infinity, { value: 3 }, [3], true, undefined]) {
    assert.equal((await run(notNumber, score)).status, 'escalated', String(score));
  }
  for (const score of [3, 0, -0.5]) assert.equal((await run(notNumber, score)).status, 'complete', String(score));
});

test('gte and lt alone do not fire on "abc": the gap the negation closes', async () => {
  for (const when of [{ predicate: 'lt', path: 'answer.score', n: 0 }, { predicate: 'gte', path: 'answer.score', n: 100 }]) {
    assert.equal((await run(when, 'abc')).status, 'complete', when.predicate);
  }
});

test('field_type holds when the value is that JSON type, a number only when finite, and an absent value has no type', () => {
  const at = (type, score) => predicateMatches({ predicate: 'field_type', path: 'score', type }, score === undefined ? {} : { score });
  const cases = [
    ['number', 3, true], ['number', NaN, false], ['number', Infinity, false], ['number', '3', false],
    ['string', 'abc', true], ['string', 3, false],
    ['boolean', false, true], ['boolean', 0, false],
    ['array', [], true], ['array', {}, false],
    ['object', {}, true], ['object', [], false], ['object', null, false],
    ['null', null, true], ['null', undefined, false],
  ];
  for (const [type, score, holds] of cases) assert.equal(at(type, score), holds, `${type} on ${String(score)}`);
  for (const type of ['number', 'string', 'boolean', 'array', 'object', 'null']) assert.equal(at(type, undefined), false, `${type} on absent`);
});

test('not negates the predicate it holds, and nests', () => {
  const state = { flags: { done: true }, items: [] };
  assert.equal(predicateMatches({ predicate: 'not', of: { predicate: 'field_true', path: 'flags.done' } }, state), false);
  assert.equal(predicateMatches({ predicate: 'not', of: { predicate: 'empty', path: 'items' } }, state), false);
  assert.equal(predicateMatches({ predicate: 'not', of: { predicate: 'not', of: { predicate: 'empty', path: 'items' } } }, state), true);
});

test('validation accepts not field_type in escalate.when, loop.until and poll.until', () => {
  assert.deepEqual(errorsOf(notNumber), []);
  const loop = guarded(notNumber);
  loop.root.steps = [{ node: 'loop', label: 'retry', maxIters: 3, until: { predicate: 'not', of: { predicate: 'field_type', path: 'accepted', type: 'null' } }, body: loop.root.steps[1] }];
  assert.deepEqual(validateWorkflow(loop, { executeCode: false }), { ok: true });
  const poll = guarded(notNumber);
  poll.schemas.Job = { type: 'object', properties: { state: { type: 'string' } } };
  poll.root.steps = [
    { node: 'call', label: 'job', via: 'tool', tool: 'jobs.get', out: 'Job', as: 'job', deadline_s: 5,
      poll: { until: { predicate: 'not', of: { predicate: 'field_type', path: 'state', type: 'null' } }, interval_s: 1, deadline_s: 5 } },
    poll.root.steps[1],
  ];
  assert.deepEqual(validateWorkflow(poll, { executeCode: false }), { ok: true });
});

test('validation names a bad field_type type by its path', () => {
  const errors = errorsOf({ predicate: 'not', of: { predicate: 'field_type', path: 'answer.score', type: 'integer' } });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /when\.of: field_type needs a type of number\|string\|boolean\|array\|object\|null, not "integer"/);
  assert.match(errorsOf({ predicate: 'field_type', type: 'number' }).join('\n'), /when: field_type needs a path/);
});

test('not refuses a judged predicate, naming it by its path, at any depth', () => {
  const ask = { predicate: 'ask', instructions: 'Is the score a number?' };
  assert.match(errorsOf({ predicate: 'not', of: ask }).join('\n'), /when\.of: not takes only a mechanical predicate, not "ask"/);
  assert.match(errorsOf({ predicate: 'not', of: { predicate: 'not', of: ask } }).join('\n'), /when\.of\.of: not takes only a mechanical predicate, not "ask"/);
  assert.match(errorsOf({ predicate: 'not' }).join('\n'), /when: not needs "of", one mechanical predicate/);
});

test('the guard inside not must read a produced value', () => {
  const errors = errorsOf({ predicate: 'not', of: { predicate: 'field_type', path: 'nowhere', type: 'number' } });
  assert.match(errors.join('\n'), /reads "nowhere" but no input key or earlier node produces "nowhere"/);
});

// A path into a code node's probed shape, or a call's declared result, is checked through `not` as it is bare.
const refusals = (flow) => { const checked = validateWorkflow(flow, { input: {} }); return checked.ok ? [] : checked.errors; };

test('a when under not on a path the code node does not produce is refused as the bare predicate is', () => {
  const at = (when) => ({ ...guarded(when), root: { node: 'chain', steps: [{ node: 'code', label: 'read', code: '(s) => ({ answer: { score: 3 } })' }, ...guarded(when).root.steps] } });
  const bare = { predicate: 'field_type', path: 'answer.nope', type: 'number' };
  const errors = refusals(at({ predicate: 'not', of: bare }));
  assert.match(errors.join('\n'), /predicate path "answer\.nope" is not produced by the code node that writes "answer" \(its shape has: score\); the guard can never fire/);
  assert.deepEqual(errors, refusals(at(bare)));
});

test('a poll under not on a path outside the declared result is refused as the bare predicate is', () => {
  const at = (until) => {
    const flow = guarded(notNumber);
    flow.schemas.Job = { type: 'object', properties: { state: { type: 'string' } } };
    flow.root.steps = [{ node: 'call', label: 'job', via: 'tool', tool: 'jobs.get', out: 'Job', as: 'job', deadline_s: 5, poll: { until, interval_s: 1, deadline_s: 5 } }];
    flow.output.path = 'job';
    return flow;
  };
  const bare = { predicate: 'field_type', path: 'nope', type: 'string' };
  const errors = refusals(at({ predicate: 'not', of: bare }));
  assert.match(errors.join('\n'), /poll\.until path "nope" is not in the declared result shape \(state\); the poll could never settle/);
  assert.deepEqual(errors, refusals(at(bare)));
});

// A malformed poll predicate is refused by name; it never throws. A shape error stops the checks that read inside it.
const pollUntil = (until) => {
  const flow = guarded(notNumber);
  flow.schemas.Job = { type: 'object', properties: { state: { type: 'string' } } };
  flow.root.steps = [{ node: 'call', label: 'job', via: 'tool', tool: 'jobs.get', out: 'Job', as: 'job', deadline_s: 5, poll: { until, interval_s: 1, deadline_s: 5 } }];
  flow.output.path = 'job';
  return flow;
};
const refusedPoll = (until, message) => {
  let checked;
  assert.doesNotThrow(() => { checked = validateWorkflow(pollUntil(until), { input: {} }); });
  assert.equal(checked.ok, false);
  // Exactly the shape error: nothing reads inside a malformed predicate, so nothing else about poll.until is reported.
  const reported = checked.issues.filter((issue) => issue.message.includes('poll.until'));
  assert.equal(reported.length, 1, checked.errors.join('\n'));
  assert.equal(reported[0].code, 'PREDICATE_INVALID');
  assert.match(reported[0].message, message);
};

test('a poll whose until is not with no of is refused with PREDICATE_INVALID naming the missing of, and never throws', () => {
  refusedPoll({ predicate: 'not' }, /poll\.until: not needs "of", one mechanical predicate/);
});

test('a poll whose until is not over a not with no of is refused the same way, and never throws', () => {
  refusedPoll({ predicate: 'not', of: { predicate: 'not' } }, /poll\.until\.of: not needs "of", one mechanical predicate/);
});

test('a poll whose until is a field_type with no type is refused with its shape error, and never throws', () => {
  // The path lies outside the result too: a shape error stops the path check, so only the shape error is reported.
  refusedPoll({ predicate: 'field_type', path: 'nope' }, /poll\.until: field_type needs a type of number\|string\|boolean\|array\|object\|null, not none/);
});
