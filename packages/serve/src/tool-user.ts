// The run's tools in a box on another machine run as a user of their own, agentrun-tool, never as the box's own user:
// that user runs the root helper (archil.ts), and on a box whose stdin is no real descriptor it receives the disk token,
// in a 0700 folder of its own, for the moment before the helper reads it. The tool user has no sudo, no way into that folder, and no read of a root
// process's /proc entries (the archil client and the helper run as root), so no tool reaches the token. The box's image
// makes the user, in the group that shares the run's folder (archil.ts ARCHIL_GID_ENV), and one sudoers line that lets
// the box's own user run commands as it; a box whose own user is root needs none. Every program a tool starts in the
// box goes through it, the run's own file reads and writes too (pi-transport's box environment runs each as a program).
import type { Box, BoxProvider } from "@parcha/pi-transport";

/** The user a remote box's tools run as. */
export const TOOL_USER = "agentrun-tool";
/** What every tool program in a remote box is started under: sudo to the tool user, never a password asked. */
export const AS_TOOL: readonly string[] = Object.freeze(["sudo", "-n", "-u", TOOL_USER, "--"]);

/** `boxes`, each box it attaches with its programs started as the tool user (asToolUser): for the server's own calls
 *  that act on the tools' programs, such as ending their background processes. */
export function asToolProvider(boxes: BoxProvider, env: Readonly<Record<string, string>> = {}): BoxProvider {
  return {
    name: boxes.name,
    ...(boxes.traits ? { traits: boxes.traits } : {}),
    create: (spec, context) => boxes.create(spec, context),
    list: (labels, context) => boxes.list(labels, context),
    attach: async (id, context) => {
      const found = await boxes.attach(id, context);
      return found.ok && found.value ? { ok: true, value: asToolUser(found.value, env) } : found;
    },
  };
}

/** `box`, its programs started as the tool user, with `env` (the box's fixed environment) passed on the command line:
 *  sudo resets the environment, so only what `env` names reaches them. One its provider kills itself (a timeout, an
 *  abort) is killed as the tool user too (pi-transport's BoxExecOptions killAs), whom alone it may signal. Every other
 *  call is the box's own. */
export function asToolUser(box: Box, env: Readonly<Record<string, string>> = {}): Box {
  const pass = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  const wrap = (command: readonly string[]) => [...AS_TOOL, ...(pass.length ? ["env", ...pass] : []), ...command];
  return {
    id: box.id,
    facts: () => box.facts(),
    exec: (command, options, context) => box.exec(wrap(command), { ...options, killAs: AS_TOOL }, context),
    upload: (files, context) => box.upload(files, context),
    download: (paths, context) => box.download(paths, context),
    status: (context) => box.status(context),
    destroy: (context) => box.destroy(context),
    ...(box.snapshot ? { snapshot: (context: Parameters<NonNullable<Box["snapshot"]>>[0]) => box.snapshot!(context) } : {}),
    ...(box.endpoint ? { endpoint: (port: number, context: Parameters<NonNullable<Box["endpoint"]>>[1]) => box.endpoint!(port, context) } : {}),
  };
}
