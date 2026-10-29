// Imported before the bin under NODE_OPTIONS by start-bin.test.mjs: a start that exits while what it wrote is still on
// its way. A process it started holds its stderr and writes the last line after it has gone, so the line arrives after
// the bin's exit and before its stderr closes. That process gets no NODE_OPTIONS, so it does not import this again.
import { spawn } from "node:child_process";
const { NODE_OPTIONS: _, ...env } = process.env;
spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write('END OF STDERR\\n'), 300)"], { stdio: ["ignore", "ignore", "inherit"], env }).unref();
process.exit(3);
