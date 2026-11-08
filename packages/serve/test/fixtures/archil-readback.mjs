// The computer module's read-back as its Archil mount change defines it (an Archil mount reads back exclusive and the
// claim epoch it was made under), copied here until that change is published: the tests that use this switch to the
// package's own readBackOf then. A bind is unchanged; an Archil mount with no epoch, or a value that is not one, throws.
export function readBackOf(mount, epoch) {
  if (mount.kind === "bind") return { kind: "bind", path: mount.path };
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("an Archil mount is read back under the computer's claim epoch: a whole number, 0 or more");
  return { kind: "archil", disk: mount.disk, region: mount.region, folder: mount.folder, exclusive: true, epoch };
}
