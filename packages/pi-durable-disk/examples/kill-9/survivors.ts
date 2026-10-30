// The kill-9 example's check, apart from the example so that a test can hand it any process table: which processes of the
// long command's process group are still alive after the next open. A process group is named by its leader's pid, a
// number the kernel hands out again once that process has ended, so the number alone does not say whose a process is:
// its start does. Written for AgentRun.

/** A process as one look at the process table saw it. `start` is on one clock with `before` below: clock ticks since boot
 *  on Linux (/proc/<pid>/stat), seconds since the epoch where ps gives it (macOS). */
export interface Seen {
  readonly pid: number;
  readonly ppid: number;
  readonly group: number;
  readonly state: string;
  readonly start: number;
  readonly command: string;
}

/**
 * The processes of `table` in process group `group`, zombies left out (a zombie waits for a parent that does not reap, a
 * container's pid 1): those that started no later than `before`, the instant taken just before the next open, are the
 * command's own, so each is a survivor, a child it forked late included. Those that started after it are other processes
 * that took the group's number once the command's had ended: reported, never counted as the command's.
 */
export function judge(table: readonly Seen[], group: number, before: number): { survivors: Seen[]; reused: Seen[] } {
  const live = table.filter((p) => p.group === group && !p.state.startsWith("Z"));
  return { survivors: live.filter((p) => p.start <= before), reused: live.filter((p) => p.start > before) };
}

/** One line for a process, for the example's failure message. */
export const described = (p: Seen): string => `pid ${p.pid} (parent ${p.ppid}, state ${p.state}, started ${p.start}) ${p.command}`;
