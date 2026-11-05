// Flaky tests in quarantine: skipped on CI, each with a flake id, an owner and an expiry at most 24 hours on, at most three at
// once (scripts/quarantine.json). A test reds twice with no cause in the change, so its owner quarantines it instead of every
// lane re-running CI; the expiry makes the skip impossible to forget: once it passes, this repository's own check fails on every
// pull request until the test is fixed and its entry removed (or, with the lead's yes, the entry renewed).
//
// A quarantined test carries its skip inline, so no test imports this file:
//   test("name", { skip: process.env.CI && !process.env.AGENTRUN_RUN_QUARANTINED && "quarantined F33 (tl-tools) until 2026-11-06T01:00Z, scripts/quarantine.json" }, ...)
// (vitest: `it.skipIf(process.env.CI && !process.env.AGENTRUN_RUN_QUARANTINED)("name", ...)` with the same marker in a comment
// on that line). Locally the test still runs; AGENTRUN_RUN_QUARANTINED=1 runs it on CI too.
//
//   node scripts/quarantine.mjs --check                                   the entries against the tree, now
//   node scripts/quarantine.mjs --add <id> <file> <owner> <test name> <why>  adds an entry expiring in 24 h, prints the skip
// scripts/quarantine.test.mjs runs the check in CI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const LIMIT = 3;
export const HOURS = 24;
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listPath = (root) => join(root, 'scripts', 'quarantine.json');
const ID = /^F\d+$/;
// The marker a quarantined test's line carries, and the one way to find every quarantine in the tree.
export const marker = (id) => `quarantined ${id} `;
const MARKED = /quarantined (F\d+) \(/g;

export function readQuarantine(root = defaultRoot) {
  const path = listPath(root);
  if (!existsSync(path)) return { tests: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The test files git knows that carry a quarantine marker, by id, with how many times each carries it: Map(id -> Map(file -> n)). */
function markedFiles(root) {
  const found = new Map();
  let files = [];
  try { files = execFileSync('git', ['-C', root, 'ls-files', '*.test.*', '**/*.test.*'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* not a git tree: no markers */ }
  for (const file of new Set(files)) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const [, id] of text.matchAll(MARKED)) {
      if (!found.has(id)) found.set(id, new Map());
      found.get(id).set(file, (found.get(id).get(file) ?? 0) + 1);
    }
  }
  return found;
}

/** What is wrong with the quarantine at `now`: one line per problem, none when it holds. */
export function checkQuarantine(root = defaultRoot, now = new Date()) {
  const problems = [];
  const { tests = [] } = readQuarantine(root);
  if (tests.length > LIMIT) problems.push(`${tests.length} tests are quarantined; at most ${LIMIT} may be. At ${LIMIT}, the owners fix one before new feature work.`);
  const marked = markedFiles(root);
  const seen = new Set();
  for (const entry of tests) {
    const name = entry.id ?? '(no id)';
    for (const field of ['id', 'file', 'name', 'owner', 'since', 'expires', 'why']) if (!entry[field]) problems.push(`${name}: no ${field}`);
    if (entry.id && !ID.test(entry.id)) problems.push(`${name}: an id is F and a number, the flake's own`);
    if (seen.has(entry.id)) problems.push(`${name}: listed twice`);
    seen.add(entry.id);
    const since = Date.parse(entry.since); const expires = Date.parse(entry.expires);
    if (Number.isNaN(since) || Number.isNaN(expires)) { problems.push(`${name}: since and expires are ISO times`); continue; }
    if (expires - since > HOURS * 3_600_000) problems.push(`${name}: expires ${entry.expires}, more than ${HOURS} h after ${entry.since}`);
    // A future start would stretch the skip, which is live on CI from the commit that adds it (a minute's clock skew allowed).
    if (since > now.getTime() + 60_000) problems.push(`${name}: since ${entry.since} is later than now; an entry starts when it is added`);
    if (now.getTime() >= expires) problems.push(`${name} (${entry.owner}) expired at ${entry.expires}: fix ${entry.file} ("${entry.name}") and remove its entry; it has been skipped on CI since ${entry.since}`);
    if (entry.file && !existsSync(join(root, entry.file))) problems.push(`${name}: ${entry.file} does not exist`);
    else if (entry.file) {
      // Exactly one test per id, in the entry's own file: a copied skip would escape the limit.
      const files = marked.get(entry.id) ?? new Map();
      const times = files.get(entry.file) ?? 0;
      if (times === 0) problems.push(`${name}: ${entry.file} carries no "${marker(entry.id)}(" skip`);
      else if (times > 1) problems.push(`${name}: ${entry.file} carries its skip ${times} times; one test per id`);
      for (const other of files.keys()) if (other !== entry.file) problems.push(`${name}: ${other} also skips as "${marker(entry.id)}(", but ${entry.id} is ${entry.file}'s`);
    }
  }
  for (const [id, files] of marked) if (!seen.has(id)) problems.push(`${[...files.keys()].join(', ')} skips as "${marker(id)}(" but scripts/quarantine.json does not list ${id}`);
  return problems;
}

/** Adds an entry that expires HOURS from `now` and returns it with the skip to put on the test. */
export function addQuarantine(root, { id, file, owner, name, why }, now = new Date()) {
  const list = readQuarantine(root);
  list.tests ??= [];
  if (!ID.test(id)) throw new Error(`an id is F and a number, not "${id}"`);
  if (list.tests.some((entry) => entry.id === id)) throw new Error(`${id} is already quarantined`);
  if (list.tests.length >= LIMIT) throw new Error(`${list.tests.length} tests are quarantined already, the limit: fix one first`);
  const since = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const expires = new Date(since.getTime() + HOURS * 3_600_000);
  const entry = { id, file, name, owner, since: since.toISOString().replace(':00.000Z', 'Z'), expires: expires.toISOString().replace(':00.000Z', 'Z'), why };
  list.tests.push(entry);
  writeFileSync(listPath(root), `${JSON.stringify(list, null, 2)}\n`);
  const skip = `process.env.CI && !process.env.AGENTRUN_RUN_QUARANTINED && "${marker(id)}(${owner}) until ${entry.expires}, scripts/quarantine.json"`;
  return { entry, skip };
}

if (isMain(import.meta)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--check') {
    const problems = checkQuarantine();
    const { tests = [] } = readQuarantine();
    if (problems.length) { for (const problem of problems) console.error(`quarantine: ${problem}`); process.exitCode = 1; }
    else console.log(`quarantine: ${tests.length} of ${LIMIT} in use${tests.map((t) => `; ${t.id} (${t.owner}) until ${t.expires}`).join('')}`);
  } else if (command === '--add' && rest.length === 5) {
    const [id, file, owner, name, why] = rest;
    try {
      const { entry, skip } = addQuarantine(defaultRoot, { id, file, owner, name, why });
      console.log(`quarantine: ${entry.id} added, expires ${entry.expires}. On "${name}" in ${file}, set:\n  { skip: ${skip} }`);
    } catch (error) { console.error(`quarantine: ${error.message}`); process.exitCode = 1; }
  } else {
    console.error('usage: node scripts/quarantine.mjs --check | --add <id> <file> <owner> <test name> <why>');
    process.exitCode = 2;
  }
}
