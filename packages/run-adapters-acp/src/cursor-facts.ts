// What Cursor is as a host's harness table reads it (the kernel's AdapterFacts), the limits a run of it stops at, and
// the card its owner reads before choosing it. Measured on Cursor 2026.11.13-eacade1 over ACP (harness S0; cursor.ts
// says what its recipe holds). Written for AgentRun.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { ACP_CODES } from "./facts.js";
import { CURSOR_PIN } from "./pinned-binary.js";

/** The command that installs the pinned Cursor CLI into an AgentRun server's data (`<data>/harnesses/cursor`). */
export const CURSOR_INSTALL = "agentrun harness install cursor";

/** The codes Cursor's own refusals carry. */
export const CURSOR_CODES = Object.freeze({
  /** Cursor's team administrator turned headless Cursor CLI use off (its dashboard's switch). Cursor checks it in print
   *  mode (`agent -p`); where it says so over ACP, a run is refused under this code. */
  headlessDisabled: "CURSOR_HEADLESS_DISABLED",
  /** Cursor is not installed where the server looks. */
  notInstalled: "HARNESS_NOT_INSTALLED",
} as const);

/** Where a run of Cursor stops, its spend being its owner's plan's and never metered by AgentRun: its session/prompt
 *  turns and its tool calls, each counted from the session's records across runners (ACP_CODES.turnLimit,
 *  ACP_CODES.toolCallLimit). The owner may set lower or higher ones (the server's AGENTRUN_CURSOR_MAX_TURNS and
 *  AGENTRUN_CURSOR_MAX_TOOL_CALLS). */
export const CURSOR_LIMITS = Object.freeze({ maxTurns: 20, maxToolCalls: 100 });
export type CursorLimits = { readonly maxTurns: number; readonly maxToolCalls: number };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The card the owner reads before choosing Cursor: whose terms and key it runs on, who bills it and where it stops,
 *  that it edits no file, and how its team's switch is said. */
export function cursorCard(limits: CursorLimits = CURSOR_LIMITS): string {
  return [
    "Cursor: runs Cursor's CLI on your Cursor API key, under Cursor's terms (cursor.com/terms and its Acceptable Use Policy). AgentRun does not resell Cursor.",
    `Each run is billed to your Cursor plan, with no spend cap of AgentRun's: it stops after ${plural(limits.maxTurns, "turn")} or ${plural(limits.maxToolCalls, "tool call")}.`,
    "Cursor makes no file edits: every Write is denied until Cursor asks before an edit, as it asks before a shell command or a tool.",
    `If your Cursor team administrator turned headless CLI use off, its runs are refused (${CURSOR_CODES.headlessDisabled}).`,
  ].join(" ");
}

export const cursorFacts: AdapterFacts = Object.freeze<AdapterFacts>({
  id: "cursor",
  label: "Cursor",
  // Its model is Cursor's, billed to the owner's plan on the owner's key: no request of it reaches a proxy of ours.
  wire: "plan",
  // ACP has no steer: a message mid-turn waits for the turn's end.
  steer: false,
  // A call Cursor started is never run again: one cut off is reported interrupted, never repeated.
  rerunsStarted: false,
  // An answer cut at the output limit (stopReason max_tokens) ends the turn.
  recoversCutAnswers: 0,
  // One run's memory, measured on the S0 runs: Cursor's own node process (about 300 MiB resident) beside the run's.
  runMib: 384,
  // Cursor picks its own thinking per model (the model id's [reasoning=...]): no level is passed to it.
  thinking: Object.freeze(["medium"] as const),
  // Its model is one Cursor lists for the owner's key, never the host's default.
  ownModel: true,
  normalizeModel: (model: { provider: string; modelId: string }) => model,
  // Installed by its owner, never on first use: the archive the pin names, its digests checked (serve's harness-archive.ts).
  install: Object.freeze({ npmLine: CURSOR_INSTALL, spec: `cursor@${CURSOR_PIN.version}`, codes: Object.freeze({ install: CURSOR_CODES.notInstalled, pins: ACP_CODES.binaryMismatch }) }),
  // Its MCP calls are titled `agentrun-<tool>: <tool>` (its permission asks) or `agentrun: <tool>` (its updates).
  hostName: (given: string) => /^agentrun(?:-[^:]*)?: (.+)$/.exec(given)?.[1]?.trim() ?? given,
  policy: () => {
    throw new Error("acp: Cursor is billed to its owner's plan: its model requests never reach a proxy, so it has no proxy policy");
  },
});
