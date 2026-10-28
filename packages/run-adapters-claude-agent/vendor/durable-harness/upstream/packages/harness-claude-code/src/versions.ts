import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Unavailable } from 'harness-world';

/**
 * The Agent SDK and Claude Code versions this harness is built and tested
 * with (docs/workspaces.md §5.2). The harness drives CLI internals that move
 * between releases: the transcript the mirror carries, the `system/init`
 * tool set `builtins: true` is pinned against, the spawn arguments and env
 * `sandboxSpawn` checks. So the installed SDK must be the pinned one (pnpm
 * only warns on a peer mismatch), and the CLI in the VM image is the one
 * that SDK release bundles (`claudeCodeVersion`). A test keeps these equal
 * to package.json's, the installed SDK's and harness-world-sandbox's base.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.296';

/** The Claude Code CLI the pinned SDK release bundles (its package.json's `claudeCodeVersion`), installed in the VM image. */
export const CLAUDE_CODE_VERSION = '2.1.296';

/** Where the pinned CLI is in a session VM booted from the base (harness-world-sandbox's `CLAUDE_CLI`). */
export const CLAUDE_VM_EXECUTABLE = `/opt/dh/claude/${CLAUDE_CODE_VERSION}/claude`;

/** The install line for the pinned SDK. */
export const CLAUDE_AGENT_SDK_INSTALL = `pnpm add @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`;

const SDK = '@anthropic-ai/claude-agent-sdk';

/**
 * The version of `name` an import from here finds: Node's lookup for a
 * package's folder (`node_modules/<name>` in this module's directory or the
 * nearest one above it). Undefined when it isn't there (the import says what
 * is missing) or this module isn't a file.
 */
export function installedVersion(name: string, from = import.meta.url): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(from));
  } catch {
    return undefined;
  }
  for (;;) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version;
      } catch {}
    }
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/**
 * The installed Agent SDK, when it isn't the pinned one, as an `Unavailable`
 * naming both versions and the install line (the turn fails with it; the
 * session stays, and a fixed install drives it again), or undefined when it
 * matches or can't be found (the import then says what is missing).
 */
export function checkAgentSdkVersion(versionOf: (name: string) => string | undefined = installedVersion): Unavailable | undefined {
  const installed = versionOf(SDK);
  if (installed === undefined || installed === CLAUDE_AGENT_SDK_VERSION) return undefined;
  return new Unavailable(`harness-world-claude-code: installed ${SDK} ${installed} (expected ${CLAUDE_AGENT_SDK_VERSION}): Claude Code runs only with the Agent SDK this harness is built with`, {
    code: 'unavailable',
    hint: `Install the pinned version: ${CLAUDE_AGENT_SDK_INSTALL}`,
  });
}

let checked: { error: Unavailable | undefined } | undefined;
/** `checkAgentSdkVersion()`, once per process: throws its `Unavailable`. */
export function assertAgentSdkVersion(): void {
  checked ??= { error: checkAgentSdkVersion() };
  if (checked.error) throw checked.error;
}
