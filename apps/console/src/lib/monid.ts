import { isMonidName, MONID_NAME_WORDS, parseToolName } from "@agentrun/tool-names";
import type { SaveWarning } from "./agentForm";

// A monid grant's name, read by the server's own grammar (packages/serve/src/tool-names.ts, bundled from its source):
// monid:<provider>/<endpoint> for one endpoint, monid:<provider>/* for every endpoint of the provider that monid prices per
// call. The console checks only the shape, so a typo is said before a save; the save is the judge of the rest (whether
// monid lists it, and how monid prices it), read against monid's listing. isMonidName: the monid row shows a name in
// monid's namespace, well formed or not, never a tool card.
export { isMonidName };

/** A monid grant read: its provider, and its endpoint's path (null for the provider's wildcard). Undefined for a name
 *  outside the grammar. */
export function monidGrantOf(name: string): { provider: string; endpoint: string | null } | undefined {
  const parsed = parseToolName(name);
  if (parsed?.kind === "monid") return { provider: parsed.provider, endpoint: parsed.endpoint };
  return parsed?.kind === "monid-provider" ? { provider: parsed.provider, endpoint: null } : undefined;
}

/** Why `name` is no monid grant, in the server's words; undefined when it is one. */
export const monidNameProblem = (name: string): string | undefined => (monidGrantOf(name) ? undefined : MONID_NAME_WORDS(name));

/** What a person types, as the grant it is: trimmed, and `monid:` added when it was left off (`keenable/v1/search`), so
 *  the shape is checked on the name the save sends. */
export function monidGrantText(text: string): string {
  const t = text.trim();
  return !t || isMonidName(t) ? t : `monid:${t}`;
}

/** The field index of each `definition.tools[i]` that names a monid grant in `tools`: a save's answer (its 422 fields, its
 *  warnings) points at a grant by its place in the tools the save sent. */
export function monidFieldsOf(tools: readonly string[]): Map<string, string> {
  return new Map(tools.flatMap((tool, i) => (isMonidName(tool) ? [[`definition.tools[${i}]`, tool] as const] : [])));
}

/** A save's warnings split by what they are about: those at a monid grant (each endpoint monid prices by usage, in the
 *  server's words: granted, its charge able to pass its estimate; the run is not refused), and the rest (what this host
 *  lacks to run the revision). `tools`: the tools the saved revision holds. */
export function splitMonidWarnings(warnings: readonly SaveWarning[], tools: readonly string[]): { monid: { grant: string; warning: SaveWarning }[]; rest: SaveWarning[] } {
  const at = monidFieldsOf(tools);
  const monid: { grant: string; warning: SaveWarning }[] = [];
  const rest: SaveWarning[] = [];
  for (const w of warnings) {
    const grant = at.get(w.field);
    if (grant) monid.push({ grant, warning: w });
    else rest.push(w);
  }
  return { monid, rest };
}
