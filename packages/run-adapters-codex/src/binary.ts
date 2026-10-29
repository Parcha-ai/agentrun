// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/src/binary.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27/28: pinned to Codex 0.164.0; findCodex also reports the platform package's version; comments.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { env } from 'node:process';

/**
 * Where this machine's `codex` binary is, for the stand-in VM's tests and the
 * live tests on a laptop (`@parcha/agentrun-harness-codex's binary.ts`, never the package's
 * index: in a session, Codex is the pinned build in the sandbox's base image,
 * `CODEX_CLI`, and no Function looks a binary up). `@openai/codex` is a small
 * launcher plus one optional package per platform (`@openai/codex-<platform>`,
 * an npm alias of `@openai/codex@<version>-<platform>`) that carries the
 * native binary at `vendor/<target>/bin/codex`.
 */

/** The Codex version this package is built and tested against. */
export const CODEX_VERSION = '0.164.0';

const TARGETS: Record<string, { target: string; pkg: string }> = {
  'linux-x64': { target: 'x86_64-unknown-linux-musl', pkg: 'linux-x64' },
  'linux-arm64': { target: 'aarch64-unknown-linux-musl', pkg: 'linux-arm64' },
  'darwin-x64': { target: 'x86_64-apple-darwin', pkg: 'darwin-x64' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', pkg: 'darwin-arm64' },
};

/** This platform's target and platform package, if Codex ships one. */
export function codexTarget(platform = process.platform, arch = process.arch): { target: string; pkg: string } | undefined {
  return TARGETS[`${platform}-${arch}`];
}

/**
 * The binary to run, and its platform package's version when it came from one,
 * or `undefined` if none is installed:
 *
 * 1. `CODEX_BIN`;
 * 2. the platform package next to the `@openai/codex` this package depends on;
 * 3. the same package by its pnpm store path, walking up from the working
 *    directory.
 */
export function findCodex(): { path: string; packageVersion?: string } | undefined {
  if (env.CODEX_BIN) return { path: env.CODEX_BIN };
  const t = codexTarget();
  if (!t) return undefined;
  const rel = join('vendor', t.target, 'bin', 'codex');
  try {
    const require = createRequire(import.meta.url);
    const launcher = dirname(require.resolve('@openai/codex/package.json'));
    const platformPkg = dirname(createRequire(join(launcher, 'package.json')).resolve(`@openai/codex-${t.pkg}/package.json`));
    const bin = join(platformPkg, rel);
    if (existsSync(bin)) return { path: bin, packageVersion: packageVersion(platformPkg) };
  } catch {}
  const store = join('node_modules', '.pnpm', `@openai+codex@${CODEX_VERSION}-${t.pkg}`, 'node_modules', '@openai', 'codex', rel);
  for (let d = process.cwd(); ; d = dirname(d)) {
    const bin = join(d, store);
    if (existsSync(bin)) return { path: bin, packageVersion: packageVersion(join(d, store, '..', '..', '..', '..')) };
    if (d === dirname(d)) return undefined;
  }
}

/** The binary to run, or `undefined` if none is installed (see `findCodex`). */
export function codexBinary(): string | undefined {
  return findCodex()?.path;
}

function packageVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
