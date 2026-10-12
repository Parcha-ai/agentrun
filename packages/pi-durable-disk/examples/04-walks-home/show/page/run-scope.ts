// What the page remembers about one run (the skills said, how skills go into the robot, the captions said once) starts over when the feed starts a new run. The change is told to the page
// synchronously (Feed.onChange), so a message that arrives right after it is already the new run's; the poll tick only repeats the check.
export class RunScope {
  private generation = -1;
  private readonly resets: (() => void)[] = [];

  onReset(fn: () => void): void {
    this.resets.push(fn);
  }

  /** The feed's generation now: a different one is a new run, and everything registered is reset once. */
  sync(generation: number): void {
    if (generation === this.generation) return;
    this.generation = generation;
    for (const fn of this.resets) fn();
  }
}
