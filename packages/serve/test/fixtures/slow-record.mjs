// Preloaded into a server's own process (node --import) by server-record-write.test.mjs. The server's record
// (.server.json) is then written in two steps: the file is made empty first, and a second and a half later it is filled.
// A loaded machine can make one write look that way to a reader in another process. A record written whole under
// another name and renamed into place is never seen half-written, whatever this does.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const write = fs.writeFileSync;
fs.writeFileSync = function (file, data, options) {
  if (typeof file === "string" && file.endsWith("/.server.json")) {
    write.call(fs, file, "", options);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
  }
  return write.call(fs, file, data, options);
};
syncBuiltinESMExports();
