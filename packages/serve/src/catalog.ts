// The tool catalog's names, and the one mapping between a catalog name and the wire name a harness calls. A catalog name
// is what a revision writes (`read`, later `monid.discover`, `mcp:<server>/<tool>`); the wire name is what a CLI adapter
// registers and the model API sees, and both adapters refuse anything outside /^[A-Za-z0-9_-]{1,64}$/. The map is one
// deterministic, reversible function here, never in an adapter, so every harness gets the same wire name; the journal
// records the wire name (recovery matches a call by it), and a reader maps it back to the catalog name on the way out.
import { createHash } from "node:crypto";

/** A wire name: at most 52 characters, not the adapter's 64. One CLI gives the model the name with a 12-character
 *  `mcp__hands__` prefix, and the model API's 64-character limit is on the name the model sees, so 52 is the budget that
 *  holds on every harness. The one constant the identity branch and the length check both read: a plain 53-64 character
 *  name of valid characters must not skip the mapping and come out over budget. */
export const WIRE_NAME = /^[A-Za-z0-9_-]{1,52}$/;

/** A catalog name's wire name: itself when it already is one within the budget, else `:` and `/` to `__`, `.` to `_`,
 *  any other character to `_`, and a `-<8 hex of the catalog name>` suffix (prefix trimmed to fit) when the result is
 *  too long. The suffix makes a long name unique; a collision between two names is refused at the save (collisions,
 *  reverseOf), never suffixed away. The reverse is a lookup, never a parse. */
export function wireName(catalog: string): string {
  if (WIRE_NAME.test(catalog)) return catalog;
  const base = catalog.replace(/[:/]+/g, "__").replace(/[^A-Za-z0-9_-]/g, "_");
  if (base.length <= 52) return base;
  const tag = `-${createHash("sha256").update(catalog).digest("hex").slice(0, 8)}`;
  return base.slice(0, 52 - tag.length) + tag;
}

/** The reverse of {@link wireName} over `names`: a map from each name's wire name back to the catalog name. A collision
 *  (two catalog names with one wire name) throws here, so a catalog that would shadow a name never loads; the save path
 *  reports the same collision as a 422 before it reaches this. */
export function reverseOf(names: Iterable<string>): ReadonlyMap<string, string> {
  const reverse = new Map<string, string>();
  for (const name of names) {
    const wire = wireName(name);
    const had = reverse.get(wire);
    if (had !== undefined && had !== name) throw new Error(`the tools ${had} and ${name} both map to the wire name ${wire}`);
    reverse.set(wire, name);
  }
  return reverse;
}

/** The catalog names in `names` whose wire names collide, each paired with the name it clashes with: a definition that
 *  holds a pair is refused (a 422 on the second one), so {@link reverseOf} never throws for a loaded catalog. */
export function collisions(names: readonly string[]): { name: string; clashesWith: string }[] {
  const seen = new Map<string, string>();
  const clashes: { name: string; clashesWith: string }[] = [];
  for (const name of names) {
    const wire = wireName(name);
    const had = seen.get(wire);
    if (had !== undefined && had !== name) clashes.push({ name, clashesWith: had });
    else seen.set(wire, name);
  }
  return clashes;
}
