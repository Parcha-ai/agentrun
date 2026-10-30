// A run's box record, beside the run: written durably before anything runs in the box, so whatever crashes after (the
// run's process, the server, the machine) leaves a record a later start can find the box by. The box's first record
// (its id, its cgroup, its writer) is written synchronously before its spawn (`ahead`); its second (its first process's
// pid, start time and pid namespace) before that process is let go (`started`). The box's start names the writer, the
// run process: a record nothing could count is cleared only once that writer is gone, so a record without one is refused.
import { join } from "node:path";
import type { BoxRecord, BoxRecorder } from "@parcha/agentrun-adapters/host";
import { BoxError } from "@parcha/agentrun-adapters/host";
import { writeDurable, writeDurableSync } from "../files.js";

/** The run directory's box record. */
export const BOX_RECORD = "box.json";

function text(record: BoxRecord): string {
  const writer = record.writer as Partial<BoxRecord["writer"]> | undefined;
  if (!writer || !Number.isSafeInteger(writer.pid) || typeof writer.startTime !== "string" || writer.startTime === "") {
    throw new BoxError("box_record_failed", "box_record_failed: a box record names no writer (its run process's pid and start time), so it could never be cleared safely");
  }
  return `${JSON.stringify(record)}\n`;
}

/** The recorder a box start is given for the run in `runDir`: each call replaces the record. `ahead` returns only once
 *  the file and its directory are synced; `started` resolves then. */
export function boxRecorder(runDir: string): BoxRecorder {
  const path = join(runDir, BOX_RECORD);
  return {
    ahead: (record) => writeDurableSync(path, text(record)),
    started: async (record) => writeDurable(path, text(record)),
  };
}
