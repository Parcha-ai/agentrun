// A message's text parts: joined with a blank line, never glued together; and a prompt (a user message) with more than one
// text part, as a job's footer after its prompt, shows its first part with the rest folded under one "more"; a prompt of
// one part is shown as it is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { textOf, textPartsOf } from '../src/durable.ts';
import { turnsPanel, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';

const entry = (commit: number, role: string, content: Json): Line =>
  ({ channel: 'durable', source: 'pi', kind: `pi.${role}`, gen: 1, t: commit, commit, order: 0, conv: 1, data: { kind: 'message', model: [{ role, content }] } });
const text = (node: Node): string => (typeof node === 'string' ? node : 'children' in node && node.children ? node.children.map(text).join(' ') : '');
const find = (node: Node, tag: string): Node | undefined => (typeof node === 'string' ? undefined : node.tag === tag ? node : 'children' in node ? (node.children ?? []).map((child) => find(child, tag)).find(Boolean) : undefined);

test('text parts are joined with a blank line; a string content is one part; a block with no text adds none', () => {
  assert.equal(textOf({ role: 'user', content: [{ type: 'text', text: 'the task' }, { type: 'text', text: 'Submit with submit().' }] }), 'the task\n\nSubmit with submit().');
  assert.equal(textOf({ role: 'user', content: 'one string' }), 'one string');
  assert.deepEqual(textPartsOf({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }), ['a', 'b']);
  assert.equal(textOf({ role: 'assistant', content: [{ type: 'toolCall', name: 'x' }] }), '');
});

test('a prompt of two text parts shows its first, with the second folded under one "more"; one of one part is shown as it is', () => {
  const two = entry(1, 'user', [{ type: 'text', text: 'Read the issue and label it.' }, { type: 'text', text: 'When you are done, call submit with the label.' }]);
  const one = entry(2, 'user', [{ type: 'text', text: 'An older prompt, one part.' }]);
  const view = turnsPanel.view(reduceTo(turnsPanel, [two, one], 2), { t: 0 });
  const turns = typeof view !== 'string' && 'children' in view ? (view.children ?? []).filter((child) => typeof child !== 'string' && child.tag === 'div') : [];
  assert.equal(turns.length, 2);
  const [first, second] = turns as Node[];
  assert.match(text(first!), /^prompt Read the issue and label it\./);
  const more = find(first!, 'details');
  assert.ok(more, 'the footer is folded');
  assert.equal(text(find(more!, 'summary')!), 'more');
  assert.match(text(more!), /When you are done, call submit with the label\./);
  const shown = (first as { children: Node[] }).children.find((child) => typeof child !== 'string' && child.tag === 'p');
  assert.equal(text(shown!), 'Read the issue and label it.', 'the body alone, the footer not glued to it');
  assert.equal(find(second!, 'details'), undefined, 'one part: nothing folded');
  assert.match(text(second!), /^prompt An older prompt, one part\.$/);
});

test('a long footer is folded whole, and a long first part shows its start with the rest folded: nothing is cut away', () => {
  const footer = `Submit with submit(): ${'{"field": "string"}, '.repeat(60)}end of schema`;
  const body = `${'Read the issue. '.repeat(50)}last words`;
  const view = turnsPanel.view(reduceTo(turnsPanel, [entry(1, 'user', [{ type: 'text', text: body }, { type: 'text', text: footer }])], 1), { t: 0 });
  const turn = (view as { children: Node[] }).children.find((child) => typeof child !== 'string' && child.tag === 'div')!;
  const more = find(turn, 'details')!;
  const folded = (more as { children: Node[] }).children.filter((child) => typeof child !== 'string' && child.tag === 'p').map(text);
  assert.ok(footer.length > 600 && body.length > 600);
  assert.deepEqual(folded, [body.slice(600), footer], 'the rest of the first part, then the whole footer');
  const shown = (turn as { children: Node[] }).children.find((child) => typeof child !== 'string' && child.tag === 'p');
  assert.equal(text(shown!), body.slice(0, 600));
  assert.equal(text(shown!) + folded[0], body, 'the first part, all of it, between what is shown and what is folded');
});
