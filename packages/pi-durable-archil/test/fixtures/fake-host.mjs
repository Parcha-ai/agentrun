// A fake archil client, fusermount and sudo for claim unit tests. Invoked by per-test wrapper scripts as
//   node fake-host.mjs <state.json> <archil|fusermount|sudo> [args...]
// State (JSON): procMounts (the fake mount table the claim reads), token (the expected mount token), mounts
// ({ [mountpoint]: { source, alive, fenced, delegation } }), holders ({ [disk:/runs/id]: mountpoint | "remote" }),
// behave (failure switches), calls (every invocation: argv, env names, whether the token appears in argv or in any
// environment value, and for `archil mount` what arrived on stdin). The fake archil plays `bin/archil-scoped`: its
// mount takes the token as the first line on stdin and refuses an empty one, and it has the wrapper's `retire`. With
// behave.sysbox every unmount of a listed mount fails with ENOENT, as under Sysbox. Like archil, its mount refuses a
// mountpoint with entries; it also has the wrapper's `stray`. With state.proc set, every archil daemon (state.daemons, pid
// to argv) is written there as <pid>/cmdline: a mount starts one, an unmount, fusermount or retire ends it, a mount is
// refused while one names its mountpoint, and the wrapper's `stale` kills those of an unmounted mountpoint.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const [statePath, tool, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const stdinToken = tool === "archil" && args[0] === "mount" ? readFileSync(0, "utf8").split("\n")[0] : undefined;
state.calls.push({
  tool,
  argv: args,
  envKeys: Object.keys(process.env).sort(),
  envHasToken: Object.values(process.env).some((v) => v?.includes(state.token)),
  argvHasToken: args.some((a) => a.includes(state.token)),
  stdin: stdinToken === undefined ? undefined : stdinToken === state.token ? "token" : stdinToken === "" ? "empty" : "other",
});
const b = state.behave ?? {};
const writeProc = () => {
  if (!state.proc) return;
  rmSync(state.proc, { recursive: true, force: true });
  for (const [pid, argv] of Object.entries(state.daemons ?? {})) {
    mkdirSync(join(state.proc, pid), { recursive: true });
    writeFileSync(join(state.proc, pid, "cmdline"), argv.join("\0") + "\0");
  }
};
const save = () => {
  writeProc();
  const lines = [...(state.extraMounts ?? [])];
  for (const [mp, m] of Object.entries(state.mounts)) lines.push(`${m.source} ${mp} fuse.archil rw,relatime,user_id=0,group_id=0,allow_other 0 0`);
  writeFileSync(state.procMounts, lines.join("\n") + "\n");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
};
const exit = (code, stderr = "", stdout = "") => {
  save();
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
};
// Unmounting uncovers the empty mountpoint directory: what the claim wrote lived on the disk, not in it.
const uncover = (mp) => rmSync(join(mp, ".claim"), { force: true });
const live = (mp) => state.mounts[mp]?.alive === true;
const hasEntries = (mp) => {
  try {
    return readdirSync(mp).length > 0;
  } catch {
    return false;
  }
};
const daemonsOf = (mp) => Object.keys(state.daemons ?? {}).filter((pid) => {
  const argv = state.daemons[pid];
  return argv[0] === "/usr/bin/archil" && argv[1] === "mount" && argv.slice(2).includes(mp);
});
const endDaemons = (mp) => {
  for (const pid of daemonsOf(mp)) delete state.daemons[pid];
};
const OLDER = (mp) =>
  `⠋ Attaching\r✗ Unable to mount Archil disk to '${mp}', because an older Archil process is still running for this mountpoint.\n        \n` +
  `You can check whether this older Archil process is related to an active mount by running \`mount | grep archil\`.\n` +
  `- If the previous process does not exit in a few seconds, you may want to force unmount the previous process by running \`archil unmount -f ${mp}\`` +
  `. Performing a force unmount will fail any in-progress writes to the disk, and will orphan any outstanding delegations -- requiring a force checkout to be performed.\n`;
const NOT_RUNNING = (mp) => `Archil does not appear to be running on mountpoint '${mp}'. The disk is likely not mounted.\n`;

