// The install call's door. An install runs in a box that is a process of its own, so a kill of the run leaves it going. The door keeps the
// box's id on disk before it waits (`<run>/boxes/<name@version>/box.json`); a process that resumes asks the box about that id: a result
// completes the call, a box that is gone is started again in a fresh one (safe to repeat: nothing is shared between boxes), a box still
// running is waited for. A call is never sent twice to a box that is still alive.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What an install in a box reports: the program's exit, the tail of its output, and the connections its box saw. */
export type InstallResult = {
  exitCode: number; scriptLog: string; outbound: Array<{ host?: string; ip: string; port: number; at: number }>; durationMs: number;
  /** Where `outbound` comes from, said as the box says it. */
  seen: string;
  /** Set by a replay's stand-in: no program ran, so nothing here is a fact about the package. */
  standIn?: true;
};

export type InstallBoxes = {
  /** Returns as soon as the box exists and the install is launched. Throws `{ code: 'DOCKER_UNAVAILABLE' }` when there is no Docker. */
  startInstall(name: string, version: string, options?: { image?: string; timeoutMs?: number; labels?: Record<string, string> }): Promise<{ boxId: string }>;
  /** The result when the install has ended; `{ running: true }` after `waitMs` while it has not; `{ gone: true }` when the box no longer exists. */
  attachInstall(boxId: string, options?: { waitMs?: number }): Promise<InstallResult | { running: true } | { gone: true }>;
};

export type InstallOutcome = { result: InstallResult; boxId: string; /** How the call was answered: a first box, a reattach to the box a killed process left, or a fresh box after the box was lost. */ how: 'started' | 'reattached' | 'restarted' };

const markOf = (root: string, key: string) => join(root, 'boxes', key.replace(/[^\w.@-]+/g, '_'), 'box.json');
const readMark = (file: string): { boxId: string } | undefined => { try { return JSON.parse(readFileSync(file, 'utf8')) as { boxId: string }; } catch { return undefined; } };
function writeMark(file: string, mark: { boxId: string }) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.partial`, JSON.stringify(mark));
  renameSync(`${file}.${process.pid}.partial`, file);
}

/** Runs the install through `boxes`, or reattaches to the box a process that died left. */
export async function installThroughBox(root: string, boxes: InstallBoxes, name: string, version: string, options: { deadlineMs?: number; waitMs?: number; labels?: Record<string, string> } = {}): Promise<InstallOutcome> {
  const file = markOf(root, `${name}@${version}`);
  const until = Date.now() + (options.deadlineMs ?? 240_000);
  let how: InstallOutcome['how'] = 'started';
  let mark = readMark(file);
  if (mark) how = 'reattached';
  for (;;) {
    if (!mark) {
      mark = await boxes.startInstall(name, version, { ...(options.labels ? { labels: options.labels } : {}) });
      writeMark(file, mark);
    }
    const answer = await boxes.attachInstall(mark.boxId, { waitMs: options.waitMs ?? 1_000 });
    if ('gone' in answer) { rmSync(file, { force: true }); mark = undefined; how = 'restarted'; continue; }
    if ('running' in answer) {
      if (Date.now() > until) throw Object.assign(new Error(`the install of ${name}@${version} did not end in time`), { code: 'timeout' });
      continue;
    }
    return { result: answer, boxId: mark.boxId, how };
  }
}
