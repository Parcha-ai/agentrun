// What the npx command's tests share: their temporary directories, removed once the file's tests are done.
import { rmSync } from "node:fs";
import { after } from "node:test";

/** Directories to remove at the file's end. node:test runs a test's after-hooks in the order they were added, so a
 *  removal added as a directory is made would run before the stop of a command or server started in it afterwards,
 *  while that process still writes there. At the file's end every test's stops have run. */
const dirs = new Set();
// Added as this module loads, so it is the file's own hook (one added inside a test would be that test's).
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Removes `dir` once this file's tests are done. */
export function removeAtEnd(dir) {
  dirs.add(dir);
}
