// The pi-durable version these tests run on, read from the copy the package resolves, and a tool result shaped the way
// a host written for that version returns it. Independent of the package's own reading of the version.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The version of the pi-durable a module of this package loads: the nearest node_modules copy above it. */
export function installedPiDurable() {
  for (let at = realpathSync(pkg); ; at = dirname(at)) {
    const manifest = join(at, 'node_modules', '@earendil-works/pi-durable', 'package.json');
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (at === dirname(at)) throw new Error('pi-durable does not resolve from the package');
  }
}

/** The key the installed version reads a tool result's blocks from: `output` from 1.2, `content` before. */
export const hostKey = () => { const [major, minor] = installedPiDurable().split('.').map(Number); return major > 1 || minor >= 2 ? 'output' : 'content'; };
/** The key the installed version does not read. */
export const otherKey = () => (hostKey() === 'output' ? 'content' : 'output');
/** A tool result as a host written for the installed version returns it: its blocks under that version's key only. */
export const resultOf = (blocks, rest = {}) => ({ ...rest, [hostKey()]: blocks });
