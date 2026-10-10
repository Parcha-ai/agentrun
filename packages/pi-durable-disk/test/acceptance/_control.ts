// The acceptance rig's control API over a disk, for its supervisor process (`_supervisor.ts`): each call goes straight to
// the disk, as the CLI's control does (src/cli.ts), `exec` included. The control API lists some delegations with no path
// (a dead client's private directories among them), and the supervisor attributes those by inode through `exec`; without
// it every pass on a disk that lists one refuses (CONTROL_API_FAILED) and starts nothing.
import type { Disk } from "disk";
import type { SupervisorControl } from "../../src/supervise.ts";

export type ControlDisk = Pick<Disk, "getObject" | "headObject" | "putObject" | "addUser" | "removeUser" | "listDelegations" | "revokeDelegation" | "exec">;

export function diskControl(disk: ControlDisk): SupervisorControl {
  return {
    getObject: (key) => disk.getObject(key),
    headObject: (key) => disk.headObject(key),
    putObject: (key, body, options) => disk.putObject(key, body, options),
    addUser: (user) => disk.addUser(user),
    removeUser: (type, identifier) => disk.removeUser(type, identifier),
    listDelegations: () => disk.listDelegations(),
    revokeDelegation: (d) => disk.revokeDelegation(d),
    exec: (command) => disk.exec(command),
  };
}
