// The computer module's kind registry (@parcha/agentrun-computer: SETTING_KINDS, servingRefusals, PROVIDERS) as the
// claim's resolver and Settings → Computers take it, for their tests. ARCHIL_KINDS is the same registry once the remote
// sandboxes take archil mounts (their mounts are [] until then).
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";

export { PROVIDERS, SETTING_KINDS, servingRefusals };

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, once Daytona, Modal and E2B mount the run's folder from Archil. */
export const ARCHIL_KINDS = { ...KINDS, PROVIDERS: PROVIDERS.map((one) => (["daytona", "modal", "e2b"].includes(one.id) ? { ...one, mounts: ["archil"] } : one)) };
