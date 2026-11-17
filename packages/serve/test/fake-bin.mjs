// A bin of every program in `from` (the box's /usr/bin and /bin by default) but the ones `skip` names, as symlinks, for a
// test that runs a tool on a PATH that lacks a program. On a merged-/usr box /bin is /usr/bin, so a name comes twice.
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function fakeBin(bin, skip, from = ["/usr/bin", "/bin"]) {
  for (const dir of from) {
    for (const name of readdirSync(dir)) if (!skip.includes(name) && !existsSync(join(bin, name))) symlinkSync(join(dir, name), join(bin, name));
  }
}
