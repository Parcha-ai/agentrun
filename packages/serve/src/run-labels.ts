// A run's labels: a small map of the caller's own strings, given at its start (POST /agents/{agent_id}/runs, POST /runs),
// kept on the run, served on every read of it, and filtered on by GET /runs (`label=<key>:<value>`). The server never reads
// them otherwise: they are the caller's way to find its runs again (its own ids for a run, a job, a tenant). They are no
// place for a secret: every read of the run serves them as given.
import { ApiError, type InputIssue } from "./errors.js";
import type { RunLabels } from "./store/store.js";

/** At most this many labels on a run. */
export const MAX_LABELS = 16;
/** A label's key: 1 to 63 characters, letters, digits and `.`, `_`, `-`, `/`, starting with a letter or a digit. No `:`, so
 *  a filter's `<key>:<value>` splits at its first one. */
export const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
/** A label's value: text of 1 to this many characters. */
export const MAX_LABEL_VALUE = 256;
/** No control character in a value: a label is shown as one line. */
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a value is not a label's, or undefined when it is one. */
function valueProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "is text";
  if (value.length < 1 || value.length > MAX_LABEL_VALUE) return `is text of 1 to ${MAX_LABEL_VALUE} characters`;
  if (CONTROL.test(value)) return "holds no control character (a newline, a tab, NUL)";
  return undefined;
}

/** A create body's `labels`, field by field: an object of at most MAX_LABELS keys, each matching LABEL_KEY, each value text
 *  of 1 to MAX_LABEL_VALUE characters with no control character. Absent is none. */
export function labelsIssues(labels: unknown): InputIssue[] {
  if (labels === undefined) return [];
  if (!isObject(labels)) return [{ field: "labels", reason: "wrong_type", message: "labels is an object of text values: {\"<key>\": \"<value>\"}" }];
  const issues: InputIssue[] = [];
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABELS) issues.push({ field: "labels", reason: "too_many", message: `labels holds at most ${MAX_LABELS} keys; it holds ${keys.length}.` });
  for (const key of keys) {
    if (!LABEL_KEY.test(key)) {
      issues.push({ field: `labels.${key}`, reason: "bad_format", message: `A label's key is 1 to 63 letters, digits, '.', '_', '-' or '/', starting with a letter or a digit: ${JSON.stringify(key)} is not one.` });
      continue;
    }
    const problem = valueProblem(labels[key]);
    if (problem) issues.push({ field: `labels.${key}`, reason: typeof labels[key] === "string" ? "bad_format" : "wrong_type", message: `labels.${key} ${problem}.` });
  }
  return issues;
}

/** A create body's labels, once labelsIssues found none: the map as given, or undefined when absent or empty. */
export function labelsOf(labels: unknown): RunLabels | undefined {
  if (!isObject(labels) || Object.keys(labels).length === 0) return undefined;
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
}

/** GET /runs' `label` parameters, each `<key>:<value>` (split at the first `:`, which a key never holds): the labels a run
 *  must hold, every one. 400 bad_request for one that does not read, more than MAX_LABELS, or one key asked for twice with
 *  two values (no run holds both). */
export function labelFilter(given: readonly string[]): RunLabels | undefined {
  if (given.length === 0) return undefined;
  if (given.length > MAX_LABELS) throw new ApiError("bad_request", `label is given at most ${MAX_LABELS} times`);
  const filter: Record<string, string> = {};
  for (const one of given) {
    const at = one.indexOf(":");
    const key = at < 0 ? one : one.slice(0, at);
    const value = at < 0 ? undefined : one.slice(at + 1);
    if (!LABEL_KEY.test(key) || value === undefined || valueProblem(value) !== undefined) {
      throw new ApiError("bad_request", `label is <key>:<value>, a label's key and its value (${JSON.stringify(one)} is not one)`);
    }
    if (Object.hasOwn(filter, key) && filter[key] !== value) throw new ApiError("bad_request", `label names the key ${key} twice with two values: a run holds one value for a key`);
    filter[key] = value;
  }
  return filter;
}
