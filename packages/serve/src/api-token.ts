// The server's API tokens: a list of named tokens, any of which opens every route the token opens. AGENTRUN_TOKENS holds
// the list as `id:secret` entries; AGENTRUN_TOKEN (else the one DIR/.token keeps) is the entry named `default`. A
// rotation never refuses a caller: add the new token as an entry, move every caller to it, then remove the old entry.
// Every check of a presented token goes through bearerCheck here, against every entry, in constant time, and answers
// which entry matched (its id, never its secret) for the request's log line.
import { createHash, timingSafeEqual } from "node:crypto";

/** The variable that holds the token list. A secret, as AGENTRUN_TOKEN is. */
export const TOKENS_ENV = "AGENTRUN_TOKENS";
/** The id of the token AGENTRUN_TOKEN (or DIR/.token) gives. */
export const DEFAULT_TOKEN_ID = "default";

/** One API token: `id` names it in log lines and the banner; `token` is the secret a caller sends as its Bearer. */
export type ApiToken = { readonly id: string; readonly token: string };

/** A token's id: a letter or digit, then up to 31 letters, digits, `.`, `_` or `-`. Never a secret, so a log may hold it. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Why `token` (from `name`) is no API token, in words; undefined when it is one: 32 characters or more, no whitespace. */
export function tokenProblem(token: string, name = "the token"): string | undefined {
  return token.length < 32 || /\s/.test(token) ? `${name} must be 32 characters or more, with no whitespace` : undefined;
}

/** AGENTRUN_TOKENS read: entries `id:secret`, separated by commas, whitespace or newlines; the first `:` ends the id.
 *  An empty or blank value is no list (undefined), as an empty AGENTRUN_TOKEN is no token. Throws, in words that never
 *  hold a secret, on an entry with no `:`, an id outside ID, a secret that breaks the token's rules or holds a comma
 *  (the separator), or an id used twice. */
export function parseTokens(text: string | undefined): ApiToken[] | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const entries = text.split(/[\s,]+/).filter((entry) => entry !== "");
  return entries.map((entry, index) => {
    const colon = entry.indexOf(":");
    if (colon < 0) throw new Error(`${TOKENS_ENV} entry ${index + 1} is not id:secret`);
    const id = entry.slice(0, colon);
    const token = entry.slice(colon + 1);
    if (!ID.test(id)) throw new Error(`${TOKENS_ENV} entry ${index + 1}'s id must be a letter or digit, then up to 31 letters, digits, ".", "_" or "-"`);
    const problem = tokenProblem(token, `${TOKENS_ENV} entry ${id}'s secret`);
    if (problem) throw new Error(problem);
    return { id, token };
  });
}

/** The tokens a server takes, in order: AGENTRUN_TOKEN's (or DIR/.token's) as `default` when there is one, then the
 *  list's. The first is the server's token: the one the console's session header stands for. Throws when there is none,
 *  when an id is used twice (a log line could not say which token was used) or when one secret is given twice. */
export function acceptedTokens(token: string | undefined, list: readonly ApiToken[] | undefined): readonly ApiToken[] {
  const all = [...(token === undefined ? [] : [{ id: DEFAULT_TOKEN_ID, token }]), ...(list ?? [])];
  if (all.length === 0) throw new TypeError("a server takes at least one token");
  const ids = new Set<string>();
  const secrets = new Set<string>();
  for (const entry of all) {
    if (ids.has(entry.id)) throw new Error(`the API token id ${entry.id} is used twice${entry.id === DEFAULT_TOKEN_ID ? ` (AGENTRUN_TOKEN is ${DEFAULT_TOKEN_ID})` : ""}`);
    if (secrets.has(entry.token)) throw new Error(`the API token ${entry.id} has the same secret as another token`);
    ids.add(entry.id);
    secrets.add(entry.token);
  }
  return all;
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/** A test of an Authorization header: the id of the token when it is exactly `Bearer <that token's secret>`, else
 *  undefined. The header and each token's `Bearer ` line are hashed first, so every comparison is of two 32-byte digests
 *  whatever was sent, and `equal` (node:crypto's timingSafeEqual) compares them in constant time. Every token is
 *  compared on every call, with no early return on a match, so the time taken says neither whether a token matched nor
 *  which. */
export function bearerCheck(tokens: readonly ApiToken[], equal: (a: Buffer, b: Buffer) => boolean = timingSafeEqual): (header: string | undefined) => string | undefined {
  if (tokens.length === 0) throw new TypeError("a server takes at least one token");
  const expected = tokens.map((entry) => digest(`Bearer ${entry.token}`));
  return (header) => {
    const given = digest(String(header ?? ""));
    let found = -1;
    for (let i = 0; i < expected.length; i++) {
      const hit = equal(given, expected[i]!);
      found = hit ? i : found;
    }
    return found < 0 ? undefined : tokens[found]!.id;
  };
}
