// confine.test.ts again as on macOS: every layout's environment confined by path (macOS has no /proc/self/fd), and every
// layout under a directory reached through a symlink (macOS's TMPDIR is under /var, a link to /private/var).
import { after } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = mkdtempSync(join(realpathSync(tmpdir()), "pda-confine-linked-"));
const link = `${real}-link`;
symlinkSync(real, link);
process.env.TMPDIR = link;
after(() => {
  rmSync(link, { force: true });
  rmSync(real, { recursive: true, force: true });
});
(globalThis as { confineByPath?: boolean }).confineByPath = true;
await import("./confine.test.ts");
