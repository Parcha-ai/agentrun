// A note a faux process leaves for its test (where it held, its pid), written whole: to a file of its own beside `file`,
// then renamed over it, so a test polling `file` reads nothing or all of it, never a file made and not yet written.
import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeWhole(file, text) {
  const part = join(dirname(file), `.${basename(file)}.${process.pid}.part`);
  writeFileSync(part, text);
  renameSync(part, file);
}
