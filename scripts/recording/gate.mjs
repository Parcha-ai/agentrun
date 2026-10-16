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
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { credentialIn, validateRecording } from './validate.mjs';

const BLOB = /^([0-9a-f]{64})\.[a-z0-9]+$/;
const TEXT = /\.(?:html|js|css|json|jsonl|txt|md|csv|svg|xml|yaml|yml|log)$/i;
const GALLERY = 'window.AGENTRUN_GALLERY = ';
/** gallery.js in a build that ships the recordings as files (`build.mjs --files`): it only points at the index. */
const INDEX = "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n";
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A value's JSON with every object's keys sorted, so two copies of one manifest compare equal. */
const canonical = (value) => JSON.stringify(value, (_key, item) => (isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));

/** Every problem with publishing the built viewer at `dist`, each `{ path, message }` with `path` relative to it. */
export function gateProblems(dist) {
  const problems = [];
  const add = (path, message) => problems.push({ path, message });
  const recordings = join(dist, 'recordings');
  // A build that ships the recordings as files keeps its index beside them: the one entry there that is not a recording.
  const galleryFile = join(dist, 'gallery.js');
  const text = existsSync(galleryFile) ? readFileSync(galleryFile, 'utf8') : '';
  const files = text === INDEX;
  const entries = (existsSync(recordings) ? readdirSync(recordings, { withFileTypes: true }) : []).filter((entry) => !(files && entry.isFile() && entry.name === 'index.json'));
  if (!entries.some((entry) => entry.isDirectory())) add('recordings/', 'holds no recording: an empty gallery is never published');
  for (const entry of entries) {
    const at = `recordings/${entry.name}`;
    if (!entry.isDirectory()) { add(at, 'is not a recording directory'); continue; }
    const dir = join(recordings, entry.name);
    for (const problem of validateRecording(dir)) add(`${at}/${problem.where}${problem.line === undefined ? '' : `:${problem.line}`}`, problem.message);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && (file.name === 'manifest.json' || file.name === 'events.jsonl')) continue;
      if (!file.isDirectory() || file.name !== 'blobs') { add(`${at}/${file.name}`, 'is not part of a recording: only its manifest, its lines and its blobs are published'); continue; }
      for (const blob of readdirSync(join(dir, 'blobs'), { withFileTypes: true })) {
        const named = BLOB.exec(blob.name);
        if (!blob.isFile() || !named) add(`${at}/blobs/${blob.name}`, 'is not a blob named by its SHA-256');
        else if (createHash('sha256').update(readFileSync(join(dir, 'blobs', blob.name))).digest('hex') !== named[1]) add(`${at}/blobs/${blob.name}`, 'does not hash to its name');
      }
    }
  }
  // Every text file that goes out is scanned: the page, the script, the gallery and every recording's files.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  for (const file of existsSync(dist) ? walk(dist) : []) {
    const found = TEXT.test(file) ? credentialIn(readFileSync(file, 'utf8')) : undefined;
    if (found) add(relative(dist, file), `contains a ${found}`);
  }
  // The gallery holds the recordings beside the page, and no other, each entry exactly what its files give: the page
  // plays the gallery's copy, so what it plays is what was checked. Embedded in gallery.js, an entry is the recording's
  // manifest, its lines, and each blob's bytes as a data: URL by its SHA-256; in a build that ships the recordings as
  // files, listed in the index gallery.js points at, it is the manifest and each blob's path in the recording's directory.
  const where = files ? 'recordings/index.json' : 'gallery.js';
  let gallery;
  try {
    gallery = files ? JSON.parse(readFileSync(join(recordings, 'index.json'), 'utf8'))
      : text.startsWith(GALLERY) && text.endsWith(';\n') ? JSON.parse(text.slice(GALLERY.length, -2)) : undefined;
  } catch { gallery = undefined; }
  if (!Array.isArray(gallery) || !gallery.every(isObject)) { add(where, 'is missing or does not hold the gallery'); return problems; }
  const beside = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const ids = gallery.map((entry) => entry.id);
  if (canonical([...ids].sort()) !== canonical(beside)) add(where, `${files ? 'lists' : 'embeds'} ${JSON.stringify(ids)}, not the recordings beside it`);
  for (const entry of gallery) {
    if (!beside.includes(entry.id)) continue;
    const dir = join(recordings, entry.id);
    const keys = files ? ['blobs', 'id', 'manifest'] : ['blobs', 'events', 'id', 'manifest'];
    if (canonical(Object.keys(entry).sort()) !== canonical(keys)) add(where, `holds ${JSON.stringify(Object.keys(entry))} for ${entry.id}, not ${JSON.stringify(keys)}`);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { manifest = undefined; }
    if (canonical(entry.manifest) !== canonical(manifest)) add(where, `holds a manifest for ${entry.id} other than its manifest.json`);
    if (!files && (!existsSync(join(dir, 'events.jsonl')) || entry.events !== readFileSync(join(dir, 'events.jsonl'), 'utf8'))) add(where, `holds lines for ${entry.id} other than its events.jsonl`);
    // Every blob in the recording, by the SHA-256 its name gives, and no other.
    const held = new Map((existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')) : []).flatMap((name) => { const named = BLOB.exec(name); return named ? [[named[1], name]] : []; }));
    const blobs = isObject(entry.blobs) ? entry.blobs : {};
    if (canonical(Object.keys(blobs).sort()) !== canonical([...held.keys()].sort())) add(where, `maps ${JSON.stringify(Object.keys(blobs))} for ${entry.id}, not the blobs in its directory ${JSON.stringify([...held.keys()])}`);
    for (const [sha, value] of Object.entries(blobs)) {
      const name = held.get(sha);
      if (!name) continue;
      const data = !files && typeof value === 'string' ? /^data:[^,;]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value) : null;
      const right = files ? value === `blobs/${name}` : data !== null && Buffer.from(data[1], 'base64').equals(readFileSync(join(dir, 'blobs', name)));
      if (!right) add(where, `names ${JSON.stringify(typeof value === 'string' ? value.slice(0, 80) : value)} for ${sha} of ${entry.id}, not that blob in its directory`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = process.argv[2];
  if (!dist) { console.error('usage: node scripts/recording/gate.mjs <dist-dir>'); process.exit(2); }
  const problems = gateProblems(dist);
  for (const { path, message } of problems) console.error(`${path}: ${message}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log(`${dist}: ${readdirSync(join(dist, 'recordings'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length} recording(s), every published file checked`);
}
