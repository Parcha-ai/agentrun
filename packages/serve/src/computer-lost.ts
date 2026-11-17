// A run's sandbox that its provider lost mid-run (deleted by the vendor's own API or console, or gone with no why): the
// claim starts a new one in its place at the next tool call (workspace/computer-for-claim.ts lostAware), up to
// LOST_RECREATES times a claim. These are the words of both: the Timeline's row for a new one, and the run's end once the
// claim has started as many as it may. That end's words begin with its code, so a reader of the run's summary serves it
// as the error computer_unavailable, its message the words after the code (store-view.ts errorOfRow), as a cap's end is
// served as spend_cap_reached.

/** How many new sandboxes a claim starts in place of ones its provider lost, by default. */
export const LOST_RECREATES = 2;

/** The code a run past its new sandboxes fails with: the one a computer that cannot be had at the claim is refused with. */
export const COMPUTER_UNAVAILABLE_CODE = "computer_unavailable";

/** How lostEnd's words begin, and only theirs. */
const LOST_END = `${COMPUTER_UNAVAILABLE_CODE}: `;

/** The Timeline's row once a new sandbox replaced a lost one: its name. */
export const lostRecreatedWords = (name: string): string => `Its computer was lost; started a new one (${name}).`;

/** The run's end once its sandbox was lost again after `recreates` new ones (the claim's bound): the provider's words,
 *  `why`, last. */
export const lostEnd = (recreates: number, why: string): string =>
  `${LOST_END}the run's sandbox was lost ${recreates + 1} times, and a run starts at most ${recreates} new ${recreates === 1 ? "one" : "ones"} in place of a lost one: ${why.replace(/[.!?]+$/, "")}.`;

/** The message of a run's end in lostEnd's words: what follows its code; undefined for any other summary. */
export const lostEndMessage = (summary: string | null | undefined): string | undefined =>
  typeof summary === "string" && summary.startsWith(LOST_END) ? summary.slice(LOST_END.length) : undefined;
