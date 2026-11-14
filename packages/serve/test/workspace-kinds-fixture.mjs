// The computer module's kind registry (@parcha/agentrun-computer: SETTING_KINDS, servingRefusals, PROVIDERS) as the
// claim's resolver and Settings → Computers take it, for their tests. The remote sandboxes' Archil mounts are the
// registry's own (each descriptor's mounts), so there is no second table of them here.
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";

export { PROVIDERS, SETTING_KINDS, servingRefusals };

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, with Daytona's GPU computers taking an Archil mount, as one made from a GPU snapshot that has root and the
 *  Archil client would: the registry's own daytona-gpu takes none (DAYTONA_GPU.mounts is empty). */
export const GPU_ARCHIL_KINDS = {
  ...KINDS,
  PROVIDERS: PROVIDERS.map((one) =>
    one.id === "daytona" ? { ...one, capabilities: one.capabilities.map((c) => (c.gpu ? { ...c, gpu: { ...c.gpu, mounts: ["archil"] } } : c)) } : one,
  ),
};
