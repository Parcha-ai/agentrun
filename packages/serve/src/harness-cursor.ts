// Cursor on this server: installed by its owner (`<data>/harnesses/cursor`, by `agentrun harness install cursor`), held
// to its pinned release, its launcher and every file beside it (harness-owned.ts); the key it runs on (CURSOR_API_KEY,
// the owner's), the limits a run of it stops at and the card its owner reads. Cursor's model is Cursor's, billed to the
// owner's Cursor plan: no request of it reaches a proxy of ours.
import type { AcpPackage } from "./acp-package.js";
import { acpPackage } from "./acp-package.js";
import { ownerInstalled } from "./harness-owned.js";

export const CURSOR_ID = "cursor";
/** The key Cursor runs on: the owner's Cursor API key, read by name, handed to Cursor's runs and no other. */
export const CURSOR_KEY = "CURSOR_API_KEY";
/** The owner's limits for a run of Cursor (CURSOR_LIMITS, the package's, by default): its turns and its tool calls. */
export const CURSOR_MAX_TURNS_ENV = "AGENTRUN_CURSOR_MAX_TURNS";
export const CURSOR_MAX_TOOL_CALLS_ENV = "AGENTRUN_CURSOR_MAX_TOOL_CALLS";
/** The provider a Cursor model is named under (`cursor/<model>`, `cursor/default` for Cursor's own default). */
export const CURSOR_PROVIDER = "cursor";
export const CURSOR_DEFAULT_MODEL = "default";

/** Cursor as an owner-installed harness, pinned by its tree: its pin, its install line and its not-installed code are its
 *  package's. */
export const CURSOR = ownerInstalled({ id: CURSOR_ID, label: "Cursor", pin: (acp) => acp.CURSOR_PIN, installLine: (acp) => acp.CURSOR_INSTALL, notInstalled: (acp) => acp.CURSOR_CODES.notInstalled, tree: true });

export const { hidden: cursorHidden, missing: cursorMissing } = CURSOR;

/** The limits a run of Cursor stops at on `env`: the owner's (CURSOR_MAX_TURNS_ENV, CURSOR_MAX_TOOL_CALLS_ENV), else the
 *  package's. A setting that is no whole number is refused by name. */
export function cursorLimitsOf(acp: AcpPackage, env: NodeJS.ProcessEnv): { maxTurns: number; maxToolCalls: number } {
  const read = (name: string, fallback: number, least: number): number => {
    const given = env[name];
    if (given === undefined || given === "") return fallback;
    const n = Number(given);
    if (!/^\d+$/.test(given.trim()) || !Number.isSafeInteger(n) || n < least) throw new Error(`${name} is ${JSON.stringify(given)}: set it to a whole number of at least ${least}, or unset it for ${fallback}`);
    return n;
  };
  return { maxTurns: read(CURSOR_MAX_TURNS_ENV, acp.CURSOR_LIMITS.maxTurns, 1), maxToolCalls: read(CURSOR_MAX_TOOL_CALLS_ENV, acp.CURSOR_LIMITS.maxToolCalls, 0) };
}

/** The card Cursor's owner reads (capabilities' harness `card`), with this server's limits; none where Cursor's adapter is
 *  not beside the server, or its limits are set wrong (its refusal says so). */
export function cursorCardOf(env: NodeJS.ProcessEnv): string | undefined {
  const acp = acpPackage();
  if (!acp) return undefined;
  try {
    return acp.cursorCard(cursorLimitsOf(acp, env));
  } catch {
    return undefined;
  }
}
