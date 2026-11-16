// Links in the tracked Markdown land: GitHub's slug rule on the headings that trip it, a broken fragment or path named
// with its file, line, link and target, code left unread, and this tree passing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anchorsOf, brokenLinks, trackedFiles } from './check-doc-anchors.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('headings make the fragments GitHub makes: code spans, quotes, &, colons, repeats, setext, and <a id> anchors outside comments, by whole attribute', () => {
  const text = [
    '# The `labels: "machine"` option',
    '## "Quoted" and \'single\' words',
    '## Exec & files',
    '## Step one: run the pre-check',
    '## The `idle_ms` field, [linked](x.md) and **bold** _emphasis_',
    '## Notes',
    '### Notes',
    '## Notes ##',
    '## &#65;PI &amp; numeric \\*escapes\\*',
    '## The `&amp;` value',
    '<a id=unquoted-anchor></a>',
    '<a data-name="not-an-anchor" title=\'id="nor-this"\'></a>',
    '<a id="custom-anchor"></a>',
    '<a name="old-name"></a>',
    '',
    '<!-- <a id="commented-out"></a> -->',
    '',
    '<!-- an old note --><a id="after-comment"></a>',
    '',
    'Text <!-- <a name="inline-commented"></a> --> and <a id="inline-anchor"></a> here.',
    '',
    'A setext heading',
    '----------------',
    '',
    'A long',
    'wrapped heading',
    '===============',
    '',
    '- a list item',
    '---',
    '',
    '```md',
    '## Inside a fence',
    '```',
  ].join('\n');
  assert.deepEqual([...anchorsOf(text)].sort(), [
    'after-comment',
    'api--numeric-escapes',
    'inline-anchor',
    'custom-anchor',
    'exec--files',
    'notes',
    'notes-1',
    'notes-2',
    'old-name',
    'quoted-and-single-words',
    'a-setext-heading',
    'a-long-wrapped-heading',
    'step-one-run-the-pre-check',
    'the-amp-value',
    'the-idle_ms-field-linked-and-bold-emphasis',
    'unquoted-anchor',
    'the-labels-machine-option',
  ].sort());
});

test('a broken fragment or path fails naming the file, line, link and target; code, URLs and good links pass', (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'doc-anchors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    'docs/guide.md': '# Guide\n\n## The eleven members\n\n## Set up\n',
    'docs/report(1).md': '# Results\n',
    'docs/sub/page.md': [
      '# Page',
      'See [members](../guide.md#the-eleven-members), [setup](/docs/guide.md#set-up "Set up"), [below](#page) and [top](#).',
      'A [stale link](../guide.md#the-twelve-members) and [a missing section](#nowhere).',
      'A [gone file](../old.md#set-up), a [folder](../), [code](../../src/a.ts#L3) and [a site](https://example.com/x.md#y).',
      '`[inline](#not-read)`',
      '```',
      '[fenced](#not-read-either)',
      '```',
      '<!-- [commented](#also-not-read) -->',
      'A [reference][ref] link.',
      'The [report](../report(1).md#results), and after a literal `<!--` a [broken](#gone) link.',
      '> ```md',
      '> [quoted example](not-a-real-file.md#sample)',
      '> ```',
      '',
      'A `code span over',
      '[two lines](missing.md#gone)` and an [escaped](../report\\(1\\).md#results) link.',
      '',
      '[ref]: ../guide.md#set-uq',
    ].join('\n'),
    'src/a.ts': '',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  assert.deepEqual(brokenLinks(dir, Object.keys(files)), [
    'docs/sub/page.md:3: link ../guide.md#the-twelve-members: no heading or anchor in docs/guide.md makes #the-twelve-members',
    'docs/sub/page.md:3: link #nowhere: no heading or anchor in docs/sub/page.md makes #nowhere',
    'docs/sub/page.md:4: link ../old.md#set-up: docs/old.md is not a tracked file or directory',
    'docs/sub/page.md:10: link ../guide.md#set-uq: no heading or anchor in docs/guide.md makes #set-uq',
    'docs/sub/page.md:11: link #gone: no heading or anchor in docs/sub/page.md makes #gone',
  ]);
});

test('every link in this tree\'s tracked Markdown lands on a tracked file and on a heading or anchor', () => {
  assert.deepEqual(brokenLinks(root, trackedFiles(root)), []);
});
