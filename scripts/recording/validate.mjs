#!/usr/bin/env node
// Checks a recording directory against agentrun.recording/1: the manifest, every line of events.jsonl, the three ordering
// invariants, the blobs the lines name (present, and named by their own SHA-256), and that nothing in it looks like a
// credential. It reports the first problem with its line number.
//
// `node scripts/recording/validate.mjs <recording-dir>`
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORMAT = 'agentrun.recording/1';
export const SOURCES = ['workflow', 'pi', 'browser', 'vision', 'transport', 'host'];
const CHANNELS = ['durable', 'live'];
const SHA256 = /^[0-9a-f]{64}$/;

// The credential shapes the package check and the source export refuse (scripts/export-source.mjs), with the machine paths.
const FORBIDDEN = [
  ['machine path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['aws access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['bearer secret', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['literal credential', /(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[=:]\s*['"][^'"\n]{8,}['"]/i],
];
export const credentialIn = text => FORBIDDEN.find(([, pattern]) => pattern.test(text))?.[0];
/** The credential shape in any string or key of a decoded JSON value: the raw text can hide one behind an escape (`\u0073k-`). */
export function credentialInValue(value) {
  if (typeof value === 'string') return credentialIn(value);
  if (Array.isArray(value)) { for (const inner of value) { const found = credentialInValue(inner); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, inner] of Object.entries(value)) { const found = credentialIn(key) ?? credentialInValue(inner); if (found) return found; } }
  return undefined;
}
const TEXT_BLOB = /^(?:json|jsonl|txt|md|html|csv|svg|xml|yaml|yml|log)$/i;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = value => Number.isInteger(value);
const isIso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && !Number.isNaN(Date.parse(value));
const nullableNumber = value => value === null || (typeof value === 'number' && Number.isFinite(value));

/** The problems with a manifest, as strings. */
export function manifestProblems(manifest) {
  if (!isObject(manifest)) return ['manifest.json is not an object'];
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(`manifest.${what}`); };
  need(manifest.format === FORMAT, `format is ${JSON.stringify(manifest.format)}, expected ${FORMAT}`);
  need(typeof manifest.title === 'string' && manifest.title !== '', 'title is not a non-empty string');
  need(typeof manifest.task === 'string' && manifest.task !== '', 'task is not a non-empty string');
  need(isObject(manifest.recorded) && isIso(manifest.recorded.started) && isIso(manifest.recorded.ended), 'recorded needs ISO 8601 started and ended');
  need(isObject(manifest.recorded) && Date.parse(manifest.recorded.ended) >= Date.parse(manifest.recorded.started), 'recorded.ended is before recorded.started');
  need(isObject(manifest.code) && typeof manifest.code.repo === 'string' && typeof manifest.code.commit === 'string', 'code needs repo and commit strings');
  need(isObject(manifest.code) && isObject(manifest.code.packages) && Object.values(manifest.code.packages).every(version => typeof version === 'string'), 'code.packages is not a map of name to version');
  // The pi packages the run loaded are listed beside ours: the pi lines are theirs.
  need(isObject(manifest.code) && isObject(manifest.code.packages) && ['@earendil-works/pi-durable', '@earendil-works/pi-ai'].every(name => typeof manifest.code.packages[name] === 'string'), 'code.packages must list @earendil-works/pi-durable and @earendil-works/pi-ai');
  need(typeof manifest.model === 'string' && manifest.model !== '', 'model is not a non-empty string');
  need(isInt(manifest.generations) && manifest.generations >= 1, 'generations is not an integer of at least 1');
  need(isInt(manifest.kills) && manifest.kills >= 0, 'kills is not a non-negative integer');
  need(isObject(manifest.cost) && nullableNumber(manifest.cost.usd) && isObject(manifest.cost.parts) && Object.values(manifest.cost.parts).every(nullableNumber), 'cost needs usd and parts, each a number or null');
  need(isObject(manifest.source) && typeof manifest.source.run === 'string' && SHA256.test(manifest.source.store_sha256 ?? ''), 'source needs run and a 64-hex store_sha256');
  if (manifest.providers !== undefined) need(manifest.providers === 'real' || manifest.providers === 'scripted', `providers is ${JSON.stringify(manifest.providers)}, expected real or scripted`);
  if (manifest.result !== undefined) need(isObject(manifest.result) && SHA256.test(manifest.result.blob ?? '') && typeof manifest.result.title === 'string', 'result needs a 64-hex blob and a title');
  return problems;
}

/** The problems with one parsed line, as strings (not its place among the others). */
export function lineProblems(event) {
  if (!isObject(event)) return ['the line is not an object'];
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(what); };
  need(CHANNELS.includes(event.channel), `channel is ${JSON.stringify(event.channel)}, expected durable or live`);
  need(SOURCES.includes(event.source), `source is ${JSON.stringify(event.source)}, expected one of ${SOURCES.join(', ')}`);
  need(typeof event.kind === 'string' && event.kind !== '', 'kind is not a non-empty string');
  // A durable line has no `gen` before the earliest surviving driver revision; a live line always has the process's.
  // A durable line has no `gen` before the earliest surviving driver revision, and the supervisor's host lines have none
  // (no run process wrote them); every other line carries the process's.
  need(event.gen === undefined && (event.channel === 'durable' || event.source === 'host') || isInt(event.gen) && event.gen >= 1, 'gen is not an integer of at least 1');
  need(typeof event.t === 'number' && Number.isFinite(event.t) && event.t >= 0, 't is not a non-negative number');
  need('data' in event && event.data !== undefined, 'data is missing');
  if (event.channel === 'durable') {
    need(isInt(event.commit) && event.commit >= 0, 'a durable line needs an integer commit');
    need(isInt(event.order) && event.order >= 0, 'a durable line needs an integer order');
    need(event.seq === undefined, 'a durable line has no seq');
    need(event.snapshot === undefined || event.snapshot === true, 'snapshot is not true');
  } else if (event.channel === 'live') {
    need(isInt(event.seq) && event.seq >= 0, 'a live line needs an integer seq');
    need(event.commit === undefined && event.order === undefined && event.snapshot === undefined, 'a live line has no commit, order or snapshot');
  }
  if (event.path !== undefined) need(typeof event.path === 'string', 'path is not a string');
  if (event.conv !== undefined) need(isInt(event.conv), 'conv is not an integer');
  if (event.blobs !== undefined) need(Array.isArray(event.blobs) && event.blobs.every(hash => SHA256.test(hash)), 'blobs is not a list of 64-hex hashes');
  return problems;
}

