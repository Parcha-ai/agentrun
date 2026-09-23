// The author contract ships with the interpreter: the grammar and discipline every host's workflow
// author reads, so a host composes its own addendum onto one shared text instead of restating the
// language. The digest identifies which contract authored a document; a host records it with the pin.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type AuthorContract = {
  /** The grammar and discipline shared by every host (authoring/contract.md). */
  contract: string;
  /** Designing typed questions for the judge (authoring/jev-decisions.md). */
  jevDecisions: string;
  /** sha256 over both texts, in order; stable for a given package build. */
  sha256: string;
};

const read = (name: string): string => readFileSync(new URL(`../authoring/${name}`, import.meta.url), "utf8");

let cached: AuthorContract | undefined;

/** The shipped author contract. Read once per process; the texts are package assets, never generated. */
export function loadAuthorContract(): AuthorContract {
  if (cached) return cached;
  const contract = read("contract.md");
  const jevDecisions = read("jev-decisions.md");
  const sha256 = createHash("sha256").update(contract).update("\n").update(jevDecisions).digest("hex");
  cached = Object.freeze({ contract, jevDecisions, sha256 });
  return cached;
}

/** Compose the shared contract with a host's addendum, the way a host hands it to its author. */
export function composeAuthorContract(hostAddendum: string, options: { jev?: boolean } = {}): { text: string; sha256: string } {
  const shared = loadAuthorContract();
  const parts = [shared.contract, ...(options.jev === false ? [] : [shared.jevDecisions]), hostAddendum.trim()].filter(Boolean);
  const text = parts.join("\n\n");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
