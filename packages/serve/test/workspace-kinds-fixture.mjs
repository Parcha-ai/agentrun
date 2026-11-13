// The computer module's kind registry (@parcha/agentrun-computer: SETTING_KINDS, servingRefusals, PROVIDERS) as the
// claim's resolver and Settings → Computers take it, for their tests. ARCHIL_KINDS states the remote sandboxes' archil
// mounts outright; since module D6 the module's own table declares the same, so the two are one table.
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";

export { PROVIDERS, SETTING_KINDS, servingRefusals };

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, with Daytona, Modal and E2B mounting the run's folder from Archil, stated outright. */
export const ARCHIL_KINDS = { ...KINDS, PROVIDERS: PROVIDERS.map((one) => (["daytona", "modal", "e2b"].includes(one.id) ? { ...one, mounts: ["archil"] } : one)) };
/** The same, with Daytona's GPU computers taking an Archil mount, as one made from a GPU snapshot that has root and the
 *  Archil client would: the registry's own daytona-gpu takes none (DAYTONA_GPU.mounts is empty). */
export const GPU_ARCHIL_KINDS = {
  ...ARCHIL_KINDS,
  PROVIDERS: ARCHIL_KINDS.PROVIDERS.map((one) =>
    one.id === "daytona" ? { ...one, capabilities: one.capabilities.map((c) => (c.gpu ? { ...c, gpu: { ...c.gpu, mounts: ["archil"] } } : c)) } : one,
  ),
};
