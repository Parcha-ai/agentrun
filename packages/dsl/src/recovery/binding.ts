// A run's binding: what a durable record of the run was opened under. A binding is the hash of the host's inputs; its
// per-input digests let a refused open name the inputs that moved.
import { canonicalHash } from "./canonical-hash.js";
import { RecoveryError } from "./errors.js";

/** The digest of each input a binding covers, named by its path: one entry per key of `parts`, and
 *  one per key of a part that is itself an object ("config.question", "binding.budget"). Stored beside
 *  the binding, they let a mismatch name the inputs that moved instead of only saying one did. */
export function bindingDigests(parts: Record<string, unknown>): Record<string, string> {
  // An omitted input has no digest, as the binding's own JSON omits it: a change between omitted and
  // null is then named as an input that is new or gone.
  const digests: Record<string, string> = {};
  for (const [name, value] of Object.entries(parts)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) if (inner !== undefined) digests[`${name}.${key}`] = canonicalHash(inner);
    } else digests[name] = canonicalHash(value);
  }
  return digests;
}

/** Why a store refuses a binding: the inputs whose digests differ from the ones it was bound with. */
export function bindingMismatch(stored: string | null, given: Record<string, string> | undefined): RecoveryError {
  let recorded: Record<string, string> | null = null;
  try { recorded = stored ? JSON.parse(stored) : null; } catch { recorded = null; }
  if (!recorded || !given) {
    return Object.assign(new RecoveryError(`Run store binding mismatch: ${!recorded ? "the store was bound before its input digests were recorded" : "the opener named no input digests"}, so the input that moved cannot be named`, "RUN_STORE_BINDING_MISMATCH"), { moved: null });
  }
  const moved = [...new Set([...Object.keys(recorded), ...Object.keys(given)])].filter((name) => recorded![name] !== given[name]).sort();
  const described = moved.map((name) => !(name in recorded!) ? `${name} (new)` : !(name in given) ? `${name} (gone)` : name);
  return Object.assign(new RecoveryError(`Run store binding mismatch: ${moved.length ? `${described.join(", ")} changed since the run was bound` : "every named input matches, so the change is in how the binding is composed"}`, "RUN_STORE_BINDING_MISMATCH"), { moved });
}

/** The format of what a run's store holds for a resume. Every binding carries it, so a store written under
 *  another format is refused, never resumed as if it held the same record. */
export const LEDGER_FORMAT = 3;
