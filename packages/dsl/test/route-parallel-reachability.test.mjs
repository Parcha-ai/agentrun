// Inspection refuses what a run refuses: the state check follows interpolations into a route's branches and past route
// and parallel nodes. Inside a branch the state is what it was before the route, plus the route's `as`; after a route it
// holds only what every branch writes, since one of them runs; after a parallel it holds what each branch writes, since
// all of them run. Each refused case below is one the interpreter refuses at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow } from '@parcha/agentrun-dsl';

const schemas = { Any: { type: 'object' }, In: { type: 'object', properties: { topic: { type: 'string' } } } };
const flow = (root) => ({ v: 2, name: 'reach', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Any' }, root });
const fetch = (label, args = { url: '{url}' }) => ({ node: 'call', label, via: 'tool', tool: 'fetch', args, out: 'Any', as: label, deadline_s: 5 });
const agent = (label, as = label) => ({ node: 'agent', label, instructions: 'Do it.', out: 'Any', as });
const route = (branches, extra = {}) => ({ node: 'route', label: 'r', valuePath: 'topic', otherwise: Object.keys(branches)[0], branches: Object.fromEntries(Object.entries(branches).map(([name, body]) => [name, { body }])), ...extra });
const chain = (...steps) => ({ node: 'chain', steps });

const inspect = (workflow) => validateWorkflow(workflow, { inputKeys: ['topic'] });
const run = (workflow, topic = 'a') => runWorkflow(workflow, { topic }, { runNode: async () => ({ ok: true }), runEffect: async () => ({ ok: true }) })
  .then((result) => result.status, (error) => `refused: ${error.message}`);
// The run refuses such a read either at the interpolation (before this change, inside a route branch or past a route or a
// parallel) or, once the state check follows it, at the run's own validation before any step runs.
const runRefuses = (key) => new RegExp(`refused: (interpolation path "${key}" is not present in the state|.*interpolates \\{${key}\\} but no upstream node produces "${key}")`);
const refusesUrl = (result) => {
  assert.equal(result.ok, false, 'inspection refuses it');
  assert.ok(result.errors.some((error) => error.includes('interpolates {url} but no upstream node produces "url"')), result.errors.join('\n'));
};

test('at the top level, a read of a key nothing produces is refused at inspection, and the run refuses it too', async () => {
  const top = flow(chain(fetch('read')));
  refusesUrl(inspect(top));
  assert.match(await run(top), /refused: .*interpolates \{url\}/);
});

test('inside a route branch, after a route and after a parallel, the same read is refused at inspection, as the run refuses it', async () => {
  const cases = {
    'in a route branch': flow(chain(route({ a: fetch('read'), b: agent('other') }))),
    'after a route': flow(chain(route({ a: agent('one'), b: agent('two') }), fetch('read'))),
    'after a parallel': flow(chain({ node: 'parallel', label: 'p', branches: [agent('one'), agent('two')] }, fetch('read'))),
    'in a branch of a route inside a parallel': flow(chain({ node: 'parallel', label: 'p', branches: [route({ a: fetch('read'), b: agent('other') }), agent('two')] })),
  };
  for (const [where, workflow] of Object.entries(cases)) {
    assert.match(await run(workflow), runRefuses('url'), `${where}: the run refuses it`);
    refusesUrl(inspect(workflow));
  }
});

test('after a route, a key only some branches write is refused: the branch that does not write it would fail the read', async () => {
  const workflow = flow(chain(route({ a: agent('page'), b: agent('other') }), fetch('read', { url: '{page}' })));
  // Through the branch that does not write it the run fails; refused at inspection, no run starts through either branch.
  assert.match(await run(workflow, 'b'), runRefuses('page'), 'through the branch that does not write it');
  const result = inspect(workflow);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('interpolates {page} but no upstream node produces "page"')), result.errors.join('\n'));
});

test('what the state does hold is accepted, and the run completes', async () => {
  const cases = {
    'a key every branch writes, read after the route': flow(chain(route({ a: agent('one', 'page'), b: agent('two', 'page') }), fetch('read', { url: '{page}' }))),
    'a key written before the route, read inside a branch': flow(chain(agent('first', 'page'), route({ a: fetch('read', { url: '{page}' }), b: agent('other') }))),
    'the route\'s own as, inside a branch and after it': flow(chain(route({ a: fetch('inside', { pick: '{choice}' }), b: agent('other') }, { as: 'choice' }), fetch('after', { pick: '{choice}' }))),
    'a key one parallel branch writes, read after the parallel': flow(chain({ node: 'parallel', label: 'p', branches: [agent('one', 'page'), agent('two')] }, fetch('read', { url: '{page}' }))),
    'a key a branch writes, read later in the same branch': flow(chain(route({ a: chain(agent('one', 'page'), fetch('read', { url: '{page}' })), b: agent('other') }))),
    // A code node's patch keys are probed, not known: after a branch with one the check stands down, as it does at the top level.
    'a key a code node writes in every branch, read after the route': flow(chain(route({ a: { node: 'code', label: 'ca', code: 's => ({ url: "x" })' }, b: { node: 'code', label: 'cb', code: 's => ({ url: "y" })' } }), fetch('read'))),
  };
  for (const [what, workflow] of Object.entries(cases)) {
    const result = inspect(workflow);
    assert.deepEqual(result.ok ? true : result.errors, true, what);
    for (const topic of ['a', 'b']) assert.equal(await run(workflow, topic), 'complete', `${what} (branch ${topic})`);
  }
});
