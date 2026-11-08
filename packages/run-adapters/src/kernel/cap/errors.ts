// The kernel cap's errors.
import type { RefusalFigures } from "./types.js";

/** The cap's refusal: `forGood` when no raise could send the step (the run fails, never parks), else a refusal for room
 *  with its figures (the run parks, offered the raise its words name). */
export class CapRefused extends Error {
  readonly code = "spend_cap_reached";
  readonly forGood: boolean;
  readonly spentUsd: number | null;
  readonly figures?: RefusalFigures;
  constructor(message: string, { forGood, spentUsd, figures }: { forGood: boolean; spentUsd: number | null; figures?: RefusalFigures }) {
    super(message);
    this.name = "CapRefused";
    this.forGood = forGood;
    this.spentUsd = spentUsd;
    if (figures) this.figures = figures;
  }
}

/** A decision whose model's price could not be read: it fails unsent as a connection error (read again next time), never
 *  as the cap's stop. */
export class DecisionPriceUnreadable extends Error {
  readonly connection = true;
  constructor() {
    super("the decision was not sent: its model's price could not be read from the catalog");
    this.name = "DecisionPriceUnreadable";
  }
}
