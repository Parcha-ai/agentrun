import { MECHANICAL_PREDICATES } from "./vocabulary.js";

export type StopPredicate =
  | { predicate: "no_new_items"; key: string }
  | { predicate: "field_true"; path: string }
  | { predicate: "count_gte"; path: string; n: number }
  | { predicate: "empty"; path: string }
  | { predicate: "gte"; path: string; n: number }
  | { predicate: "lt"; path: string; n: number };

export type AcceptPredicate =
  | StopPredicate
  | { predicate: "field_equals"; path: string; value: string | number | boolean }
  | { predicate: "in"; path: string; values: Array<string | number | boolean> };


export const MECHANICAL_PREDICATE_NAMES: ReadonlySet<string> = new Set(MECHANICAL_PREDICATES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a dotted state path the one way every reader does: a record by key, an array by a
 *  non-negative integer index, anything else (a string, a number, a missing value) to undefined.
 *  `requires`, interpolation, `itemsPath`, `output.path` and predicates all read through here, so a
 *  path that names a value for one names it for all. */
export function getPath(value: unknown, key: string): unknown {
  if (!key) return value;
  return key.split(".").reduce<unknown>((current, part) => {
    if (isRecord(current)) return current[part];
    if (Array.isArray(current)) return /^(0|[1-9][0-9]*)$/.test(part) ? current[Number(part)] : undefined;
    return undefined;
  }, value);
}

export function predicateMatches(predicate: StopPredicate | AcceptPredicate, value: unknown): boolean {
  switch (predicate.predicate) {
    case "field_equals":
      return getPath(value, predicate.path) === predicate.value;
    case "field_true":
      return getPath(value, predicate.path) === true;
    case "in": {
      const target = getPath(value, predicate.path);
      return (typeof target === "string" || typeof target === "number" || typeof target === "boolean") && predicate.values.includes(target);
    }
    case "empty": {
      const target = getPath(value, predicate.path);
      return Array.isArray(target) ? target.length === 0 : target === "" || target === null || target === undefined;
    }
    case "count_gte": {
      const target = getPath(value, predicate.path);
      const count = Array.isArray(target) ? target.length : typeof target === "number" ? target : 0;
      return count >= predicate.n;
    }
    case "no_new_items": {
      const target = getPath(value, (predicate as { key: string }).key);
      return Array.isArray(target) ? target.length === 0 : !target;
    }
    case "gte":
    case "lt": {
      const target = getPath(value, predicate.path);
      if (typeof target !== "number" || !Number.isFinite(target)) return false;
      return predicate.predicate === "gte" ? target >= predicate.n : target < predicate.n;
    }
    default:
      throw new Error(
        `agentrun: unsupported predicate "${String((predicate as any)?.predicate ?? "")}" — fail closed, never silently false`,
      );
  }
}
