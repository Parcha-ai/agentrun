// Each adapter harness's facts (AdapterFacts), as its package states them, in the order the harnesses are offered: a
// leaf, beside wires.ts, so a module the harness table itself imports (model.ts' key rows) reads them in any import
// order, never naming a harness.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { facts as openCodeFacts } from "./harness-opencode/facts.js";
import { acpPackage } from "./acp-package.js";

/** The adapter harnesses' facts: claude-agent's, codex's and opencode's, the built-in harnesses the API names (HARNESSES). */
export const ADAPTER_FACTS: readonly AdapterFacts[] = Object.freeze([claudeFacts, codexFacts, openCodeFacts]);

/** Goose's facts (its package's, acp-package.ts), or undefined where that package is not beside serve: then the table has
 *  no goose row. Goose is listed only while its owner has installed it, so it is not one of HARNESSES. */
export const GOOSE_FACTS: AdapterFacts | undefined = acpPackage()?.gooseFacts;

/** Cursor's facts (the same package's), or undefined where it is not beside serve. Listed, as Goose is, only while its
 *  owner has installed it; billed to the owner's Cursor plan (its wire `plan`), never to a model key of ours. */
export const CURSOR_FACTS: AdapterFacts | undefined = acpPackage()?.cursorFacts;

/** Every adapter harness's facts: the built-in ones, then Goose's and Cursor's where their package is. */
export const EVERY_ADAPTER_FACTS: readonly AdapterFacts[] = Object.freeze([...ADAPTER_FACTS, ...(GOOSE_FACTS ? [GOOSE_FACTS] : []), ...(CURSOR_FACTS ? [CURSOR_FACTS] : [])]);

/** The facts of the adapter harness `id`, built-in, Goose or Cursor; undefined for pi and for an id no adapter states. */
export const adapterFactsOf = (id: string): AdapterFacts | undefined => EVERY_ADAPTER_FACTS.find((facts) => facts.id === id);
