#!/usr/bin/env node
// The hosted gallery's recordings live outside git: one tar on the repository's release tagged `gallery`, named with its
// SHA-256 and the gallery's ids, in order, by apps/viewer/recordings.lock.json. The Pages job fetches the tar and
// unpacks it into apps/viewer/recordings before the build; nothing is written unless all of it passes:
//
// - the tar hashes to the lock's SHA-256;
// - it holds only directories and regular files (no link, device or other entry), each at `<id>/manifest.json`,
//   `<id>/events.jsonl` or `<id>/blobs/<sha256>.<ext>` of an id the lock names, once each;
// - it holds exactly the lock's ids, each with its manifest and its lines;
// - no recording is over 40 MB and the gallery is not over 150 MB;
// - a poster is an image blob (PNG, JPEG, WebP or GIF, by its bytes) of the recording it is the poster of;
// - the directory it unpacks into holds no recording already.
//
// The build and the gate (gate.mjs) then run as on any recordings.
//
// `node scripts/recording/gallery.mjs fetch <lock> <dir>`: download the lock's asset with `gh` (the job's token in
// GH_TOKEN), check it and unpack it. `--from <tar>` checks and unpacks a tar already here instead.
// `node scripts/recording/gallery.mjs pack <dir> <lock> <tar>`: write the tar of the lock's ids from `dir` (sorted, owner
// and time zeroed, so the same recordings make the same bytes) and the lock's new SHA-256.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The release the asset is on: a tag no release workflow reads (they read `v*`). */
export const RELEASE = 'gallery';
export const RECORDING_LIMIT = 40_000_000;
export const GALLERY_LIMIT = 150_000_000;

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/;
const MEMBER = /^([a-z0-9][a-z0-9._-]{0,63})\/(?:(manifest\.json|events\.jsonl)|blobs\/([0-9a-f]{64})\.([a-z0-9]{1,8}))$/;
const IMAGE = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46] };
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The lock, read: `{ asset, sha256, ids: [{ id, poster? }] }` (a plain id reads as `{ id }`), or its problems. */
export function readLock(text) {
  let lock;
  try { lock = JSON.parse(text); } catch (error) { return { problems: [`the lock is not JSON: ${error.message}`] }; }
  const problems = [];
  if (!isObject(lock)) return { problems: ['the lock is not an object'] };
  if (typeof lock.asset !== 'string' || !ASSET.test(lock.asset)) problems.push(`asset ${JSON.stringify(lock.asset)} is not a .tar file name`);
  if (typeof lock.sha256 !== 'string' || !SHA256.test(lock.sha256)) problems.push(`sha256 ${JSON.stringify(lock.sha256)} is not a SHA-256`);
  if (!Array.isArray(lock.ids) || lock.ids.length === 0) problems.push('ids is not a non-empty list');
  const ids = (Array.isArray(lock.ids) ? lock.ids : []).map((each) => (typeof each === 'string' ? { id: each } : each));
  const seen = new Set();
  for (const each of ids) {
    if (!isObject(each) || typeof each.id !== 'string' || !ID.test(each.id)) { problems.push(`${JSON.stringify(each)} is not { id, poster? } with a plain id`); continue; }
    if (seen.has(each.id)) problems.push(`${each.id} is listed twice`);
    seen.add(each.id);
    if (Object.keys(each).some((key) => key !== 'id' && key !== 'poster')) problems.push(`${each.id} holds ${JSON.stringify(Object.keys(each))}, not id and poster`);
    if (each.poster !== undefined && (typeof each.poster !== 'string' || !SHA256.test(each.poster))) problems.push(`${each.id}'s poster ${JSON.stringify(each.poster)} is not a SHA-256`);
  }
  return problems.length ? { problems } : { lock: { asset: lock.asset, sha256: lock.sha256, ids } };
}

const field = (block, at, length) => {
  const bytes = block.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? length : end).toString('utf8');
};
const octal = (block, at, length) => {
  const text = field(block, at, length).trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
};

/** The entries of a tar (ustar, with GNU long names and pax path records): each `{ path, type, data }`, `type` its
 *  type flag. Throws on a header whose checksum fails or a tar cut short. */
