// What every conformance module of a dial host (MachineHost facts.connect "dial") answers the CLI for dialKit(): a
// refusal in words. Its machines dial the server that minted their tokens, so a Core run must happen inside a server the
// internet reaches: serve's packages/serve/scripts/dial-conformance.mjs starts that server and gives the run its DialKit.
import type { DialKit } from "./types.js";

/** The dialKit() of a dial host's module, by its provider id and label: it always refuses, naming the script to run. */
export function dialOnlyFromServer(id: string, label: string): () => DialKit {
	return () => {
		throw new Error(
			`${label}'s machines dial the server that minted their tokens, and this run has no public server: run its Core with packages/serve/scripts/dial-conformance.mjs --provider ${id} inside a server the internet reaches at AGENTRUN_PUBLIC_URL`,
		);
	};
}
