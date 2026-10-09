// Where the live suites record what they create (a ledger per suite, a results file next to it): $PDA_STATE_DIR, else a
// fresh temporary directory, created once per live process and exported so the child processes of a suite use the same
// one. A suite's own variable (PDA_P1_STATE .. PDA_P5_STATE) names its ledger file. A process that is not live (the
// suites skip) makes nothing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PDA_STATE_DIR && process.env.PDA_LIVE === "1") {
  process.env.PDA_STATE_DIR = mkdtempSync(join(tmpdir(), "pda-live-state-"));
  process.stderr.write(`live suite ledgers: ${process.env.PDA_STATE_DIR}\n`);
}

export const STATE_DIR = process.env.PDA_STATE_DIR ?? join(tmpdir(), "pda-live-state-unused");

/** `$<variable>` if set, else `<state dir>/<file>`. */
export const statePath = (variable: string, file: string): string => process.env[variable] ?? join(STATE_DIR, file);
