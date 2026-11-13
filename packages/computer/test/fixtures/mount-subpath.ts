// What a host that reads the mount rule alone writes: every name of src/mount.ts, from the "./mount" subpath, with its
// types. test/mount-subpath.test.mjs compiles it against this package's manifest and dist.
import { checkMount, MOUNT_KINDS, type MountKind, type MountReadBack, type MountSpec, readBackOf, WORKSPACE } from "@parcha/agentrun-computer/mount";

const spec: MountSpec = { kind: "bind", path: WORKSPACE };
const back: MountReadBack = readBackOf(spec);
const kinds: readonly MountKind[] = MOUNT_KINDS;
const refused: { field: string; message: string }[] = checkMount(spec, kinds);
// @ts-expect-error an Archil mount names its disk, region, folder and token.
const incomplete: MountSpec = { kind: "archil", disk: "d" };
// @ts-expect-error a read-back never holds the token.
const leaked: MountReadBack = { kind: "archil", disk: "d", region: "r", folder: "f", token: "t" };
void [back, refused, incomplete, leaked];
