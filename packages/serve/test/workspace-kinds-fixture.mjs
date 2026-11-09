// The computer module's kind registry (@parcha/agentrun-computer: SETTING_KINDS, servingRefusals, PROVIDERS) as the
// claim's resolver and Settings → Computers take it, for their tests. ARCHIL_KINDS states the remote sandboxes' archil
// mounts outright; since module D6 the module's own table declares the same, so the two are one table.
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";

export { PROVIDERS, SETTING_KINDS, servingRefusals };

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, with Daytona, Modal and E2B mounting the run's folder from Archil, stated outright. */
export const ARCHIL_KINDS = { ...KINDS, PROVIDERS: PROVIDERS.map((one) => (["daytona", "modal", "e2b"].includes(one.id) ? { ...one, mounts: ["archil"] } : one)) };
