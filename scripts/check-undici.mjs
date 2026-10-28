#!/usr/bin/env node
// This repository's installed tree (`npm ls undici --all --json`) holds no undici below its major's floor: 6.29.1, 7.30.1
// or 8.12.2, nothing before 6, and any 9 or later. The disk SDK and @earendil-works/pi-coding-agent pin undici 8.10.2
// exactly; the root package.json's overrides move only those two packages' copies, so a lock refresh, or either package
// arriving under another parent, could bring 8.10.2 back unseen (verify-packages audits a clean consumer, not this
// install). Exits 1 naming each such copy by its path. Runs as a command on Node 22.18 or later (import.meta.main); on an
// older Node the command does nothing and exits 0.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const FLOORS = { 6: [29, 1], 7: [30, 1], 8: [12, 2] };

/** Whether an undici version is one this install may hold: at or above its major's floor, or a major of 9 or later. */
const allowed = (version) => {
  const [major, minor, patch] = String(version ?? '').split('-')[0].split('.').map(Number);
  if (![major, minor, patch].every(Number.isInteger)) return false;
  if (major >= 9) return true;
  const floor = FLOORS[major];
  return floor !== undefined && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
};

/** The path to every undici in an `npm ls --all --json` tree that is not allowed (a missing version included). */
export function staleUndici(tree) {
  const found = [];
  const walk = (node, path) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const at = [...path, `${name}@${child.version ?? '?'}`];
      if (name === 'undici' && !allowed(child.version)) found.push(at.join(' > '));
      walk(child, at);
    }
  };
  walk(tree, []);
  return found;
}

if (import.meta.main) {
  const ls = spawnSync('npm', ['ls', 'undici', '--all', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!ls.stdout) {
    console.error(`npm ls printed no tree (exit ${ls.status}): ${ls.stderr || ls.error}`);
    process.exit(1);
  }
  const stale = staleUndici(JSON.parse(ls.stdout));
  if (stale.length) {
    console.error(`undici below its major's floor in this install:\n${stale.map((path) => `  ${path}`).join('\n')}`);
    process.exit(1);
  }
  console.log("No undici below its major's floor in this install.");
}
