// `@parcha/pi-durable-disk/internals`: the claim, status and Daytona plumbing that this repository's examples and demos
// use. No compatibility promise: a name here may change or go in any release, and the CHANGELOG says when. A name moves
// to the root entry when something outside this repository needs it.
export { createRunDir, findDelegations, mintMountToken, pathlessResolver, removeMountToken, runPath, unmountClaim } from "./claim.ts";
export { LABEL_FLEET, LABEL_RUN, sandboxName, sandboxStatus, sweepSandboxes } from "./hosts/daytona.ts";
export { isLeaseFresh, parseRunRecord, RUN_JSON } from "./status.ts";
// The workspace confinement, for a host that reads a run's files itself (agentrun-serve), and its process-wide TEST seam
// (confineTestHooks: runs after a path is checked and before it is opened; tests only, never a production hook).
export { Confinement, confineHooks as confineTestHooks } from "./confine.ts";
export type { Pin, PinSpec, RootName } from "./confine.ts";
