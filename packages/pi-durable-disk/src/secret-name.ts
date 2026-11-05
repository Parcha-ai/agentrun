// The one rule for whether a variable's name is a secret's, by its name alone: what pi-durable-disk refuses in an
// instance's environment (hosts/attempt-env.ts, place.ts), and what agentrun-serve keeps out of a run's environment, cuts
// out of what an import keeps and out of a harness's log. One function, exported here for both.

/** The `_`-separated segments, in any case, that make a name a secret's. */
export const SECRET_SEGMENTS: readonly string[] = Object.freeze(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PAT", "CREDENTIAL", "CREDENTIALS", "DSN"]);
const SEGMENTS = new Set(SECRET_SEGMENTS);

/** The rule in words, for a message that names why a name was refused. */
export const SECRET_NAME_RULE = `a ${SECRET_SEGMENTS.slice(0, -1).join(", ")} or ${SECRET_SEGMENTS.at(-1)} segment, or a last PWD segment after another`;

/**
 * Whether `name` is a secret's name: one of its `_`-separated segments, in any case, is one of SECRET_SEGMENTS, or its last
 * segment is PWD after another (DB_PWD). Segments, not suffixes, so MODAL_TOKEN_ID, FOO_TOKEN_BAR and MY_TOKEN_FILE are
 * secrets' names, and CACHE_KEY_PREFIX too, which is the cheaper error; KEYBOARD, TOKENIZER, SECRETARY and PATTERN are
 * not. PWD alone and OLDPWD are the shell's working directories, never a secret's.
 */
export function keyShaped(name: string): boolean {
  const segments = name.toUpperCase().split("_");
  return segments.some((segment) => SEGMENTS.has(segment)) || (segments.length > 1 && segments.at(-1) === "PWD");
}
