// A change of the server's tool settings (PUT /settings/tools) wakes the runs parked on an ask it answers. A call a person
// was asked about and has not answered, whose tool now reads allow, is answered by the setting at the run's next claim
// (runner/adapter-loop.ts allowedBySetting: the ask closes "Allowed by the tool's setting" and the call runs). That claim
// came only with a person's answer or another command; here the flip itself brings it, by the store's wake (runs.wake),
// so the run goes on at once. No second resume path: the claim is any claim, and its gate decides as it always does.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { approvalsOf } from "./approvals.js";
import { answersOf, asksOf } from "./run-view.js";
import { journalEntries } from "./runner/journal-reader.js";
import type { Store } from "./store/index.js";
import { type PermissionSettings, permissionFrom, SHELL_FAMILY } from "./tool-gate.js";
import type { ToolSettingsMap, ToolSettingsRead } from "./tool-plane.js";

/** The store slice a wake reads and writes: the parked runs, their pinned revisions and journals, and the wake itself. */
export type WakeStore = Pick<Store, "runs" | "agents" | "readJournal">;

/** Whether a save moved some tool's permission to one that can read allow: a key whose permission changed and is now allow,
 *  or is no longer set (the tool's default, which may be allow). Only such a save can answer an ask by the setting. */
export function turnedTowardAllow(before: ToolSettingsMap, after: ToolSettingsMap): boolean {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key]?.permission;
    const now = after[key]?.permission;
    if (was !== now && (now === "allow" || now === undefined)) return true;
  }
  return false;
}

/**
 * Wakes every parked run with a call waiting on its person whose tool reads allow now on the run's pinned revision: its
 * own tool settings and approvals over the server's `read` (tool-gate.ts permissionFrom, the gate's one rule, a deny set
 * on the server absolute). A run whose waiting calls all still read ask or deny is left parked, never claimed. Answers
 * the runs woken.
 *
 * The run's gate stays the judge: the claim reads the settings again at the call, so a run woken here whose call reads
 * otherwise by then (a pin, a setting changed since) parks again or is refused, in the gate's words. Where the server
 * can't tell the run's answer, nothing is woken: settings that do not read (the gate holds to its last good read), and a
 * shell tool on its default, which is where the run's shell is (no computer: bash asks).
 */
export async function wakeAnsweredBySetting(store: WakeStore, read: ToolSettingsRead, before: ToolSettingsMap): Promise<string[]> {
  if (read.unreadable) return [];
  // A save that turned no tool toward allow (a provider alone, a pin, a deny kept) answers no ask: no run is listed, no journal read.
  if (!turnedTowardAllow(before, read.settings)) return [];
  const server = read.settings as unknown as PermissionSettings;
  const woken: string[] = [];
  for (const run of await store.runs.list({ state: "parked" })) {
    const entries = await journalEntries(store.readJournal(run.id), BACKGROUND_CONTEXT);
    const answers = answersOf(entries);
    // The ask names the call by its settings key (a shell tool by its own name), as the gate's askedAs gives it.
    const waiting = [...asksOf(entries).values()].filter((ask) => !ask.resolved && !(ask.id in answers)).map((ask) => ask.tool);
    if (waiting.length === 0) continue;
    const revision = await store.agents.revision(run.revisionId);
    const body = (revision?.body ?? {}) as { toolSettings?: unknown; approvals?: unknown };
    const agent = (body.toolSettings ?? {}) as PermissionSettings;
    const allowed = waiting.some((tool) => {
      const { permission, from } = permissionFrom(tool, server, agent, approvalsOf(body.approvals));
      return permission === "allow" && !(from === "default" && Object.hasOwn(SHELL_FAMILY, tool));
    });
    if (allowed && (await store.runs.wake(run.id))) woken.push(run.id);
  }
  return woken;
}