export function readTar(bytes) {
  const entries = [];
  let at = 0;
  let longName;
  let paxPath;
  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) return entries;
    const sum = block.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== octal(block, 148, 8)) throw new Error(`the header at byte ${at} fails its checksum`);
    const size = octal(block, 124, 12);
    if (!Number.isSafeInteger(size)) throw new Error(`the header at byte ${at} gives no size`);
    const type = String.fromCharCode(block[156] || 48);
    if (at + 512 + size > bytes.length) throw new Error(`the entry at byte ${at} runs past the end`);
    const data = bytes.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'x') {
      for (const record of data.toString('utf8').split('\n')) {
        const kv = /^\d+ path=(.*)$/.exec(record);
        if (kv) paxPath = kv[1];
      }
      continue;
    }
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = paxPath = undefined;
    entries.push({ path, type, data });
  }
  throw new Error('the tar ends without its end-of-archive blocks');
}

/** A tar of `files` (each `{ path, data }`, sorted by path), every header ustar with owner 0 and time 0. */
export function writeTar(files) {
  const blocks = [];
  const header = (path, size, type) => {
    const block = Buffer.alloc(512);
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(path) > 100) {
      const cut = path.lastIndexOf('/', 155);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
      if (cut < 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`${path} is too long for a ustar header`);
    }
    block.write(name, 0);
    block.write(type === '5' ? '0000755\0' : '0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write('        ', 148);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.write(prefix, 345);
    const sum = block.reduce((total, byte) => total + byte, 0);
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const dirs = new Set();
  for (const { path, data } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const dir = `${parts.slice(0, n).join('/')}/`;
      if (!dirs.has(dir)) { dirs.add(dir); blocks.push(header(dir, 0, '5')); }
    }
    blocks.push(header(path, data.length, '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** What the tar `bytes` would unpack to under `lock`, as `{ files, problems }`: `files` each `{ id, path, data }` and only
 *  when there is no problem. `limits`: the most a recording and the gallery may hold, in bytes. */
export function galleryOf(bytes, lock, limits = {}) {
  const { recording: recordingLimit = RECORDING_LIMIT, gallery: galleryLimit = GALLERY_LIMIT } = limits;
  const problems = [];
  const digest = sha256(bytes);
  if (digest !== lock.sha256) return { problems: [`the asset hashes to ${digest}, not the lock's ${lock.sha256}`] };
  let entries;
  try { entries = readTar(bytes); } catch (error) { return { problems: [`the asset is not a tar: ${error.message}`] }; }
  const wanted = new Map(lock.ids.map((each) => [each.id, each]));
  const files = [];
  const seen = new Set();
  const sizes = new Map();
  for (const entry of entries) {
    const path = entry.path.replace(/^\.\//, '');
    if (entry.type === '5') {
      const dir = path.replace(/\/$/, '');
      if (dir === '' || dir === '.' || (/^[a-z0-9][a-z0-9._-]{0,63}(\/blobs)?$/.test(dir) && wanted.has(dir.split('/')[0]))) continue;
      problems.push(`${entry.path}: is a directory outside a listed recording`);
      continue;
    }
    if (entry.type !== '0') { problems.push(`${entry.path}: is not a regular file (type ${JSON.stringify(entry.type)})`); continue; }
    const member = MEMBER.exec(path);
    if (!member || !wanted.has(member[1])) { problems.push(`${entry.path}: is not a manifest, lines or blob of a recording the lock lists`); continue; }
    if (seen.has(path)) { problems.push(`${entry.path}: is in the asset twice`); continue; }
    seen.add(path);
    sizes.set(member[1], (sizes.get(member[1]) ?? 0) + entry.data.length);
    files.push({ id: member[1], path, data: entry.data });
  }
  for (const { id, poster } of lock.ids) {
    if (!seen.has(`${id}/manifest.json`) || !seen.has(`${id}/events.jsonl`)) problems.push(`${id}: the asset holds no ${seen.has(`${id}/manifest.json`) ? 'events.jsonl' : 'manifest.json'} for it`);
    if ((sizes.get(id) ?? 0) > recordingLimit) problems.push(`${id}: is ${sizes.get(id)} bytes, over the ${recordingLimit} a recording may be`);
    if (poster === undefined) continue;
    const blob = files.find((file) => file.id === id && file.path.startsWith(`${id}/blobs/${poster}.`));
    const ext = blob?.path.split('.').at(-1);
    const magic = ext ? IMAGE[ext] : undefined;
    const image = blob && magic && magic.every((byte, index) => blob.data[index] === byte) && (ext !== 'webp' || blob.data.subarray(8, 12).toString('latin1') === 'WEBP');
    if (!image) problems.push(`${id}: its poster ${poster} is not an image blob it holds`);
  }
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (total > galleryLimit) problems.push(`the gallery is ${total} bytes, over the ${galleryLimit} it may be`);
  return problems.length ? { problems } : { files };
}

/** Unpack `bytes` under `lock` into `dir`, or return the problems and write nothing. `dir` may hold files (its README)
 *  but no directory: a recording already there would be built into the gallery unchecked. */
export function unpackGallery(bytes, lock, dir, limits = {}) {
  const there = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  if (there.length) return [`${dir} already holds ${JSON.stringify(there)}: the gallery unpacks into a directory with no recording`];
  const { files, problems } = galleryOf(bytes, lock, limits);
  if (problems) return problems;
  for (const file of files) {
    mkdirSync(join(dir, file.path, '..'), { recursive: true });
    writeFileSync(join(dir, file.path), file.data, { flag: 'wx' });
  }
  return [];
}

/** The tar of the lock's ids from `dir`: each one's manifest, lines and blobs, and nothing else. */
export function packGallery(dir, lock) {
  const files = [];
  for (const { id } of lock.ids) {
    for (const name of ['manifest.json', 'events.jsonl']) files.push({ path: `${id}/${name}`, data: readFileSync(join(dir, id, name)) });
    const blobs = join(dir, id, 'blobs');
    for (const name of existsSync(blobs) ? readdirSync(blobs).sort() : []) {
      if (!statSync(join(blobs, name)).isFile() || !MEMBER.test(`${id}/blobs/${name}`)) throw new Error(`${id}/blobs/${name} is not a blob named by its SHA-256`);
      files.push({ path: `${id}/blobs/${name}`, data: readFileSync(join(blobs, name)) });
    }
  }
  return writeTar(files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const fail = (lines) => { for (const line of lines) console.error(line); process.exit(1); };
  if (command === 'fetch' && (rest.length === 2 || (rest.length === 4 && rest[2] === '--from'))) {
    const [lockPath, dir, , from] = rest;
    const { lock, problems } = readLock(readFileSync(lockPath, 'utf8'));
    if (problems) fail(problems.map((problem) => `${lockPath}: ${problem}`));
    let tar = from;
    if (!tar) {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) fail(['GITHUB_REPOSITORY names no repository to fetch the gallery from']);
      const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'gallery-'));
      tar = join(scratch, lock.asset);
      // The job's own token (GH_TOKEN) with contents: read; no shell between the lock and the command.
      execFileSync('gh', ['release', 'download', RELEASE, '--repo', repo, '--pattern', lock.asset, '--output', tar], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
    // Read whole only when it could be a gallery the limit allows: every entry adds a header and its padding.
    if (statSync(tar).size > 2 * GALLERY_LIMIT) fail([`${lock.asset} is ${statSync(tar).size} bytes, more than a gallery of ${GALLERY_LIMIT} could be`]);
    const unpacked = unpackGallery(readFileSync(tar), lock, dir);
    if (!from) rmSync(join(tar, '..'), { recursive: true, force: true });
    if (unpacked.length) fail(unpacked);
    console.log(`${dir}: ${lock.ids.length} recording(s) from ${lock.asset} (${lock.sha256.slice(0, 12)})`);
  } else if (command === 'pack' && rest.length === 3) {
    const [dir, lockPath, out] = rest;
    const { lock, problems } = readLock(readFileSync(lockPath, 'utf8'));
    if (problems) fail(problems.map((problem) => `${lockPath}: ${problem}`));
    const tar = packGallery(dir, lock);
    const packed = { ...lock, sha256: sha256(tar) };
    const checked = galleryOf(tar, packed);
    if (checked.problems) fail(checked.problems);
    writeFileSync(out, tar);
    writeFileSync(lockPath, `${JSON.stringify({ asset: lock.asset, sha256: packed.sha256, ids: lock.ids }, null, 2)}\n`);
    console.log(`${out}: ${lock.ids.length} recording(s), ${tar.length} bytes, sha256 ${packed.sha256}`);
  } else {
    console.error('usage: node scripts/recording/gallery.mjs fetch <lock> <dir> [--from <tar>]\n       node scripts/recording/gallery.mjs pack <dir> <lock> <tar>');
    process.exit(2);
  }
}
