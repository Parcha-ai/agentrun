// A browser computer's tools: pi-browser's family (snapshot, run, screenshot, browser_read, ...), its definitions in
// pi-browser's contract.ts (BROWSER_TOOLS) alone. The kernel may not import pi-browser (a subsystem; the kernel reaches
// only protocols), so the host passes the contracts in, and the registry keeps their names, words and schemas as given,
// the same objects, never a copy. Their runs are the host's too (pi-browser's tools over hands.browser, the browser's
// CDP), as is take-over. One settings key, browser, holds them all.
import type { ToolDef } from "./defs.js";

/** A browser tool's contract, as pi-browser's ToolContract gives what the registry reads of it. */
export type BrowserContract = {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  /** After a crash a `safe` call runs again; an `unsafe` one is reported interrupted. */
  readonly replay: "safe" | "unsafe";
};

/** The browser kind's definitions: the host's contracts, as given, held to the setting browser. */
export function browserToolDefs(contracts: readonly BrowserContract[] | undefined): readonly ToolDef[] {
  if (contracts === undefined) throw new Error("the browser's definitions are pi-browser's BROWSER_TOOLS, which the host passes as browserTools: the kernel holds no copy");
  return contracts.map((contract): ToolDef => ({
    name: contract.name,
    source: "host",
    gateName: `host:browser/${contract.name}`,
    settingsKey: "browser",
    description: contract.description,
    parameters: contract.parameters,
    replaySafe: contract.replay === "safe",
  }));
}
