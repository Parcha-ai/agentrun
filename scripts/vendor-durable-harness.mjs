// The provenance of code taken from vercel-labs/durable-harness, checked offline. The port froze on 2026-11-07: the
// copies are AgentRun's own, and the pristine upstream files, the patches and the port script are gone. What stays is the
// record (vendor/durable-harness/UPSTREAM.json, each file's upstream path, blob and sha256 at the pinned commit) and the
// header each copy keeps: Vercel's copyright line, the upstream path it came from at that commit, and the "Changed by
// Parcha" line. For each package that carries the record, every recorded file is there and opens with those three lines
// (after a #! line, for an executable script). Exits non-zero with the problems.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM, UPSTREAM_FILE } from './upstream-attribution.mjs';
import { isMain } from './is-main.mjs';

/** Problems for one package directory; empty passes. */
export async function provenanceProblems(dir) {
  const problems = [];
  let upstream;
  try { upstream = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8')); } catch { return [`${UPSTREAM_FILE} is missing or not JSON`]; }
  if (upstream.commit !== UPSTREAM.commit) problems.push(`${UPSTREAM_FILE} commit ${upstream.commit} is not ${UPSTREAM.commit}`);
  for (const [path, record] of Object.entries(upstream.files ?? {})) {
    if (typeof record.upstream !== 'string' || !/^[0-9a-f]{40}$/.test(record.blob ?? '') || !/^[0-9a-f]{64}$/.test(record.sha256 ?? '')) problems.push(`${path}: its record names no upstream path, git blob and sha256`);
    const ours = await readFile(join(dir, path), 'utf8').catch(() => undefined);
    if (ours === undefined) { problems.push(`${path}: our copy is missing`); continue; }
    const head = headerOf(ours);
    if (!head[0]?.startsWith('// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0')) problems.push(`${path}: line 1 is not Vercel's copyright header`);
    if (!head[1]?.startsWith(`// From github.com/vercel-labs/durable-harness, ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`)) problems.push(`${path}: line 2 does not name ${record.upstream} at ${UPSTREAM.commit.slice(0, 10)}`);
    if (!head[2]?.startsWith('// Changed by Parcha, ')) problems.push(`${path}: line 3 is not the "Changed by Parcha" line`);
  }
  return problems;
}

/** A copy's three header lines: an executable script keeps its `#!` line first, the header after it. */
function headerOf(text) {
  const lines = text.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  return lines.slice(at, at + 3);
}

if (isMain(import.meta)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const problems = [];
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    const has = await readFile(join(dir, UPSTREAM_FILE)).then(() => true, () => false);
    if (!has) continue;
    for (const problem of await provenanceProblems(dir)) problems.push(`packages/${entry.name}: ${problem}`);
  }
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log('Copied code: every recorded file is there and carries its header.');
}
