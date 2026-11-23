// One entry compiled with Bun into a binary that needs neither Node nor Bun installed (`bun build --compile`), for each
// target asked: the importer's known answer for a home in the terminal without an npx install first. Node stays the runtime the
// packages ship on; the binary is one more way to run the same entry, and Node runs it when the binary cannot.
//
//   node scripts/build-binary.mjs [--entry FILE] [--name NAME] [--target TARGET]... [--out DIR]
//
// --entry   the program (default DEFAULT_ENTRY); --name the binary's name before its target (default agentrun-import for the default entry, else the entry's)
// --target  bun-linux-x64, bun-linux-arm64, bun-darwin-arm64 or bun-darwin-x64; repeat for several (default this machine's)
// --out     where the binaries go (default .binary/), each <name>-<os>-<arch>
//
// The Bun is the one .bun-version pins (BUN names its path, else `bun` on PATH): another version refuses to build. A
// compiled binary reads no .env and no bunfig.toml from the directory it runs in. An entry whose bundle imports
// node:sqlite where it loads is refused: Bun has no node:sqlite, and the binary would fail only when it ran.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from './is-main.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The program the binary runs: the importer's own CLI (agentrun-import), named after its bin. */
export const DEFAULT_ENTRY = join(ROOT, 'packages', 'import', 'src', 'cli.ts');
export const DEFAULT_NAME = 'agentrun-import';
export const TARGETS = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64', 'bun-darwin-x64'];
/** Modules Bun's runtime lacks, each with what to use there instead. */
const MISSING = { 'node:sqlite': 'bun:sqlite (import it when `typeof Bun === "object"`, node:sqlite otherwise)' };

/** This machine's target, when it is one Bun builds for. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = `bun-${platform}-${arch}`;
  if (!TARGETS.includes(target)) throw new Error(`no Bun target for ${platform}-${arch}; pass --target (${TARGETS.join(', ')})`);
  return target;
}

/** The modules of `MISSING` a bundle's metafile says it imports where it loads, each with the file that imports it. A
 *  dynamic import is the way round (`await import()` in the branch for Node), so it is not one. */
export function missingImports(metafile) {
  const found = [];
  for (const [file, input] of Object.entries(metafile.inputs ?? {})) {
    for (const { path, kind } of input.imports ?? []) if (kind !== 'dynamic-import' && Object.hasOwn(MISSING, path)) found.push({ file, module: path, instead: MISSING[path] });
  }
  return found;
}

function bunVersion(bun) {
  try {
    return execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`no Bun at ${bun} (${error.code ?? error.message}); install the version in .bun-version, or name one with BUN`);
  }
}

/** Compiles `entry` for each of `targets` into `out`; the binaries built, each with its target and size in bytes. */
export function build({ entry = DEFAULT_ENTRY, name, targets = [hostTarget()], out = join(ROOT, '.binary'), bun = process.env.BUN || 'bun' } = {}) {
  const pinned = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
  const have = bunVersion(bun);
  if (have !== pinned) throw new Error(`Bun ${have} at ${bun}; .bun-version pins ${pinned}`);
  for (const target of targets) if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}; one of ${TARGETS.join(', ')}`);
  const stem = name ?? (entry === DEFAULT_ENTRY ? DEFAULT_NAME : basename(entry, extname(entry)));
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'build-binary-'));
  try {
    return targets.map((target) => {
      const outfile = join(out, `${stem}-${target.slice('bun-'.length)}`);
      const metafile = join(scratch, `${target}.json`);
      execFileSync(bun, [
        'build', entry, '--compile', `--target=${target}`, `--outfile=${outfile}`, `--metafile=${metafile}`,
        '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      const missing = missingImports(JSON.parse(readFileSync(metafile, 'utf8')));
      if (missing.length) {
        rmSync(outfile, { force: true });
        throw new Error(`${entry} cannot run as a Bun binary:\n${missing.map(({ file, module, instead }) => `  ${file} imports ${module}; use ${instead}`).join('\n')}`);
      }
      return { target, file: outfile, bytes: statSync(outfile).size };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta)) {
  const { values } = parseArgs({
    options: { entry: { type: 'string' }, name: { type: 'string' }, target: { type: 'string', multiple: true }, out: { type: 'string' } },
  });
  try {
    const built = build({
      ...(values.entry ? { entry: resolve(values.entry) } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values.target ? { targets: values.target } : {}),
      ...(values.out ? { out: resolve(values.out) } : {}),
    });
    for (const { target, file, bytes } of built) console.log(`${target}\t${(bytes / 2 ** 20).toFixed(1)} MiB\t${file}`);
  } catch (error) {
    console.error(`build-binary: ${error.message}`);
    process.exit(1);
  }
}
