import type { SaveWarning } from "./agentForm";

// A monid grant's name, as the server reads it (packages/serve/src/tool-names.ts, the one grammar): monid:<provider>/<endpoint>
// for one endpoint, monid:<provider>/* for every endpoint of the provider that monid prices per call. The provider's slug and
// the endpoint's path are monid's own. The console checks only the shape, so a typo is said before a save; the save is the
// judge of the rest (whether monid lists it, and how monid prices it), read against monid's listing.
const PROVIDER = "[a-z0-9][a-z0-9.-]{0,63}";
const ENDPOINT = "[A-Za-z0-9_.:{}-][A-Za-z0-9_.:{}/-]{0,199}";
const MONID_NAME = new RegExp(`^monid:(${PROVIDER})/(\\*|${ENDPOINT})$`);

/** The two sources the grammar's parity test reads against the server's. */
export const MONID_GRAMMAR = { PROVIDER, ENDPOINT } as const;

/** Whether `name` is in monid's namespace (`monid:`), well formed or not: the monid row shows it, never a tool card. */
export const isMonidName = (name: string): boolean => name.startsWith("monid:");

/** A monid grant read: its provider, and its endpoint's path (null for the provider's wildcard). Undefined for a name
 *  outside the grammar. */
export function monidGrantOf(name: string): { provider: string; endpoint: string | null } | undefined {
  const m = MONID_NAME.exec(name);
  return m ? { provider: m[1]!, endpoint: m[2] === "*" ? null : m[2]! } : undefined;
}

/** Why `name` is no monid grant, in the server's words (tool-names.ts MONID_NAME_WORDS); undefined when it is one. */
export function monidNameProblem(name: string): string | undefined {
  if (monidGrantOf(name)) return undefined;
  return `${name} is not a monid endpoint's name: monid:<provider>/<endpoint> or monid:<provider>/*, the provider's slug (lowercase letters, digits, . and -) and the endpoint's path without its first / (letters, digits and -._:{}/), as monid lists them.`;
}

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

/** A save's warnings split by what they are about: those at a monid grant (each endpoint a wildcard left out, monid's
 *  pricing in the server's words: the run is not refused, the endpoint just isn't granted), and the rest (what this host
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