/** Image data left inline in a line, by its structure: an image block that still holds `data`, or a data: URL that says it
 *  is an image. Long base64 anywhere else is data (a store's chunk, a checkpoint), however long. */
export function inlineImage(value) {
  if (Array.isArray(value)) return value.some(inlineImage);
  if (typeof value === 'string') return /^data:image\//.test(value);
  if (!isObject(value)) return false;
  if (value.type === 'image' && typeof value.data === 'string') return true;
  return Object.values(value).some(inlineImage);
}

/** The blob hashes named by image blocks inside a line's data. */
export function imageBlobs(value, found = []) {
  if (Array.isArray(value)) value.forEach(inner => imageBlobs(inner, found));
  else if (isObject(value)) {
    if (value.type === 'image') found.push(value.blob);
    Object.values(value).forEach(inner => imageBlobs(inner, found));
  }
  return found;
}

/** The records of a `transport.moves` document value, found as the value or nested in it. Every record carries a top-level `head`: the
 *  sequence the target's first new commit takes, after any replay. A move also has `seal { head }`, which must equal it; a restore has
 *  `checkpoint { head }` and, when it replayed the host's log, `replayed { from, to }` with `head` = `to + 1`. */
export function moveRecords(value, found = []) {
  if (Array.isArray(value)) value.forEach(inner => moveRecords(inner, found));
  else if (isObject(value)) {
    if (value.kind === 'restore' || value.kind === 'move') found.push({ kind: value.kind, head: value.head, seal: value.seal, checkpoint: value.checkpoint, replayed: value.replayed });
    else Object.values(value).forEach(inner => moveRecords(inner, found));
  }
  return found;
}

const blobFiles = dir => {
  const folder = join(dir, 'blobs');
  const files = existsSync(folder) ? readdirSync(folder) : [];
  return new Map(files.map(file => [file.split('.')[0], join(folder, file)]));
};

