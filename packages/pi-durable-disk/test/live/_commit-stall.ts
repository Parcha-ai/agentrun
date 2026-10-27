// What the archil client logged about commits on one mount, read from journald: its server_timeout retries and its
// syncs of a second or more. A diagnostic for a live test whose instance exited before the step the test waited for:
// it adds a line to the failure message and never changes whether the test passes.
import { spawnSync } from "node:child_process";

/** One journald entry: when (ms since the epoch), the process's command line, the message. */
export interface JournalLine {
  readonly at: number;
  readonly cmdline: string;
  readonly message: string;
}

/** The server_timeout retries on a mount and its longest sync (any kind) that overlapped a window. */
export interface CommitStall {
  readonly retries: number;
  readonly longestSyncMs: number;
}

const SYNC = /long sync [a-z-]+: execute_time=([0-9.]+)(ms|s)\b/;

/** An archil client's own lines: its command line names the mountpoint as a whole argument. */
const onMount = (line: JournalLine, mountpoint: string) => ` ${line.cmdline} `.includes(` ${mountpoint} `);

/**
 * The retries and the longest sync on `mountpoint` within [from, to] (ms). A sync is logged when it ends, with how long
 * it ran, so it counts when its run [end - duration, end] overlaps the window.
 */
export function commitStall(lines: readonly JournalLine[], mountpoint: string, from: number, to: number): CommitStall {
  let retries = 0;
  let longestSyncMs = 0;
  for (const line of lines) {
    if (!onMount(line, mountpoint)) continue;
    if (line.message.includes("event=client.operation_retrying") && line.message.includes("reason=server_timeout")) {
      if (line.at >= from && line.at <= to) retries++;
      continue;
    }
    const sync = SYNC.exec(line.message);
    if (!sync) continue;
    const ms = Number(sync[1]) * (sync[2] === "s" ? 1000 : 1);
    if (line.at - ms <= to && line.at >= from) longestSyncMs = Math.max(longestSyncMs, ms);
  }
  return { retries, longestSyncMs };
}

/** journald's entries between `from` and `to` (ms), or null when journald cannot be read on this host. */
export function readJournal(from: number, to: number): JournalLine[] | null {
  const r = spawnSync("journalctl", ["--since", `@${Math.floor(from / 1000)}`, "--until", `@${Math.ceil(to / 1000) + 1}`, "-o", "json", "-q", "--no-pager"], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return parseJournal(r.stdout);
}

/** `journalctl -o json` output as entries; a line that is not an entry with a text message is skipped. */
export function parseJournal(text: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof e.MESSAGE !== "string" || typeof e.__REALTIME_TIMESTAMP !== "string") continue;
    out.push({ at: Number(e.__REALTIME_TIMESTAMP) / 1000, cmdline: typeof e._CMDLINE === "string" ? e._CMDLINE : "", message: e.MESSAGE });
  }
  return out;
}

/** The line a failure message starts with when a commit on the mount stalled (a retry, or a sync of 1 s or more); else "". */
export function stallNote(stall: CommitStall | null, before: string): string {
  if (!stall) return "";
  const seen = [
    ...(stall.longestSyncMs >= 1000 ? [`a commit took ${Math.round(stall.longestSyncMs)} ms`] : []),
    ...(stall.retries > 0 ? [`${stall.retries} server_timeout retries`] : []),
  ];
  return seen.length ? `environment: on this test's own mount ${seen.join(", ")} before ${before}; ` : "";
}
