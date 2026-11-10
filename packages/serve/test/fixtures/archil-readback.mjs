// The computer module's read-back as its Archil mount change defines it (packages/computer src/mount.ts readBackOf and
// src/labels.ts epochProblem at that change), copied here until it reaches this branch: the tests that use this switch to
// the package's own readBackOf then, and this file goes. A bind is unchanged. An Archil mount reads back exclusive, under
// the claim epoch it is given; with no epoch, or a value that is not one, it reads back as { other } in words that hold
// no token.
const epochProblem = (epoch) => {
  if (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0) return undefined;
  return `an epoch must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}, not ${typeof epoch === "number" ? String(epoch) : JSON.stringify(epoch) ?? typeof epoch}`;
};

export function readBackOf(mount, epoch) {
  if (mount.kind === "bind") return { kind: "bind", path: mount.path };
  const problem = epochProblem(epoch);
  if (problem !== undefined) return { other: `an Archil mount of ${mount.disk}:/${mount.folder} with no epoch to read it back under (${problem})` };
  return { kind: "archil", disk: mount.disk, region: mount.region, folder: mount.folder, exclusive: true, epoch };
}
