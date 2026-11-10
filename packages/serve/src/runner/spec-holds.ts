// What a run's spec holds from its claim until its release: the run's tools, its computer, its Archil mount credential
// and its Workspace, each kept here as the spec builder makes it (adapter-run-spec.ts and cli-run-spec.ts). The spec's
// release lets them go, in that order, each step's failure logged and the next still taken. A builder that throws
// part-way never hands the loop a spec to release, so specBuilt lets go what was made by then, the same way, and throws
// the builder's own error unchanged: a credential minted for the run is revoked and a computer made for it let go, never
// left to the credential's 24 h ttl or the computer's lifetime. Each is let go at most once.

/** One part a spec holds, by how it is let go. */
type Held = {
  readonly tools?: { end(): Promise<void> };
  readonly computer?: { release(): Promise<void> };
  readonly archil?: { revoke(): Promise<void> } | undefined;
  readonly ws?: { end(): Promise<void> };
  /** The claim's Archil keys, dropped from memory last, once nothing more reads the disk (the CLI spec's). */
  readonly keys?: { release(): void } | undefined;
  /** What the spec hands the loop, which lets it go itself (the claim's MCP): let go here only when the build throws. */
  readonly passed?: { release(): void } | undefined;
};

const words = (error: unknown): string => (error as Error)?.message ?? String(error);

/** The parts a run's spec holds, and their one release. */
export class SpecHolds {
  #held: Held = {};
  #log: (line: string) => void = () => {};
  #released: Promise<void> | undefined;

  /** Where a step that fails is said: the spec's own log. */
  logTo(log: (line: string) => void): void {
    this.#log = log;
  }

  /** `parts`, held from now until the release. */
  hold(parts: Held): void {
    this.#held = { ...this.#held, ...parts };
  }

  /** Everything held let go, once: the tools' end (background processes ended, scratch swept), the computer, the Archil
   *  mount credential (idempotent: the computer's release revokes it too), the Workspace's end, then the claim's keys
   *  where they are held. A second call waits for the first and does nothing more. */
  release(): Promise<void> {
    return (this.#released ??= this.#releaseAll());
  }

  async #releaseAll(): Promise<void> {
    const { tools, computer, archil, ws, keys } = this.#held;
    const log = this.#log;
    await tools?.end().catch((error: unknown) => log(`the run's tools' end failed: ${words(error)}`));
    await computer?.release().catch((error: unknown) => log(`the run's computer could not be let go: ${words(error)}`));
    await archil?.revoke().catch((error: unknown) => log(`the run's Archil mount credential could not be revoked: ${words(error)}`));
    await ws?.end().catch((error: unknown) => log(`the run's workspace end failed: ${words(error)}`));
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
