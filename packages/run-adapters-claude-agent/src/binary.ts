// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/binary.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's seam; the override variable is AGENTRUN_CLAUDE_AGENT_EXECUTABLE; comments name no other product; its comments' references (docs/workspaces.md and its sections, the P0 findings, harness-world and its sandbox package) are durable-harness's own.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_AGENT_SDK_VERSION } from './versions.js';

/**
 * Where the pinned `claude` binary is on **this** machine. The harness never
 * runs it here (Claude Code runs only in the session's sandbox VM, from
 * the image's copy, `CLAUDE_VM_EXECUTABLE`); this finds the host build for the
 * private stand-in VM (`localMachine()` in harness-world-sandbox's tests),
 * which runs the CLI on the test machine. It is `harness-world-claude-code/binary`,
 * never the package's index, so no published entry carries it and no
 * Function looks a binary up. The Agent SDK ships it in one optional
 * package per platform (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 * a single file, `claude`). This walks up from `cwd` and looks for the file
 * itself: in a hoisted `node_modules` (npm, yarn), then in a pnpm store
 * (`node_modules/.pnpm/<pkg>@<version>/...`).
 *
 * Only the binary of the pinned SDK version counts (`CLAUDE_AGENT_SDK_VERSION`):
 * the transcript the mirror carries is CLI-internal, and a store that holds
 * several versions must not hand the SDK another one.
 *
 * `HARNESS_CLAUDE_CODE_EXECUTABLE` wins. Returns `undefined` when it finds
 * nothing (the tests that need it skip), never a `claude` on `PATH`.
 */

export { CLAUDE_AGENT_SDK_VERSION };

export function findClaudeExecutable(cwd = process.cwd(), version = CLAUDE_AGENT_SDK_VERSION): string | undefined {
  const fromEnv = process.env.AGENTRUN_CLAUDE_AGENT_EXECUTABLE;
  if (fromEnv) return fromEnv;
  const pkg = ['@anthropic-ai', `claude-agent-sdk-${platformSuffix()}`];
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const storeDir = `${pkg[0]}+${pkg[1]}@${version}`;
  for (let d = cwd; ; d = dirname(d)) {
    const hoisted = join(d, 'node_modules', ...pkg);
    if (existsSync(join(hoisted, bin)) && versionOf(hoisted) !== 'other') return join(hoisted, bin);
    const store = join(d, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      for (const name of readdirSync(store)) {
        // `<pkg>@<version>` or `<pkg>@<version>_<peers>`, never another version.
        if (name !== storeDir && !name.startsWith(`${storeDir}_`)) continue;
        const p = join(store, name, 'node_modules', ...pkg, bin);
        if (existsSync(p)) return p;
      }
    }
    if (dirname(d) === d) return undefined;
  }

  /** `same` / `other` from the package's `package.json`; `unknown` when it is not there (a tracer copied only the binary). */
  function versionOf(dir: string): 'same' | 'other' | 'unknown' {
    try {
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version === version ? 'same' : 'other';
    } catch {
      return 'unknown';
    }
  }
}

/** `linux-x64`, `darwin-arm64`, `linux-x64-musl`, ... as the SDK names its platform packages. */
export function platformSuffix(): string {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== 'linux') return base;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? base : `${base}-musl`;
}