/** Every problem in the recording at `dir`, in file order: `{ where, line?, message }`. */
export function validateRecording(dir) {
  const problems = [];
  const add = (where, message, line) => problems.push({ where, ...(line === undefined ? {} : { line }), message });
  const manifestPath = join(dir, 'manifest.json');
  const eventsPath = join(dir, 'events.jsonl');
  let manifest;
  if (!existsSync(manifestPath)) add('manifest.json', 'is missing');
  else {
    const text = readFileSync(manifestPath, 'utf8');
    try { manifest = JSON.parse(text); } catch (error) { add('manifest.json', `is not JSON: ${error.message}`); }
    if (manifest !== undefined) for (const message of manifestProblems(manifest)) add('manifest.json', message);
    const found = credentialIn(text) ?? (manifest === undefined ? undefined : credentialInValue(manifest));
    if (found) add('manifest.json', `contains a ${found}`);
  }
  const blobs = blobFiles(dir);
  const checked = new Set();
  const checkBlob = (hash, where, line) => {
    if (checked.has(hash)) return;
    checked.add(hash);
    const file = blobs.get(hash);
    if (!file) return add(where, `names blob ${hash}, which is not in blobs/`, line);
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) add(where, `blob ${hash} does not hash to its name`, line);
    // A blob is kept whole and shared with the recording, so its text is checked as the lines are: raw, and decoded when it is JSON.
    if (TEXT_BLOB.test(file.slice(file.lastIndexOf('.') + 1))) {
      const text = bytes.toString('utf8');
      let found = credentialIn(text);
      if (!found) { try { found = credentialInValue(JSON.parse(text)); } catch { /* not one JSON value */ } }
      if (found) add(where, `blob ${hash} contains a ${found}`, line);
    }
  };
  if (manifest?.result?.blob) checkBlob(manifest.result.blob, 'manifest.json', undefined);
  if (!existsSync(eventsPath)) { add('events.jsonl', 'is missing'); return problems; }
  const lines = readFileSync(eventsPath, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let lastCommit = -Infinity;
  let lastGen = -Infinity;
  let last = { commit: -Infinity, order: -Infinity };
  let lastT = -Infinity;
  const lastSeq = new Map();
  // The process a line belongs to is the latest one the supervisor started before it (3.2): a snapshot's `gen` is an earlier process's, so
  // a restore is matched by process, never by generation value.
  let processIndex = 0;
  const snapshotted = new Set();
  const snapshotAt = new Map();
  const firstCommit = new Map();
  const records = [];
  const drops = [];
  let processes = 0;
  const liveGenerations = new Set();
  lines.forEach((text, index) => {
    const line = index + 1;
    if (text.trim() === '') return add('events.jsonl', 'has an empty line', line);
    let event;
    try { event = JSON.parse(text); } catch (error) { return add('events.jsonl', `is not JSON: ${error.message}`, line); }
    const found = credentialIn(text) ?? credentialInValue(event);
    if (found) add('events.jsonl', `contains a ${found}`, line);
    const own = lineProblems(event);
    for (const message of own) add('events.jsonl', message, line);
    if (own.length) return;
    if (event.source === 'host' && event.kind === 'process.started') { processes += 1; processIndex += 1; }
    if (event.channel === 'durable' && (event.kind === 'transport.moves' || event.data?.doc === 'transport.moves')) {
      // A snapshot restates the records an earlier process wrote: only a process's own lines are its moves.
      if (!event.snapshot) for (const record of moveRecords(event.data?.value ?? event.data)) {
        if (!isInt(record.head)) add('events.jsonl', `a ${record.kind} record has no integer head`, line);
        else records.push({ ...record, process: processIndex, line, commit: event.commit });
      }
    }
    if (event.channel === 'durable' && !event.snapshot && !firstCommit.has(processIndex)) firstCommit.set(processIndex, event.commit);
    if (event.channel === 'live' && event.gen !== undefined) liveGenerations.add(event.gen);
    if (inlineImage(event.data)) add('events.jsonl', 'holds image data inline; an image belongs in blobs/ and its block keeps { type, mimeType, blob }', line);
    for (const hash of imageBlobs(event.data)) {
      if (!SHA256.test(hash ?? '')) add('events.jsonl', 'an image block has no 64-hex blob', line);
      else if (!(event.blobs ?? []).includes(hash)) add('events.jsonl', `an image block names blob ${hash}, which the line's blobs does not list`, line);
    }
    if (event.t < lastT) add('events.jsonl', `t ${event.t} is before the previous line's ${lastT}`, line);
    lastT = Math.max(lastT, event.t);
    if (event.channel === 'durable' && event.gen !== undefined) {
      // A durable line's gen is the driver's, so it never decreases, outside a restore (3.2), whose snapshot starts the generation again.
      const restores = event.snapshot && !snapshotted.has(processIndex) && event.commit < lastCommit;
      if (event.gen < lastGen && !restores) add('events.jsonl', `durable gen ${event.gen} is lower than the previous durable line's ${lastGen}`, line);
      lastGen = restores ? event.gen : Math.max(lastGen, event.gen);
    }
    if (event.channel === 'durable' && event.snapshot) {
      // A snapshot is state at the store's latest commit when its process opened: never below an earlier line's commit, except
      // at a process's first snapshot after a restore (3.2), which is accepted only with that process's restore record, written after it.
      const proc = processIndex;
      if (!snapshotted.has(proc)) {
        snapshotted.add(proc);
        snapshotAt.set(proc, { commit: event.commit, line, before: lastCommit });
        if (event.commit < lastCommit) {
          drops.push({ line, process: proc, commit: event.commit, was: lastCommit });
          last = { commit: event.commit, order: Infinity };
          lastCommit = event.commit;
        }
      } else if (event.commit < lastCommit) add('events.jsonl', `snapshot commit ${event.commit} is lower than an earlier durable line's ${lastCommit}`, line);
      lastCommit = Math.max(lastCommit, event.commit);
    } else if (event.channel === 'durable') {
      if (event.commit < lastCommit) add('events.jsonl', `commit ${event.commit} is lower than the previous durable line's ${lastCommit}`, line);
      if (event.commit < last.commit || (event.commit === last.commit && event.order <= last.order)) add('events.jsonl', `(commit, order) (${event.commit}, ${event.order}) does not increase past (${last.commit}, ${last.order})`, line);
      lastCommit = Math.max(lastCommit, event.commit);
      last = { commit: event.commit, order: event.order };
    } else {
      // seq is numbered per generation, and the supervisor's gen-less lines number a space of their own.
      const space = event.gen ?? 'supervisor';
      const before = lastSeq.get(space);
      if (before !== undefined && event.seq <= before) add('events.jsonl', `seq ${event.seq} does not increase past ${before} in ${event.gen === undefined ? 'the supervisor\'s lines' : `generation ${event.gen}`}`, line);
      lastSeq.set(space, event.seq);
    }
    for (const hash of event.blobs ?? []) checkBlob(hash, 'events.jsonl', line);
  });
  // A restore or a move names the head of the store its target generation opened, anchored on that generation's snapshot at open
  // (the store's latest commit then). A generation with no snapshot (a bare export) skips the continuity check.
  for (const drop of drops) {
    const found = records.filter(record => record.kind === 'restore' && record.process === drop.process && record.line > drop.line && record.head === drop.commit + 1);
    if (!found.length) add('events.jsonl', `process ${drop.process}'s first snapshot is at commit ${drop.commit}, below the ${drop.was} already seen, and the process has no transport.moves restore record after it with checkpoint head ${drop.commit + 1}`, drop.line);
  }
  for (const record of records) {
    const snapshot = snapshotAt.get(record.process);
    if (record.kind === 'move' && record.seal?.head !== record.head) add('events.jsonl', `a move's head is ${record.head}, but its seal.head is ${JSON.stringify(record.seal?.head)}; they are equal`, record.line);
    if (record.kind === 'restore' && record.replayed && !(isInt(record.replayed.to) && record.head === record.replayed.to + 1)) add('events.jsonl', `a restore that replayed to ${JSON.stringify(record.replayed.to)} has head ${record.head}, which should be replayed.to + 1`, record.line);
    if (record.kind === 'restore' && !record.replayed && record.head !== record.checkpoint?.head) add('events.jsonl', `a restore with no replay has head ${record.head}, but its checkpoint.head is ${JSON.stringify(record.checkpoint?.head)}`, record.line);
    if (record.commit < record.head) add('events.jsonl', `a ${record.kind} record at commit ${record.commit} names head ${record.head}, which is a later commit`, record.line);
    if (!snapshot) continue;
    if (record.head !== snapshot.commit + 1) add('events.jsonl', `a ${record.kind}'s head is ${record.head}, but the process's snapshot is at commit ${snapshot.commit}, so the target's first commit would be ${snapshot.commit + 1}`, record.line);
    // A move keeps one store: its snapshot is at the highest commit seen. A restore may drop (checked above) or replay and not.
    else if (record.kind === 'move' && Number.isFinite(snapshot.before) && snapshot.commit !== snapshot.before) add('events.jsonl', `a move's snapshot is at commit ${snapshot.commit}, but the highest commit seen before it is ${snapshot.before}; a move keeps one store, so they are equal`, snapshot.line);
    else if (firstCommit.has(record.process) && firstCommit.get(record.process) !== record.head) add('events.jsonl', `a ${record.kind}'s head is ${record.head}, but the process's first commit is ${firstCommit.get(record.process)}`, record.line);
  }
  // Processes come from the supervisor, never from a durable line's gen: that counts journal opens, which can outnumber processes.
  if (manifest && isInt(manifest.generations)) {
    if (processes !== manifest.generations) add('manifest.json', `generations is ${manifest.generations}, but the recording has ${processes} host process.started lines`);
    const beyond = [...liveGenerations].filter(gen => gen > processes);
    if (beyond.length) add('events.jsonl', `a live line carries gen ${Math.max(...beyond)}, beyond the ${processes} processes that started`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/recording/validate.mjs <recording-dir>'); process.exit(2); }
  const problems = validateRecording(dir);
  if (problems.length === 0) console.log(`${dir}: a valid ${FORMAT} recording`);
  else {
    const [first] = problems;
    console.error(`${dir}: ${first.where}${first.line === undefined ? '' : `:${first.line}`} ${first.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
    process.exitCode = 1;
  }
}
