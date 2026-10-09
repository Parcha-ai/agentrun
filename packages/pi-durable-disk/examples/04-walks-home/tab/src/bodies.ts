// Which known body a policy was trained for. A policy names its body by mjcf_sha256; when that is one of the presets
// (the 3-DOF show body, or the first policies' 2-DOF body), the tab can switch to it instead of only refusing.

import { PRESETS, type Design } from './design.ts';
import { buildMjcf } from './mjcf.ts';
import { sha256Hex } from './policy.ts';

export async function presetForSha(mjcfSha256: string): Promise<{ name: string; design: Design } | null> {
  for (const [name, design] of Object.entries(PRESETS)) {
    if ((await sha256Hex(buildMjcf(design).xml)) === mjcfSha256) return { name, design };
  }
  return null;
}
