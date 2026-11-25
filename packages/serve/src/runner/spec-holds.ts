// What a run's spec holds from its claim until its release: the run's tools, its pull request's checkout, its computer,
// its Archil mount credential and its Workspace, each kept here as the spec builder makes it (adapter-run-spec.ts and
// cli-run-spec.ts). The spec's release lets them go, in that order, each step's failure logged and the next still taken.
// A builder that throws part-way never hands the loop a spec to release, so specBuilt lets go what was made by then, the
// same way, and throws the builder's own error unchanged: a credential minted for the run is revoked and a computer made
// for it let go, never left to the credential's 24 h ttl or the computer's lifetime. Each is let go at most once.
import type { ParkCause } from "../workspace/computer-kept.js";

/** One part a spec holds, by how it is let go. */
type Held = {
  readonly tools?: { end(): Promise<void> };
  /** The run's checkout of its pull request (pr-checkout.ts), removed from its folder while the Workspace still answers. */
  readonly checkout?: { end(): Promise<void> } | undefined;
  /** `park`: its release at the run's park, for its cause, true when it kept the computer (computer-for-claim.ts
   *  ClaimComputer.park). */
  readonly computer?: { release(): Promise<void>; park?(cause: ParkCause): Promise<boolean>; readonly keeps?: string };
  /** Whether this claim's gate turned the run's computer off for the rest of the run (RunGate.computerOff): a park lets
   *  it go instead of keeping it, since no later claim of the run attaches it. */
  readonly computerOff?: () => boolean;
  readonly archil?: { revoke(): Promise<void> } | undefined;
  readonly ws?: { end(): Promise<void> };
  /** The claim's Archil keys, dropped from memory last, once nothing more reads the disk (the CLI spec's). */
  readonly keys?: { release(): void } | undefined;
  /** The CLI's files on this machine for this claim (its private folder in the run's scratch), swept once the rest is let
   *  go: every claim lays its own again, the harness's state coming back from the run's journal. */
  readonly scratch?: { sweep(): Promise<void> } | undefined;
  /** What the spec hands the loop, which lets it go itself (the claim's MCP): let go here only when the build throws. */
  readonly passed?: { release(): void } | undefined;
};

const words = (error: unknown): string => (error as Error)?.message ?? String(error);

/** The parts a run's spec holds, and their one release. */
export class SpecHolds {
  #held: Held = {};
  #log: (line: string) => void = () => {};
  #released: Promise<void> | undefined;
  #checkoutEnded: Promise<void> | undefined;
  #toolsEnded: Promise<void> | undefined;

  /** Where a step that fails is said: the spec's own log. */
  logTo(log: (line: string) => void): void {
    this.#log = log;
  }

  /** `parts`, held from now until the release. */
  hold(parts: Held): void {
    this.#held = { ...this.#held, ...parts };
  }

  /** Everything held let go, once: the tools' end (background processes ended, scratch swept), the pull request's
   *  checkout removed, the computer, the Archil mount credential (idempotent: the computer's release revokes it too), the
   *  Workspace's end, the CLI's scratch, then the claim's keys where they are held. A second call waits for the first and
   *  does nothing more. At a park (`parked`, its cause), a computer that keeps (a desktop, a phone or a sandbox) is kept
   *  for the resume first: the tools' end is left out (the processes they started and their output live on it) and so is
   *  the revoke (its mount writes on); a keep that fails lets it go as above, as does a park of a computer this claim's
   *  gate turned off (computerOff). */
  release(how?: { readonly parked?: ParkCause }): Promise<void> {
    return (this.#released ??= this.#releaseAll(how?.parked));
  }

  /** The tools' end, once: the run's background commands stopped, scratch swept. The end and the release share it. */
  #endTools(): Promise<void> {
    return (this.#toolsEnded ??= (this.#held.tools?.end() ?? Promise.resolve()).catch((error: unknown) => this.#log(`the run's tools' end failed: ${words(error)}`)));
  }

  /** The pull request's checkout removed: the run's end calls it before it commits, so a run never reads final while
   *  its folder still holds the pull request's code. The run's commands are stopped first (a background command still
   *  writing under repo/ would race the removal). The release finds it done and waits for it. A removal that fails is
   *  logged and not kept as done: the release tries it again. */
  endCheckout(): Promise<void> {
    if (this.#checkoutEnded) return this.#checkoutEnded;
    const ending = this.#endTools()
      .then(() => this.#held.checkout?.end())
      .catch((error: unknown) => {
        this.#log(words(error));
        if (this.#checkoutEnded === ending) this.#checkoutEnded = undefined;
      });
    return (this.#checkoutEnded = ending);
  }

  async #releaseAll(parked: ParkCause | undefined): Promise<void> {
    const { computer, archil, ws, scratch, keys } = this.#held;
    const log = this.#log;
    const kept = parked !== undefined && computer?.keeps !== undefined && computer.park && this.#held.computerOff?.() !== true
      ? await computer.park(parked).catch((error: unknown) => {
          log(`the run's computer could not be kept: ${words(error)}`);
          return false;
        })
      : false;
    // A park that keeps the computer leaves the tools' end out (and its checkout is removed here, with no tools' end).
    if (kept) await (this.#checkoutEnded ?? this.#held.checkout?.end())?.catch((error: unknown) => log(words(error)));
    else await this.endCheckout();
    await computer?.release().catch((error: unknown) => log(`the run's computer could not be let go: ${words(error)}`));
    if (!kept) await archil?.revoke().catch((error: unknown) => log(`the run's Archil mount credential could not be revoked: ${words(error)}`));
    await ws?.end().catch((error: unknown) => log(`the run's workspace end failed: ${words(error)}`));
    await scratch?.sweep().catch((error: unknown) => log(`the run's scratch folder could not be swept: ${words(error)}`));
    keys?.release();
  }

  /** What the spec would have handed the loop, let go: only a build that throws calls it. */
  releasePassed(): void {
    try {
      this.#held.passed?.release();
    } catch (error) {
      this.#log(`the run's MCP could not be let go: ${words(error)}`);
    }
  }
}

/** A spec built by `build`, which holds what it makes in the SpecHolds it is given; when it throws, everything held by
 *  then is let go (SpecHolds.release, then what it would have handed the loop) and its own error thrown, unchanged. */
export async function specBuilt<T>(build: (holds: SpecHolds) => Promise<T>): Promise<T> {
  const holds = new SpecHolds();
  try {
    return await build(holds);
  } catch (error) {
    await holds.release();
    holds.releasePassed();
    throw error;
  }
}
