// The smallest cap a run can work under, for the cap fields' help: the server's README states it per route, measured
// (packages/serve/test/cap-minimum.test.mjs holds the figures to what the cap does).

/** The README's section on the spend cap, the smallest cap that works among it. */
export const SPEND_CAP_DOCS_URL = "https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/README.md#spend-cap";

/** The cap fields' one-line help: a run on Sonnet needs about $0.10 to take a few steps, and where that is worked out. */
export function SpendCapMinimum() {
  return (
    <>
      A run on Sonnet needs about $0.10 to take a few steps; under that it pauses before its next step (
      <a className="underline underline-offset-2 hover:text-foreground" href={SPEND_CAP_DOCS_URL} target="_blank" rel="noreferrer">the smallest cap</a>).
    </>
  );
}
