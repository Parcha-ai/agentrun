// The tools a node is offered and the browser a run has: a node gets the tools it declares, else every tool the run
// installs (`submit` is the node runner's), and a run with `browser: false` installs no browser at all.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { localHost, placeAt } from '@parcha/agentrun-reference';
import { compose, nodeTools } from '../packages/reference/dist/assemble.js';

async function registryOf(t, options) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-tools-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await placeAt(join(tmp, 'run'));
  const { host } = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' });
  const job = { workflow: { v: 2, name: 'tools', schemas: {}, root: { node: 'chain', steps: [] } }, input: {} };
  return (await compose(place, host, job, options)).registry.snapshot();
}
const names = (snapshot) => snapshot.installed().map((extension) => extension.name);
const read = { snapshot: async () => undefined };

test('a node is offered the tools it declares, in its order; with no declaration every tool the run installs; a name the run does not offer fails the node', () => {
  const offered = ['read', 'bash', 'code', 'browser_read'].map((name) => ({ name }));
  assert.deepEqual(nodeTools(offered, { label: 'lead', tools: ['code', 'read'] }).map((tool) => tool.name), ['code', 'read']);
  assert.deepEqual(nodeTools(offered, { label: 'lead', tools: ['code', 'submit'] }).map((tool) => tool.name), ['code'], 'submit is the node runner\'s to add');
  assert.equal(nodeTools(offered, { label: 'lead' }), undefined, 'no declaration: the node runner offers every installed tool');
  assert.deepEqual(nodeTools(offered, { label: 'lead', tools: [] }), [], 'an empty declaration: submit alone');
  assert.throws(() => nodeTools(offered, { label: 'lead', tools: ['look'] }), /node "lead" declares the tool look, which this run does not offer/);
});

test('a run installs the browser by default; with browser: false it installs no browser extension, no browser tool and no browser section, and keeps the rest', async (t) => {
  const on = await registryOf(t, { codeMode: true });
  const off = await registryOf(t, { codeMode: true, browser: false });
  const browser = names(on).filter((name) => !names(off).includes(name));
  assert.equal(browser.length, 1, 'the default installs one browser extension');
  assert.deepEqual(names(off), names(on).filter((name) => name !== browser[0]));
  const browserTools = on.tools().filter(({ extension }) => extension.name === browser[0]).map(({ tool }) => tool.name);
  assert.ok(browserTools.length > 0, 'the browser offers tools');
  assert.ok(!off.tools().some(({ tool }) => browserTools.includes(tool.name)), 'no browser tool');
  assert.ok(on.sections().some(({ extension }) => extension.name === browser[0]), 'the browser has a prompt section');
  assert.ok(!off.sections().some(({ extension }) => extension.name === browser[0]), 'no browser prompt section');
  assert.ok(off.tools().some(({ tool }) => tool.name === 'code'), 'code mode is still installed');
  await assert.rejects(registryOf(t, { browser: false, sites: { registry: { startUrl: 'http://127.0.0.1:9/' } } }), /a run with no browser offers no sites/);
});

test('with the browser installed, a node that declares only code is offered code, and the browser section says nothing to it', async (t) => {
  const on = await registryOf(t, { codeMode: true });
  const all = on.tools().map(({ tool }) => tool);
  const declared = nodeTools(all, { label: 'look', tools: ['code'] });
  assert.deepEqual(declared.map((tool) => tool.name), ['code']);
  const browser = names(on).find((name) => name.includes('browser'));
  const { section } = on.sections().find(({ extension }) => extension.name === browser);
  const input = (tools) => ({ conversationId: 'c', agent: { tools, extensions: [], sections: [], thinkingLevel: 'low' }, env: undefined, shown: {}, read });
  assert.equal(await section.render(input(declared), ctx), undefined, 'no browser text for a node offered no browser tool');
  assert.ok((await section.render(input(all), ctx))?.length > 0, 'the browser text for a node offered every tool');
});
