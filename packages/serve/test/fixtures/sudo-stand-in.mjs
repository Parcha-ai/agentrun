// A `sudo` stand-in for the fakes whose box commands run in a real shell of this machine (fake-daytona.mjs, fake-vm.mjs):
// first on every such command's PATH, so a sudo a box command asks for never reaches this machine's own.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A `sudo` stand-in for `dir`'s box commands, first on their PATH: a box command runs in a real shell of this machine
 *  here, so a sudo in it would be this machine's. The stand-in runs nothing: it notes its arguments in `calls` and
 *  exits 97. */
/** A sudo named by its absolute path in a command's text: `/sudo` that a path does not go on from (no letter, digit,
 *  `_`, `.`, `-` or `/` after it), so a quote, a `;`, a `)`, a space or the end each ends it, as a shell reads it. */
export const ABSOLUTE_SUDO = /\/sudo(?![\w.\/-])/;

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
      const at = command.search(ABSOLUTE_SUDO);
      if (at < 0) return false;
      // The command around the sudo it names, on one line.
      const around = command.slice(Math.max(0, command.lastIndexOf("\n", at) + 1, at - 120), at + 80).replace(/\s+/g, " ").trim();
      appendFileSync(calls, `refused, by its absolute path: ${around}\n`);
      return true;
    },
  };
}