if (tool === "sudo") {
  // sudo -n <cmd> [args...]: reset the environment as sudo does, pass stdin through. Options are recorded, not obeyed.
  let i = 0;
  while (args[i]?.startsWith("-")) i++;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
  save();
  const r = spawnSync(args[i], args.slice(i + 1), { env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (tool === "fusermount") {
  const mp = args[args.length - 1];
  if (b.sysbox && state.mounts[mp]) exit(1, `fusermount: failed to unmount ${mp}: No such file or directory\n`);
  if (b.fusermountFail) exit(1, `fusermount: failed to unmount ${mp}: Device or resource busy\n`);
  if (b.fusermountLies) exit(0); // reports success, stays mounted (busy)
  if (!state.mounts[mp]) exit(1, `fusermount: entry for ${mp} not found in /etc/mtab\n`);
  delete state.mounts[mp]; // the delegation stays with the server: orphaned
  endDaemons(mp);
  uncover(mp);
  exit(0);
}

const [cmd, ...rest] = args;
if (cmd === "mount") {
  const force = rest.includes("--force");
  const pos = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--region");
  const [target, mp] = pos;
  const region = rest[rest.indexOf("--region") + 1];
  if (b.mountHang) {
    save();
    setTimeout(() => process.exit(0), 60_000);
  } else if (!stdinToken) exit(2, "archil-scoped: no mount token on stdin\n");
  else if (b.mount === "echo-token") exit(1, `✗ rejected token ${stdinToken}\n`);
  else if (b.mount === "auth") exit(1, "⠋ Attaching\r✗ Authentication failed. Either the file system does not exist, or you are not authorized to access it.\nAuthentication method used: Token\n");
  else if (b.mount === "fail") exit(1, "✗ something else went wrong\n");
  else if (stdinToken !== state.token) exit(1, "✗ Authentication failed.\n");
  else if (b.mountLies) exit(0, "✓ Successfully mounted\n"); // exit 0, nothing mounted
  else if (b.mountReseed) {
    // A writer refills the mountpoint between the stray move and the mount; archil refuses it, misleadingly.
    writeFileSync(join(mp, "late.json"), "{}\n");
    exit(1, "✗ Unspecified Error\n");
  } else if (b.mount === "lockout") exit(1, "✗ Operation now in progress (os error 115)\n");
  else if (b.mount === "not-empty") exit(1, `✗ '${mp}' is not empty\n`);
  else if (b.mount === "older" || (!state.mounts[mp] && daemonsOf(mp).length)) exit(1, OLDER(mp));
  else if (b.mount === "socket") exit(1, `Failed to bind control socket for ${mp}: ConnectionError(Socket already exists and is in use)\n✗ Unspecified Error\n`);
  else if (hasEntries(mp)) exit(1, "✗ Unspecified Error\n"); // archil refuses to mount over entries
  else if (state.holders[target] && !force) {
    exit(1, `⠋ Attaching\r✗ Unable to mount Archil disk to '${mp}' because another client has an outstanding delegation to the root of the disk, or to any individual file on the disk.\n\nIf you're attempting ...\n`);
  } else {
    const prev = state.holders[target];
    if (prev && state.mounts[prev]) state.mounts[prev].fenced = true;
    state.holders[target] = mp;
    state.mounts[mp] = { source: `${target}[${region}]`, alive: true, fenced: false, delegation: b.mount === "no-delegation" ? null : "Active" };
    if (state.proc) {
      state.nextPid = (state.nextPid ?? 7000) + 1;
      (state.daemons ??= {})[state.nextPid] = ["/usr/bin/archil", "mount", target, mp, "--region", region];
    }
    exit(0, `⠋ Attaching Archil volume\n✓ Successfully mounted\n`);
  }
} else if (cmd === "delegations") {
  const mp = rest[rest.length - 1];
  if (!live(mp)) exit(1, NOT_RUNNING(mp));
  if (b.delegationsGarbage) exit(0, "", "Delegations for mount:\n  (none)\n");
  const m = state.mounts[mp];
  const sub = m.source.replace(/\[.*\]$/, "").split(":")[1];
  const path = b.delegationsPath === "flat" ? mp : b.delegationsPath === "wrong" ? "/elsewhere" : `${mp}${sub}`;
  // The real client keeps listing a revoked delegation as Active.
  exit(0, "", JSON.stringify(m.delegation ? [{ path, state: b.delegationState ?? m.delegation }] : [], null, 2) + "\n");
} else if (cmd === "sync") {
  const mp = rest[rest.length - 1];
  if (b.syncHang) {
    save();
    setTimeout(() => process.exit(0), 60_000);
  } else if (!live(mp)) exit(1, NOT_RUNNING(mp));
  else if (state.mounts[mp].fenced || b.syncFail) exit(1, `Unable to flush pending writes: ServerError("The mount is failed or read-only: un-acked writes were not persisted (see its log)")\n`);
  else exit(0);
} else if (cmd === "unmount") {
  const mp = rest[rest.length - 1];
  if (!live(mp)) exit(1, NOT_RUNNING(mp));
  if (b.sysbox) exit(1, `Unable to unmount disk: GenericFailure("No such file or directory (os error 2)")\n`);
  if (b.unmountFail) exit(1, `umount: ${mp}: target is busy.\n`);
  if (b.unmountLies) exit(0); // reports success, stays mounted
  const target = state.mounts[mp].source.replace(/\[.*\]$/, "");
  if (state.holders[target] === mp) delete state.holders[target];
  delete state.mounts[mp];
  endDaemons(mp);
  uncover(mp);
  if (b.unmountErrButGone) exit(1, `Unable to unmount disk: GenericFailure("after unmount")\n`);
  exit(0);
} else if (cmd === "checkin") {
  // Gives the delegation back to the server; the mount stays (as on a host that cannot unmount).
  const mp = rest[rest.length - 1];
  if (!live(mp)) exit(1, NOT_RUNNING(mp));
  if (b.checkinFail) exit(1, "✗ Unable to check in: ServerError(\"timeout\")\n");
  if (!b.checkinKeeps) {
    const target = state.mounts[mp].source.replace(/\[.*\]$/, "");
    state.mounts[mp].delegation = null;
    if (state.holders[target] === mp) delete state.holders[target];
  }
  exit(0);
} else if (cmd === "retire") {
  // Plays bin/archil-scoped's verb: move the mount to <root>/.released/<run>-<tag>, kill its daemon.
  const [mp, tag] = rest;
  if (!state.mounts[mp]) exit(3, `archil-scoped: no fuse.archil mount at ${mp}\n`);
  if (b.retireFail) exit(4, `archil-scoped: mount --move ${mp} failed\n`);
  const dest = mp.replace(/\/runs\/([^/]+)$/, `/.released/$1-${tag}`);
  const target = state.mounts[mp].source.replace(/\[.*\]$/, "");
  state.mounts[dest] = { ...state.mounts[mp], alive: false };
  delete state.mounts[mp];
  if (state.holders[target] === mp) state.holders[target] = dest; // a dead mount's delegation stays, orphaned
  uncover(mp);
  if (b.retireKeepsDaemon) exit(5, `archil-scoped: archil daemon 4242 still alive\n`);
  endDaemons(mp);
  exit(0, "", `archil-scoped: moved ${mp} to ${dest}; killed: 4242\n`);
} else if (cmd === "stale") {
  // Plays bin/archil-scoped's verb: SIGKILL the archil daemons of an unmounted mountpoint.
  const [mp] = rest;
  if (state.mounts[mp]) exit(3, `archil-scoped: ${mp} is mounted; its daemon is not stale\n`);
  const pids = daemonsOf(mp);
  if (!pids.length) exit(0, "", `archil-scoped: no archil daemon for ${mp}\n`);
  if (b.staleSurvives) exit(5, `archil-scoped: archil daemon ${pids.join(" ")} still alive\n`);
  endDaemons(mp);
  exit(0, "", `archil-scoped: killed stale archil daemon(s) of ${mp}: ${pids.join(" ")}\n`);
} else if (cmd === "stray") {
  // Plays bin/archil-scoped's verb: move an unmounted, non-empty mountpoint whole to <root>/.stray/<run>-<tag>.
  const [mp, tag] = rest;
  if (state.mounts[mp]) exit(3, `archil-scoped: ${mp} is a mount\n`);
  if (b.strayFail) exit(6, `archil-scoped: ${mp.replace(/\/runs\/[^/]+$/, "/.stray")} is not a real directory owned by root\n`);
  const names = readdirSync(mp);
  if (!names.length) exit(0, "", `archil-scoped: ${mp} is empty; nothing moved\n`);
  const held = mp.replace(/\/runs\/[^/]+$/, "/.stray");
  mkdirSync(held, { recursive: true, mode: 0o700 });
  const dest = join(held, `${basename(mp)}-${tag}`);
  const total = readdirSync(mp, { recursive: true }).length;
  renameSync(mp, dest);
  mkdirSync(mp);
  exit(0, "", `archil-scoped: moved stray ${mp} to ${dest}; entries=${names.length} total=${total}\n`);
} else {
  exit(2, `fake archil: unknown command ${cmd}\n`);
}
