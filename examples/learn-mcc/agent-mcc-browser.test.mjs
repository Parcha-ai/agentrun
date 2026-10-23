// Proposal C, Amendment 1 (2): the browser seed home, agent-mcc-browser, is agent-mcc with ONE generic line in its workflows
// skill (a page read that returns no text is routed to the browser read tool in the same workflow) and the one sentence of
// classify-merchant that taught the opposite (escalate "needs the browser") said the same way. Nothing else differs, and
// nothing about codes or risk is added. agent-mcc itself is untouched.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const HOME = join(import.meta.dirname, 'agent-mcc');
const BROWSER = join(import.meta.dirname, 'agent-mcc-browser');
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
const read = (dir, path) => readFileSync(join(dir, path), 'utf8');
const words = (text) => text.replace(/\s+/g, ' ').trim();

test('the browser home is agent-mcc but for the browser route, said once in each skill', () => {
  assert.deepEqual(files(BROWSER), files(HOME));
  for (const path of ['AGENTS.md', 'agent.json']) assert.equal(read(BROWSER, path), read(HOME, path), path);
  const line = 'When a page read returns no text, or only a title and navigation (a page that needs its scripts), route that read to the browser read tool, `browse`, in the same workflow, and escalate only when the browser read returns no text either.';
  assert.equal(words(read(BROWSER, 'skills/workflows/SKILL.md')).replace(`${line} `, ''), words(read(HOME, 'skills/workflows/SKILL.md')));
  const was = 'The part that reads the site fetches the website given, and escalates "needs the browser" when the page has little text, so a part that browses can take over.';
  const now = 'The part that reads the site fetches the website given and, when the page has little text, reads it again with browse in the same workflow; it escalates only when the browser read has no text either.';
  assert.ok(words(read(HOME, 'skills/classify-merchant/SKILL.md')).includes(was));
  assert.equal(words(read(BROWSER, 'skills/classify-merchant/SKILL.md')), words(read(HOME, 'skills/classify-merchant/SKILL.md')).replace(was, now));
  for (const added of [line, now]) assert.doesNotMatch(added, /\d|MCC|risk|tier/i, 'nothing about codes or risk');
});
