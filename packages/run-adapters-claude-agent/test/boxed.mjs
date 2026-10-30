// The boxed variant of a real-CLI test: with AGENTRUN_CLAUDE_BOXED=1, the session's CLI runs in a real bwrap box, as a
// boxed serve run's does. The box is the kernel's bwrapBox, its isolation what the probe proved. The session's sockets go
// in a short directory outside it. Each session's directory is the test's, and the process's TMPDIR is set inside it as
// the session opens, so the CLI's config and resume directories (made in TMPDIR) are lent to its box by the harness's
// binds. Without the variable this is the test as it was: the box it names, and no runner option.
//
// Boxed, a host where bwrap cannot make a box skips by name, unless AGENTRUN_BOX_REAL=1 (the job that installs it)
// makes that fail.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after } from 'node:test';
import { bwrapBox, probeBox } from '@parcha/agentrun-kernel/host';
import { claudeAgentExecutable } from '@parcha/agentrun-harness-claude';

export const BOXED = process.env.AGENTRUN_CLAUDE_BOXED === '1';

const probed = BOXED ? await (async () => {
  const scratch = mkdtempSync('/tmp/cbx-probe-');
  try {
    return await probeBox({ scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})() : undefined;

/** Why a boxed variant cannot run here (no bwrap that makes a box), or false. Unboxed: false. */
export const boxSkip = BOXED && probed.mode !== 'bwrap' && process.env.AGENTRUN_BOX_REAL !== '1' ? `boxed: no usable bwrap here (${JSON.stringify(probed)})` : false;

const SOCKETS = BOXED ? mkdtempSync('/tmp/cbx-') : undefined;
if (SOCKETS) after(() => rmSync(SOCKETS, { recursive: true, force: true }));
let n = 0;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // key-gate: loopback-rule a free port on host loopback
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * What a test passes: `box` for the adapter (`unsandboxed`, or the test's own, as given, when not boxed), and `runner`
 * for createHarnessRunner (nothing when not boxed). Boxed, every session the runner opens gets its own directory under
 * `sessionsDir`, and TMPDIR is set inside it before the CLI's config directory is made there.
 */
export async function boxedOptions(t, sessionsDir, unboxed = 'unsandboxed') {
  if (!BOXED) return { box: unboxed, runner: {} };
  const saved = process.env.TMPDIR;
  t.after(() => (saved === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = saved)));
  const box = {
    box: bwrapBox({ isolation: probed }),
    recorder: { ahead: () => {}, started: async () => {} },
    readOnly: [claudeAgentExecutable()].filter(Boolean),
    modelPort: await freePort(),
    runtimeDir: join(SOCKETS, `s${n++}`),
  };
  let sessions = 0;
  const sessionDir = () => {
    const dir = join(sessionsDir, `s${sessions++}`);
    mkdirSync(join(dir, 'proc-tmp'), { recursive: true, mode: 0o700 });
    process.env.TMPDIR = join(dir, 'proc-tmp');
    return dir;
  };
  return { box, runner: { sessionDir } };
}

/** For a session a test opens itself (adapter.open): boxed, its own directory under `dir` as io.dir, with TMPDIR set
 *  inside it before it opens; unboxed, nothing (the adapter's own directory under its sessionsDir). */
export function boxedSession(dir) {
  if (!BOXED) return {};
  const session = join(dir, 'session');
  mkdirSync(join(session, 'proc-tmp'), { recursive: true, mode: 0o700 });
  process.env.TMPDIR = join(session, 'proc-tmp');
  return { dir: session };
}
