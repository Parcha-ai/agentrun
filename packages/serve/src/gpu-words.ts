// Why a sandbox's GPUs can't be had here, in one place for every serve answer that says so: the save's warning and the
// run's start (resolve-computer.ts), the claim (computers.ts), and Settings' gpu.why. checkGpu's words for the GPU
// itself (a type or a count the provider doesn't give); for the run's folder, the provider's own reason, from its
// descriptor (GpuCapability.unmounted), so serve names no vendor: no GPU computer mounts the folder yet, and the
// library's GPU computers work without it.
import { checkGpu, type GpuCapability, type GpuSpec } from "@parcha/agentrun-computer";

/** What a run's sandbox on `label` can't have when its GPU computer can't mount the run's folder, why, and what to use. */
export const gpuNoFolder = (label: string, unmounted: GpuCapability["unmounted"]): string =>
  `A ${label} GPU computer can't mount this run's folder${unmounted?.yet === false ? "" : " yet"}${unmounted ? `: ${unmounted.why}` : ""}. Use a GPU computer from the library, or this sandbox without a GPU.`;

/**
 * Why `asked` can't be had from a provider declaring `offered`, with the run's folder as `mount`: checkGpu's words for
 * the GPU itself, `folder: false`; gpuNoFolder's when only the folder's mount is refused, `folder: true`; undefined when
 * it can be had.
 */
export function gpuRefused(asked: GpuSpec | unknown, offered: GpuCapability | undefined, mount: { kind: string }, label: string): { words: string; folder: boolean } | undefined {
  const declared = offered ? { gpu: offered } : {};
  const [itself] = checkGpu(asked, declared);
  if (itself) return { words: itself.message, folder: false };
  const [withFolder] = checkGpu(asked, declared, mount);
  return withFolder ? { words: gpuNoFolder(label, offered?.unmounted), folder: true } : undefined;
}
