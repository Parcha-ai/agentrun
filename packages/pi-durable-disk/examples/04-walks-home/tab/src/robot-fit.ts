// A body the agent changed under a policy that was trained for another one. The page used to drop the policy at once (the creature flops, untrained); for a robot the agent edits it keeps the old
// brain running when its network still fits the new body's joints, so the robot visibly stumbles, and says so: the brain no longer fits. A body whose joint count changed (a pair of legs more or
// fewer) cannot run the old network at all and falls back to the untrained brain, as before. Never run and hoped about: the dimensions are checked by Policy.load against the new body.

import { Policy, type PolicyFile } from './policy.ts';

/**
 * The old policy on the new body: loaded with its OWN body hash (the hash check is exactly what is being waived) and the new body's joint count, so every layer width is still checked.
 * null when the network does not fit the new body (a different number of joints, a different observation layout).
 */
export async function borrowPolicy(file: PolicyFile, nj: number, mujocoVersion?: string): Promise<Policy | null> {
  try {
    return await Policy.load(file, { mjcfSha256: file.mjcf_sha256, nj, ...(mujocoVersion ? { mujocoVersion } : {}) });
  } catch {
    return null;
  }
}

/** What the label says while a borrowed brain drives a body it was not trained for. */
export const MISMATCH_LABEL = "its brain no longer fits this body: stumbling";
