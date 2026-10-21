#!/usr/bin/env node
// Which archived SEC URLs a pass's runs asked for the snapshot cache served, and which went live: each URL is asked of
// tools-v2.mjs's own snapshotFetch with a live fetch that only notes it was called, so the cache's rule decides.
//   node examples/learn-classify/eval-cache.mjs <cache dir> <lookup.json> [<lookup.json> ...]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotFetch } from './tools-v2.mjs';

/** For each URL, hit when the cache answered it (its pinned bytes, or a redirect to its pinned time), miss when it would
 *  have gone to the archive. */
export async function cacheHits({ dir, urls }) {
  const byUrl = {};
  for (const url of [...new Set(urls)]) {
    let live = false;
    const cached = snapshotFetch({ dir, retries: 0, fetch: async () => { live = true; return new Response(null, { status: 599 }); } });
    await cached(url, {});
    byUrl[url] = live ? 'miss' : 'hit';
  }
  const values = Object.values(byUrl);
  return { hits: values.filter((v) => v === 'hit').length, misses: values.filter((v) => v === 'miss').length, byUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, ...files] = process.argv.slice(2);
  if (!dir || !files.length) { console.error('usage: eval-cache.mjs <cache dir> <lookup.json> [<lookup.json> ...]'); process.exit(2); }
  const urls = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).runs.flatMap((r) => r.archivedUrls ?? []));
  const result = await cacheHits({ dir, urls });
  process.stdout.write(`${JSON.stringify({ urls: urls.length, distinct: Object.keys(result.byUrl).length, ...result })}\n`);
}
