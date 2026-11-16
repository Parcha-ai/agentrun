// The computer module's kind registry (@parcha/agentrun-computer: SETTING_KINDS, servingRefusals, PROVIDERS) as the
// claim's resolver and Settings → Computers take it, for their tests. The remote sandboxes' Archil mounts are the
// registry's own (each descriptor's mounts), so there is no second table of them here.
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";

export { PROVIDERS, SETTING_KINDS, servingRefusals };

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, with Modal's GPU computers taking an Archil mount, as they will once Archil's FUSE mount is proven on their
 *  runtime: the registry's own Modal GPU takes none yet (MODAL_GPU.mounts is empty). */
export const GPU_ARCHIL_KINDS = {
  ...KINDS,
  PROVIDERS: PROVIDERS.map((one) =>
    one.id === "modal" ? { ...one, capabilities: one.capabilities.map((c) => (c.gpu ? { ...c, gpu: { ...c.gpu, mounts: ["archil"] } } : c)) } : one,
  ),
};
