// A dropped folder's blobs: a blob: URL has the viewer's origin, so each carries the type the gallery publishes that blob
// with (blobs.ts), never the file's own, and a type that would run in a tab is opaque bytes.
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { test } from 'node:test';
import { fromFiles } from '../src/load.ts';

const SHA = 'a'.repeat(64);

/** The type a dropped blob is read as, and the type of the blob: URL a tab of the viewer would open. */
async function dropped(name: string, body: string, type: string) {
  const recording = await fromFiles([new File(['{}'], 'run/manifest.json'), new File([''], 'run/events.jsonl'), new File([body], `run/blobs/${SHA}.${name}`, { type })]);
  const url = recording.blobUrl(SHA);
  return { read: recording.blobType(SHA), served: url ? resolveObjectURL(url)?.type : undefined };
}

test('a dropped SVG that carries a script is text, never a same-origin image/svg+xml blob: URL', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.document.title = "ran"</script></svg>';
  assert.deepEqual(await dropped('svg', svg, 'image/svg+xml'), { read: 'text/plain', served: 'text/plain' });
});

test('a dropped blob is read as the gallery publishes it: a picture as itself, a page as text, a style sheet as opaque bytes', async () => {
  assert.deepEqual(await dropped('png', 'png', 'image/png'), { read: 'image/png', served: 'image/png' });
  // The URL carries the viewer's type, never the File's own: an empty one, or one that would run.
  assert.deepEqual(await dropped('png', 'png', ''), { read: 'image/png', served: 'image/png' });
  assert.deepEqual(await dropped('png', '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.document.title = "ran"</script></svg>', 'image/svg+xml'), { read: 'image/png', served: 'image/png' });
  assert.deepEqual(await dropped('html', '<script>parent.document.title = "ran"</script>', 'text/html'), { read: 'text/plain', served: 'text/plain' });
  assert.deepEqual(await dropped('css', 'body {}', 'text/css'), { read: 'text/css', served: 'application/octet-stream' });
  assert.deepEqual(await dropped('js', 'parent.document.title = "ran"', 'text/javascript'), { read: 'text/plain', served: 'text/plain' });
});
