// A bin of every program in `from` (the box's /usr/bin and /bin by default) but the ones `skip` names, as symlinks, for a
// test that runs a tool on a PATH that lacks a program. On a merged-/usr box /bin is /usr/bin, so a name comes twice;
// the first one is kept. A name is matched by the link itself, never by what it points at: a box's bin can hold a link
// to nothing (GitHub's ubuntu image: /usr/bin/grub-ntldr-img), which existsSync reads as missing.
import { readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function fakeBin(bin, skip, from = ["/usr/bin", "/bin"]) {
  const linked = new Set(skip);
  for (const dir of from) {
    for (const name of readdirSync(dir)) {
      if (linked.has(name)) continue;
      linked.add(name);
      symlinkSync(join(dir, name), join(bin, name));
    }
  }
}
