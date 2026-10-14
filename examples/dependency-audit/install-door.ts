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

export type InstallOutcome = { result: InstallResult; boxId: string; /** The boxes this call lost on the way (their machines were gone), oldest first. */ lost: string[]; /** How the call was answered: a first box, a reattach to the box a killed process left, or a fresh box after the box was lost. */ how: 'started' | 'reattached' | 'restarted' };

const markOf = (root: string, key: string) => join(root, 'boxes', key.replace(/[^\w.@-]+/g, '_'), 'box.json');
const readMark = (file: string): { boxId: string; lost?: string[] } | undefined => { try { return JSON.parse(readFileSync(file, 'utf8')) as { boxId: string }; } catch { return undefined; } };
function writeMark(file: string, mark: { boxId: string; lost?: string[] }) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.partial`, JSON.stringify(mark));
  renameSync(`${file}.${process.pid}.partial`, file);
}

/** Runs the install through `boxes`, or reattaches to the box a process that died left. */
export async function installThroughBox(root: string, boxes: InstallBoxes, name: string, version: string, options: { deadlineMs?: number; waitMs?: number; labels?: Record<string, string> } = {}): Promise<InstallOutcome> {
  const file = markOf(root, `${name}@${version}`);
  const until = Date.now() + (options.deadlineMs ?? 240_000);
  let how: InstallOutcome['how'] = 'started';
  // A result the door already had is kept on disk before it is returned: the box is gone once its result is read, so a process that
  // dies between reading it and committing the call must not start another install to get it again.
  const kept = join(dirname(file), 'result.json');
  try { return { result: JSON.parse(readFileSync(kept, 'utf8')) as InstallResult, boxId: readMark(file)?.boxId ?? '', lost: readMark(file)?.lost ?? [], how: 'reattached' }; } catch { /* none kept yet */ }
  let mark = readMark(file);
  // A box lost by an earlier process of this run stays on the call's record.
  const lost: string[] = [...(mark?.lost ?? [])];
  if (mark) how = lost.length ? 'restarted' : 'reattached';
  for (;;) {
    if (!mark) {
      mark = { ...(await boxes.startInstall(name, version, { ...(options.labels ? { labels: options.labels } : {}) })), ...(lost.length ? { lost } : {}) };
      writeMark(file, mark);
    }
    const answer = await boxes.attachInstall(mark.boxId, { waitMs: options.waitMs ?? 1_000 });
    if ('gone' in answer) {
      // Another caller of the same call may have read the result an instant ago (the box is removed when its result is read): give it a
      // moment to keep it before this one decides the machine was lost.
      for (let wait = 0; wait < 10; wait += 1) {
        try { return { result: JSON.parse(readFileSync(kept, 'utf8')) as InstallResult, boxId: mark.boxId, lost, how: 'reattached' }; } catch { /* not kept yet */ }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      lost.push(mark.boxId); rmSync(file, { force: true }); mark = undefined; how = 'restarted'; continue; }
    if ('running' in answer) {
      if (Date.now() > until) throw Object.assign(new Error(`the install of ${name}@${version} did not end in time`), { code: 'timeout' });
      continue;
    }
    const partial = `${kept}.${process.pid}.partial`;
    writeFileSync(partial, JSON.stringify(answer));
    renameSync(partial, kept);
    return { result: answer, boxId: mark.boxId, lost, how };
  }
}
