// A `sudo` stand-in for the fakes whose box commands run in a real shell of this machine (fake-daytona.mjs, fake-vm.mjs):
// first on every such command's PATH, so a sudo a box command asks for never reaches this machine's own.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A `sudo` stand-in for `dir`'s box commands, first on their PATH: a box command runs in a real shell of this machine
 *  here, so a sudo in it would be this machine's. The stand-in runs nothing: it notes its arguments in `calls` and
 *  exits 97. */
/** A sudo named by its absolute path in a command's text: `/sudo` followed by a space or the end. */
export const ABSOLUTE_SUDO = /\/sudo(\s|$)/m;

export function sudoStandIn(dir) {
  const bin = join(dir, "sudo-bin");
  const calls = join(dir, "sudo.calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 97\n`);
  chmodSync(join(bin, "sudo"), 0o755);
  return {
    bin,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []),
    // A command that names a sudo by its absolute path would pass the stand-in by: it is refused whole, never run, and
    // noted as a call.
    refuses: (command) => {
      if (!ABSOLUTE_SUDO.test(command)) return false;
      appendFileSync(calls, `refused, by its absolute path: ${command.replace(/\s+/g, " ").slice(0, 200)}\n`);
      return true;
    },
  };
}
