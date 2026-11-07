// A `sudo` stand-in for the fakes whose box commands run in a real shell of this machine (fake-daytona.mjs, fake-vm.mjs):
// first on every such command's PATH, so a sudo a box command asks for never reaches this machine's own.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A sudo named by its absolute path in a command's text: `/sudo` that a path does not go on from (no letter, digit,
 *  `_`, `.`, `-` or `/` after it), so a quote, a `;`, a `)`, a space or the end each ends it, as a shell reads it. */
export const ABSOLUTE_SUDO = /\/sudo(?![\w.\/-])/;

/** A `sudo` stand-in for `dir`'s box commands, first on their PATH: a box command runs in a real shell of this machine
 *  here, so a sudo in it would be this machine's. The stand-in runs nothing: it notes its arguments in `calls` and
 *  exits 97. Its script is written once, whole: to a file of its own, then renamed into place, so a command (or another
 *  fake setting it up at the same time) finds it whole or not at all. */
export function sudoStandIn(dir) {
  const bin = join(dir, "sudo-bin");
  const calls = join(dir, "sudo.calls");
  const script = join(bin, "sudo");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(script)) {
    const part = `${script}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
    writeFileSync(part, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 97\n`, { mode: 0o755 });
    renameSync(part, script);
  }
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
