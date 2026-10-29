// The provenance of code copied from vercel-labs/durable-harness, checked offline: for each package that carries
// vendor/durable-harness/UPSTREAM.json, every recorded file has its pristine upstream copy under
// vendor/durable-harness/upstream/<upstream path> (never shipped) whose git blob and sha256 are the recorded ones, and our
// copy at the recorded path opens with the header naming that upstream path. A record of kind "interfaces matched" is a
// file written for AgentRun that keeps a few upstream declarations (it names them), so the copied files compile against
// them: its pristine file and header are checked the same way, and each named declaration is compared with upstream's,
// comments, whitespace and quote style aside: an interface's members are some of upstream's, each exactly as upstream
// declares it, and a class's body is upstream's.
// `--diff` also prints, per copied file, how many lines our copy changes against the pristine one (the reviewable
// change). Exits non-zero with the problems.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRISTINE_DIR, UPSTREAM, UPSTREAM_FILE } from './upstream-attribution.mjs';

/** A file's git blob id, as `git hash-object` computes it. */
export const gitBlob = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

/** Problems for one package directory; empty passes. */
export async function provenanceProblems(dir) {
  const problems = [];
  let upstream;
  try { upstream = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8')); } catch { return [`${UPSTREAM_FILE} is missing or not JSON`]; }
  if (upstream.commit !== UPSTREAM.commit) problems.push(`${UPSTREAM_FILE} commit ${upstream.commit} is not ${UPSTREAM.commit}`);
  for (const [path, record] of Object.entries(upstream.files ?? {})) {
    const pristine = await readFile(join(dir, PRISTINE_DIR, record.upstream)).catch(() => undefined);
    if (!pristine) { problems.push(`${path}: no pristine copy at ${PRISTINE_DIR}${record.upstream}`); continue; }
    if (gitBlob(pristine) !== record.blob) problems.push(`${path}: the pristine copy's git blob is ${gitBlob(pristine)}, not the recorded ${record.blob}`);
    const sha = createHash('sha256').update(pristine).digest('hex');
    if (sha !== record.sha256) problems.push(`${path}: the pristine copy's sha256 is ${sha}, not the recorded ${record.sha256}`);
    const ours = await readFile(join(dir, path), 'utf8').catch(() => undefined);
    if (ours === undefined) { problems.push(`${path}: our copy is missing`); continue; }
    const { head } = headerOf(ours);
    if (!head[0]?.startsWith('// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0')) problems.push(`${path}: line 1 is not Vercel's copyright header`);
    if (!head[1]?.startsWith(`// From github.com/vercel-labs/durable-harness, ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`)) problems.push(`${path}: line 2 does not name ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`);
    if (!head[2]?.startsWith('// Changed by Parcha, ')) problems.push(`${path}: line 3 is not the "Changed by Parcha" line`);
    if (record.kind === MATCHED) {
      if (!Array.isArray(record.declarations) || !record.declarations.length) problems.push(`${path}: an "${MATCHED}" record names no declarations`);
      for (const name of record.declarations ?? []) {
        const mine = declaration(ours, name);
        const theirs = declaration(pristine.toString('utf8'), name);
        if (!mine || !theirs || mine.kind !== theirs.kind) { problems.push(`${path}: ${name} is not declared, as the same kind, in both our file and upstream's`); continue; }
        if (mine.kind === 'interface') {
          for (const member of mine.members) if (!theirs.members.includes(member)) problems.push(`${path}: ${name}'s member ${member.split(/[?:]/)[0]} is not declared as upstream declares it`);
        } else if (mine.body !== theirs.body) problems.push(`${path}: ${name}'s body is not upstream's`);
      }
    } else if (record.kind !== undefined) problems.push(`${path}: unknown kind ${JSON.stringify(record.kind)}`);
  }
  return problems;
}

/** A copy's three header lines, and the rest of it: an executable script keeps its `#!` line first, the header after it. */
function headerOf(text) {
  const lines = text.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  return { head: lines.slice(at, at + 3), body: [...lines.slice(0, at), ...lines.slice(at + 3)].join('\n') };
}

/** The kind of record for a file written for AgentRun that keeps a few named upstream declarations. */
export const MATCHED = 'interfaces matched';

const normalized = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'/g, '"').replace(/\s+/g, ' ').trim();

/** The exported interface or class `name` in `source`: its kind, its body (comments, whitespace and quote style
 *  normalized) and, for an interface, its members. Undefined when it is not there. */
export function declaration(source, name) {
  const found = new RegExp(`^export (interface|class) ${name}\\b`, 'm').exec(source);
  if (!found) return undefined;
  const open = source.indexOf('{', found.index);
  let depth = 0;
  for (let i = open; open >= 0 && i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) {
      const body = normalized(source.slice(open + 1, i));
      return { kind: found[1], body, members: body.split(';').map((m) => m.trim()).filter(Boolean) };
    }
  }
  return undefined;
}

/** How many lines each copy changes against its pristine upstream file, header excluded. A file whose record is
 *  "interfaces matched" is not a copy, so it is left out. `diff` exits 1 when the files differ; any other failure (no
 *  diff, or one that errors) throws, so a comparison that did not run never reads as no change. */
export async function changedLines(dir, { diff: command = 'diff' } = {}) {
  const upstream = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8'));
  const out = {};
  for (const [path, record] of Object.entries(upstream.files ?? {})) {
    if (record.kind === MATCHED) continue;
    const ours = headerOf(await readFile(join(dir, path), 'utf8')).body;
    let diff = '';
    try {
      execFileSync(command, ['-U0', join(dir, PRISTINE_DIR, record.upstream), '-'], { input: ours, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      if (error.status !== 1) throw new Error(`${path}: diff did not run (${error.code ?? `exit ${error.status}`})`);
      diff = String(error.stdout ?? '');
    }
    out[path] = diff.split('\n').filter((line) => /^[-+](?![-+]{2} )/.test(line)).length;
  }
  return out;
}

if (import.meta.main) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const problems = [];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    const has = await readFile(join(dir, UPSTREAM_FILE)).then(() => true, () => false);
    if (!has) continue;
    for (const problem of await provenanceProblems(dir)) problems.push(`packages/${entry.name}: ${problem}`);
    if (process.argv.includes('--diff')) {
      for (const [path, lines] of Object.entries(await changedLines(dir))) console.log(`packages/${entry.name}/${path}: ${lines} changed lines against upstream`);
      const { files } = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8'));
      for (const [path, record] of Object.entries(files ?? {})) if (record.kind === MATCHED) console.log(`packages/${entry.name}/${path}: ${MATCHED} with ${record.upstream}: ${record.declarations.join(', ')}`);
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log('Copied code: every file matches its recorded upstream blob, and carries its header.');
}
