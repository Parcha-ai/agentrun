// The box `AGENTRUN_BOX=local` makes: the kernel's bwrapBox, its isolation what the kernel's start probe proved on this
// host. bwrap is Linux's; elsewhere (macOS: no Seatbelt box exists yet) the probe finds none and the box reads
// unavailable, so runs get no tools of their harness's own there. The remote providers have no factory here yet.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapBox, probeBox } from "@parcha/agentrun-kernel/host";
import type { BoxFactory } from "./config.js";

export const localBoxFactory: BoxFactory = async (config) => {
  if (config.provider !== "local") throw new Error(`no box for ${config.provider} on this server yet`);
  // The probe's scratch is its own data root, removed after it.
  const scratch = await mkdtemp(join(tmpdir(), "agentrun-box-probe-"));
  try {
    const isolation = await probeBox({ scratch });
    return bwrapBox({ isolation, ...(config.cgroup !== undefined ? { cgroupRoot: config.cgroup } : {}) });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
