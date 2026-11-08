// The run's Docker computer, built from module D's provider registry. A run whose place is a box (Mode 1: Docker is the
// local provider) gets one here: D makes a container with the run's folder mounted at /workspace, under the run's own
// epoch label, so a later claim's computer carries a higher epoch and D releases the lower one (the one fence). runTools
// attaches the run's Workspace to it; the run's end lets it go through the spec's release hook, not an external drop.
//
// The provider reads no owner setting from the environment (the lead's ruling): serve passes the image owner setting as
// the provider's option, and the network from the run's launch row (boxAllow); D's own proxy does the egress for an
// allow-list. The container's lifetime is a bound on a leaked one, never its clean end.
import {
  type ComputerProvider,
  type ComputerRef,
  type ComputerSpec,
  DEFAULT_DOCKER_IMAGE,
  type MountReadBack,
  type MountSpec,
  providerFromEnv,
  readBackOf,
  type Result,
  runLabels,
} from "@parcha/agentrun-computer";
import type { AttachableComputer } from "../workspace/attach.js";
import type { RunComputer } from "../workspace/run-tools.js";
import type { Workspace } from "../workspace/workspace.js";

/** How long a run's computer lives whatever happens to the server: a bound on a leaked one, never its clean end (the old
 *  box's lifetime). The clean end is the run's release. */
export const COMPUTER_LIFETIME_MS = 24 * 60 * 60_000;

export interface DockerComputerOptions {
  readonly runId: string;
  /** The claim's epoch: the computer's epoch label, so a later claim's computer releases this one (D's one fence). */
  readonly epoch: number;
  /** What the run's box may reach, as the launch resolved it: "none" or absent is no network; a list is an allow-list,
   *  D's proxy doing the egress. */
  readonly boxAllow?: readonly string[] | "none";
  /** The image owner setting (AGENTRUN_DOCKER_IMAGE); absent is D's own default image. */
  readonly image?: string;
  readonly signal?: AbortSignal;
}

/** A run's computer and how to let it go. */
export interface RunComputerHandle {
  readonly run: RunComputer;
  /** Ends the computer (idempotent): the run's release calls it at the run's end. */
  release(): Promise<void>;
}

/** The Docker ComputerSpec for a run (pure: no provider call), so the spec a box is made with is read on its own: D's
 *  image unless the owner names one, the run's folder mounted, the network from boxAllow, the run and epoch labels. */
export function dockerSpec(options: DockerComputerOptions, mount: MountSpec): ComputerSpec {
  return {
    image: options.image ?? DEFAULT_DOCKER_IMAGE,
    lifetimeMs: COMPUTER_LIFETIME_MS,
    network: !options.boxAllow || options.boxAllow === "none" ? "none" : { allow: [...options.boxAllow] },
    labels: runLabels(options.runId, options.epoch),
    mount,
  };
}

/** The run's Docker computer: made by D's provider with the run's folder at /workspace, its Workspace attachable (its
 *  read-back is D's own, checked against the mount it asked for), and a release that ends it. `makeProvider` is D's
 *  docker provider by default; a test gives its own. */
export async function dockerComputer(
  workspace: Workspace,
  options: DockerComputerOptions,
  makeProvider: () => Promise<ComputerProvider> = () => providerFromEnv("docker"),
): Promise<RunComputerHandle> {
  const provider = await makeProvider();
  const spec = dockerSpec(options, await workspace.mountSpec());
  const made = await provider.create(spec, options.signal ? { signal: options.signal } : undefined);
  if (!made.ok) throw new Error(`the run's computer could not be made: ${made.error.message}`);
  const ref: ComputerRef = made.value;
  const release = async (): Promise<void> => void (await provider.release(ref, "delete").catch(() => undefined));
  let client;
  try {
    const connected = await provider.connect(ref);
    if (!connected.ok) throw new Error(`the run's computer could not be reached: ${connected.error.message}`);
    client = connected.value.client;
  } catch (error) {
    await release();
    throw error;
  }
  const computer: AttachableComputer = {
    id: ref.id,
    client,
    async readBack(): Promise<Result<MountReadBack>> {
      const attached = await provider.attach({ id: ref.id });
      if (!attached.ok) return attached;
      const mount = attached.value.spec.mount;
      return mount ? { ok: true, value: mount } : { ok: false, error: { code: "invalid", message: "the run's computer read back no mount at /workspace" } };
    },
  };
  return { run: { computer, check: { readBackOf } }, release };
}
