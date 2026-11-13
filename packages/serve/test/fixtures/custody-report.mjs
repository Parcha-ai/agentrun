// Where a custody faux keeps what it reported, beside its answer. Serve serves a run's answer with no held secret in it
// (redactedAnswer), and what a held-secret check reads as one depends on the host it runs on, so a custody test reads the
// report as the run's process wrote it: CUSTODY_REPORT_DIR/<run id>.json, the run's id taken from its process's --dir.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const REPORT_DIR_ENV = "CUSTODY_REPORT_DIR";

/** Keeps `report` for the test, when the test named a directory and this is a run's process. */
export function keep(report) {
  const dir = process.env[REPORT_DIR_ENV];
  const at = process.argv.indexOf("--dir");
  if (!dir || at < 0 || !process.argv[at + 1]) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename(process.argv[at + 1])}.json`), JSON.stringify(report));
}

/** What run `runId`'s process reported. */
export const reported = (runId) => JSON.parse(readFileSync(join(process.env[REPORT_DIR_ENV], `${runId}.json`), "utf8"));
