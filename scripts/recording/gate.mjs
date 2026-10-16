#!/usr/bin/env node
// The hosted gallery's gate: what a built viewer (`node apps/viewer/build.mjs`) would publish, checked before it goes
// out. Every entry under recordings/ (a hidden one too) must be a valid recording (validate.mjs, its scan included); a
// recording holds only its manifest, its lines and its blobs, each named by its own SHA-256; every text file published
// is scanned for credential shapes and machine paths; and the gallery embeds exactly the recordings beside it. An empty
// gallery fails.
//
// `node scripts/recording/gate.mjs <dist-dir>`: prints each problem and exits 1, or says what passed.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { credentialIn, validateRecording } from './validate.mjs';

// A blob still being written, `.<sha>.<ext>.tmp-<pid>`, renamed into place when whole: not published, not checked.
const TEMP_BLOB = /^\..*\.tmp-\d+$/;
const BLOB = /^([0-9a-f]{64})\.[a-z0-9]+$/;
const TEXT = /\.(?:html|js|css|json|jsonl|txt|md|csv|svg|xml|yaml|yml|log)$/i;
const GALLERY = 'window.AGENTRUN_GALLERY = ';

/** Every problem with publishing the built viewer at `dist`, each `{ path, message }` with `path` relative to it. */
export function gateProblems(dist) {
  const problems = [];
  const add = (path, message) => problems.push({ path, message });
  const recordings = join(dist, 'recordings');
  const entries = existsSync(recordings) ? readdirSync(recordings, { withFileTypes: true }) : [];
  if (entries.length === 0) add('recordings/', 'holds no recording: an empty gallery is never published');
  for (const entry of entries) {
    const at = `recordings/${entry.name}`;
    if (!entry.isDirectory()) { add(at, 'is not a recording directory'); continue; }
    const dir = join(recordings, entry.name);
    for (const problem of validateRecording(dir)) add(`${at}/${problem.where}${problem.line === undefined ? '' : `:${problem.line}`}`, problem.message);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && (file.name === 'manifest.json' || file.name === 'events.jsonl')) continue;
      if (!file.isDirectory() || file.name !== 'blobs') { add(`${at}/${file.name}`, 'is not part of a recording: only its manifest, its lines and its blobs are published'); continue; }
      for (const blob of readdirSync(join(dir, 'blobs'), { withFileTypes: true })) {
        if (TEMP_BLOB.test(blob.name)) continue;
        const named = BLOB.exec(blob.name);
        if (!blob.isFile() || !named) add(`${at}/blobs/${blob.name}`, 'is not a blob named by its SHA-256');
        else if (createHash('sha256').update(readFileSync(join(dir, 'blobs', blob.name))).digest('hex') !== named[1]) add(`${at}/blobs/${blob.name}`, 'does not hash to its name');
      }
    }
  }
  // Every text file that goes out is scanned: the page, the script, the gallery and every recording's files.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  for (const file of existsSync(dist) ? walk(dist) : []) {
    const found = TEXT.test(file) && !TEMP_BLOB.test(basename(file)) ? credentialIn(readFileSync(file, 'utf8')) : undefined;
    if (found) add(relative(dist, file), `contains a ${found}`);
  }
  // The gallery embeds the recordings beside the page, and no other: what it holds was read from what was checked.
  const galleryFile = join(dist, 'gallery.js');
  const text = existsSync(galleryFile) ? readFileSync(galleryFile, 'utf8') : '';
  let embedded;
  try { embedded = text.startsWith(GALLERY) && text.endsWith(';\n') ? JSON.parse(text.slice(GALLERY.length, -2)).map((entry) => entry.id) : undefined; } catch { embedded = undefined; }
  if (!Array.isArray(embedded)) add('gallery.js', 'is missing or does not hold the gallery');
  else if (JSON.stringify([...embedded].sort()) !== JSON.stringify(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())) {
    add('gallery.js', `embeds ${JSON.stringify(embedded)}, not the recordings beside it`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = process.argv[2];
  if (!dist) { console.error('usage: node scripts/recording/gate.mjs <dist-dir>'); process.exit(2); }
  const problems = gateProblems(dist);
  for (const { path, message } of problems) console.error(`${path}: ${message}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log(`${dist}: ${readdirSync(join(dist, 'recordings')).length} recording(s), every published file checked`);
}
