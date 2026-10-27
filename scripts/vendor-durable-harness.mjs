// The provenance of code copied from vercel-labs/durable-harness, checked offline: for each package that carries
// vendor/durable-harness/UPSTREAM.json, every recorded file has its pristine upstream copy under
// vendor/durable-harness/upstream/<upstream path> (never shipped) whose git blob and sha256 are the recorded ones, and our
// copy at the recorded path opens with the header naming that upstream path. `--diff` also prints, per file, how many
// lines our copy changes against the pristine one (the reviewable change). Exits non-zero with the problems.
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
    const head = ours.split('\n').slice(0, 3);
    if (!head[0]?.startsWith('// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0')) problems.push(`${path}: line 1 is not Vercel's copyright header`);
    if (!head[1]?.startsWith(`// From github.com/vercel-labs/durable-harness, ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`)) problems.push(`${path}: line 2 does not name ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`);
    if (!head[2]?.startsWith('// Changed by Parcha, ')) problems.push(`${path}: line 3 is not the "Changed by Parcha" line`);
  }
  return problems;
}

/** How many lines each copy changes against its pristine upstream file, header excluded. */
export async function changedLines(dir) {
  const upstream = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8'));
  const out = {};
  for (const [path, record] of Object.entries(upstream.files ?? {})) {
    const ours = (await readFile(join(dir, path), 'utf8')).split('\n').slice(3).join('\n');
    let diff = '';
    try { execFileSync('diff', ['-U0', join(dir, PRISTINE_DIR, record.upstream), '-'], { input: ours, encoding: 'utf8' }); } catch (error) { diff = String(error.stdout ?? ''); }
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
    if (process.argv.includes('--diff')) for (const [path, lines] of Object.entries(await changedLines(dir))) console.log(`packages/${entry.name}/${path}: ${lines} changed lines against upstream`);
  }
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log('Copied code: every file matches its recorded upstream blob, and carries its header.');
}
