// Each adapter harness's facts (AdapterFacts), as its package states them, in the order the harnesses are offered: a
// leaf, beside wires.ts, so a module the harness table itself imports (model.ts' key rows) reads them in any import
// order, never naming a harness.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { facts as openCodeFacts } from "./harness-opencode/facts.js";

/** The adapter harnesses' facts: claude-agent's, codex's and opencode's. */
export const ADAPTER_FACTS: readonly AdapterFacts[] = Object.freeze([claudeFacts, codexFacts, openCodeFacts]);
