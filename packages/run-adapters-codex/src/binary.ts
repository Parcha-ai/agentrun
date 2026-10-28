// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/src/binary.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27/28: pinned to Codex 0.164.0 (src/versions.ts holds the pins); findCodex also reports the
// platform package's version; verifyCodexBinary and verifyCodex check a binary against the pins with typed errors; comments.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import { CODEX_BINARY_SHA256, CODEX_VERSION, CodexNotInstalled, CodexPinMismatch } from './versions.js';

/**
 * Where this machine's `codex` binary is, for the stand-in VM's tests and the
 * live tests on a laptop (`@parcha/agentrun-codex's binary.ts`, never the package's
 * index: in a session, Codex is the pinned build in the sandbox's base image,
 * `CODEX_CLI`, and no Function looks a binary up). `@openai/codex` is a small
 * launcher plus one optional package per platform (`@openai/codex-<platform>`,
 * an npm alias of `@openai/codex@<version>-<platform>`) that carries the
 * native binary at `vendor/<target>/bin/codex`.
 */

export { CODEX_VERSION };

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
 * The binary to run and, when it came from a platform package, that package's
 * version; `undefined` if none is installed:
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
  const storePkg = join('node_modules', '.pnpm', `@openai+codex@${CODEX_VERSION}-${t.pkg}`, 'node_modules', '@openai', 'codex');
  for (let d = process.cwd(); ; d = dirname(d)) {
    const bin = join(d, storePkg, rel);
    if (existsSync(bin)) return { path: bin, packageVersion: packageVersion(join(d, storePkg)) };
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

export interface CodexPins {
  /** The release `codex --version` must report. */
  version: string;
  /** The binary's sha256; unchecked when undefined (a target the pins do not list). */
  sha256?: string;
  /** The platform package's version (`<version>-<platform>`), when the binary came from one. */
  packageVersion?: string;
}

/** The pins for this platform's binary. */
export function codexPins(target = codexTarget()): CodexPins {
  return { version: CODEX_VERSION, sha256: target ? CODEX_BINARY_SHA256[target.target] : undefined, packageVersion: target ? `${CODEX_VERSION}-${target.pkg}` : undefined };
}

/**
 * The binary at `found.path` checked against `pins`, in order: the platform package's version, the binary's sha256,
 * then the version it reports. Returns the path, or the typed error (not thrown) naming the pin, what was expected and
 * what was found. No path, or a binary that cannot be read or run, is `CodexNotInstalled`.
 */
export function verifyCodexBinary(found: { path: string; packageVersion?: string } | undefined, pins: CodexPins = codexPins()): { path: string } | CodexPinMismatch | CodexNotInstalled {
  if (!found) return new CodexNotInstalled('no Codex binary found for this platform, and CODEX_BIN is not set');
  const { path } = found;
  if (!existsSync(path)) return new CodexNotInstalled(`no file at ${path}`);
  if (pins.packageVersion && found.packageVersion !== undefined && found.packageVersion !== pins.packageVersion) {
    return new CodexPinMismatch('package_version', pins.packageVersion, found.packageVersion, path);
  }
  if (pins.sha256) {
    let sha256: string;
    try {
      sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch (error) {
      return new CodexNotInstalled(`${path} could not be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
    if (sha256 !== pins.sha256) return new CodexPinMismatch('binary_sha256', pins.sha256, sha256, path);
  }
  let reported: string;
  try {
    reported = execFileSync(path, ['--version'], { env: { PATH: env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 }).trim();
  } catch (error) {
    return new CodexNotInstalled(`${path} could not be run: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  }
  const version = /^codex-cli (\S+)$/.exec(reported)?.[1] ?? JSON.stringify(reported.slice(0, 60));
  if (version !== pins.version) return new CodexPinMismatch('version', pins.version, version, path);
  return { path };
}

/** This machine's Codex checked against the pins: its path, or the typed error thrown. */
export function verifyCodex(found = findCodex(), pins: CodexPins = codexPins()): { path: string } {
  const result = verifyCodexBinary(found, pins);
  if (result instanceof Error) throw result;
  return result;
}
