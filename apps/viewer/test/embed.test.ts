// Embed mode (`?embed=1`): the page is its frame's, and it tells the framing page which chapter the point is in. The
// message carries only that chapter's title and stop, goes to the parent's origin when the browser says it, and the
// viewer acts on no message it is sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterAt, chapterMessage, parentOrigin } from '../src/app.ts';

test('the chapter a point is in is the last one whose stop is at or before it', () => {
  const chapters = [{ p: 1 }, { p: 10 }, { p: 25 }];
  assert.deepEqual([0, 1, 9, 10, 24, 25, 99].map((p) => chapterAt(chapters, p)), [-1, 0, 0, 1, 1, 2, 2]);
});

test('the message is the chapter alone: its title and its stop', () => {
  assert.deepEqual(chapterMessage({ title: 'killed: cut', p: 12, focus: '/root/steps/1' } as { title: string; p: number }),
    { source: 'agentrun-viewer', type: 'chapter', title: 'killed: cut', stop: 12 });
});

test('it targets the framing page\'s origin when the browser says it, an http one; else any', () => {
  assert.equal(parentOrigin('https://parcha-ai.github.io', ''), 'https://parcha-ai.github.io');
  assert.equal(parentOrigin(undefined, 'https://example.org/blog/post?x=1'), 'https://example.org');
  assert.equal(parentOrigin('file://', 'file:///tmp/page.html'), '*');
  assert.equal(parentOrigin(undefined, ''), '*');
});
