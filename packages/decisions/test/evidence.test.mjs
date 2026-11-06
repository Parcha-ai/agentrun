// A decision's web evidence is data from pages anyone can write, and it reaches a person's console as links and text,
// and a later prompt as context. Both routes (Parallel's `citations`, OpenRouter's `url_citation` annotations) become
// one shape through one function: an http(s) URL with no credentials or the item is dropped, a title and excerpts as
// plain text with no control characters, each capped, and the whole evidence of a decision capped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parallelCitations, urlCitations } from '../dist/evidence.js';

const asParallel = (items) => parallelCitations(items.map(({ url, title, excerpts }) => ({ url, title, excerpts })));
const asOpenRouter = (items) => urlCitations(items.map(({ url, title, excerpts }) => ({ type: 'url_citation', url_citation: { url, title, content: excerpts[0] } })));
const both = (items) => [['parallel', asParallel(items)], ['openrouter', asOpenRouter(items)]];
const textOf = (evidence) => evidence.reduce((n, e) => n + (e.title ?? '').length + e.excerpts.reduce((m, x) => m + x.length, 0), 0);

test('a URL that is not http(s) drops the item: javascript:, data:, file:, and one that does not parse', () => {
  const items = ['javascript:alert(document.cookie)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'not a url', 'https://ok.example/page']
    .map((url) => ({ url, title: 'T', excerpts: ['x'] }));
  for (const [route, evidence] of both(items)) assert.deepEqual(evidence.map((e) => e.url), ['https://ok.example/page'], route);
});

test('a URL that carries credentials (user:pass@) drops the item', () => {
  for (const [route, evidence] of both([{ url: ['https://user', 'secret@ok.example/a'].join(':'), title: 'T', excerpts: ['x'] }, { url: 'http://ok.example/b', title: 'T', excerpts: ['x'] }])) {
    assert.deepEqual(evidence.map((e) => e.url), ['http://ok.example/b'], route);
  }
});

test('a title and excerpts are plain text: HTML stays literal, control characters go', () => {
  const html = '<img src=x onerror=alert(1)>Widgets</a>';
  for (const [route, [e]] of both([{ url: 'https://ok.example/', title: `${html}\u0000\u001b[31m\u007f`, excerpts: [`line\u0007 one‮`] }])) {
    assert.equal(e.title, `${html}[31m`, `${route}: HTML kept as literal text, control characters stripped`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(e.excerpts[0]), `${route}: no control or bidi characters left`);
  }
});

test('a 1 MB excerpt is cut to the excerpt cap, and a long title to the title cap, each ending in an ellipsis', () => {
  for (const [route, [e]] of both([{ url: 'https://ok.example/', title: 't'.repeat(10_000), excerpts: ['e'.repeat(1024 * 1024)] }])) {
    assert.ok(e.title.length <= 300 && e.title.endsWith('…'), `${route}: title ${e.title.length}`);
    assert.ok(e.excerpts[0].length <= 4096 && e.excerpts[0].endsWith('…'), `${route}: excerpt ${e.excerpts[0].length}`);
  }
});

test('a cut never splits a character', () => {
  for (const [route, [e]] of both([{ url: 'https://ok.example/', title: '😀'.repeat(400), excerpts: ['😀'.repeat(5000)] }])) {
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(e.title + e.excerpts[0]), `${route}: no lone surrogate`);
  }
});

test('the whole evidence of a decision is capped: at most 20 items, 5 excerpts each, 32 KB of text in all', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ url: `https://ok.example/${i}`, title: `Page ${i}`, excerpts: ['w'.repeat(3000)] }));
  for (const [route, evidence] of both(many)) {
    assert.ok(evidence.length <= 20, `${route}: ${evidence.length} items`);
    assert.ok(textOf(evidence) <= 32 * 1024, `${route}: ${textOf(evidence)} characters`);
    assert.deepEqual(evidence.map((e) => e.url), many.slice(0, evidence.length).map((m) => m.url), `${route}: the first ones kept, in order`);
  }
  const [one] = asParallel([{ url: 'https://ok.example/', title: 'T', excerpts: Array.from({ length: 12 }, (_, i) => `passage ${i}`) }]);
  assert.equal(one.excerpts.length, 5, 'at most 5 excerpts an item');
});

test('both routes give the same evidence for the same citations', () => {
  const items = [{ url: 'https://ok.example/a', title: '<b>A</b>', excerpts: ['one'] }, { url: 'javascript:x', title: 'B', excerpts: ['two'] }];
  const [[, parallel], [, openrouter]] = both(items);
  assert.deepEqual(parallel, openrouter);
});

test('a kept URL is the parsed .href: an interior newline, a C0 or bidi character, a space or an upper-case host come out normalized', () => {
  const odd = ['https://ok.example/a\nb', 'https://ok.example/p\u0001q', 'https://ok.example/‮x', 'HTTPS://OK.Example/x', 'https://ok.example/a b'];
  for (const [route, evidence] of both(odd.map((url) => ({ url, title: 'T', excerpts: ['x'] })))) {
    assert.deepEqual(evidence.map((e) => e.url), odd.map((u) => new URL(u).href), route);
  }
});

test('one counting unit, the code point: non-BMP text fills the shared budget exactly, never past it and never short of it', () => {
  const cps = (s) => Array.from(s).length;
  // Ten items: OpenRouter carries one passage an item, so it takes eight of them to reach the budget; Parallel, two.
  const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://ok.example/${i}`, title: '😀'.repeat(300), excerpts: Array.from({ length: 5 }, () => '😀'.repeat(5000)) }));
  for (const [route, evidence] of both(items)) {
    const total = evidence.reduce((n, e) => n + cps(e.title ?? '') + e.excerpts.reduce((m, x) => m + cps(x), 0), 0);
    assert.equal(total, 32 * 1024, `${route}: ${total} code points`);
    assert.ok(evidence.every((e) => cps(e.title ?? '') <= 300 && e.excerpts.every((x) => cps(x) <= 4096)), `${route}: each cap in code points`);
  }
});
