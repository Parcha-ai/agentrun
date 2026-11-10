// The server's API tokens: the token (AGENTRUN_TOKEN, else the one DIR/.token keeps) and, while callers move to a new
// one, the next token (AGENTRUN_TOKEN_NEXT). The server takes either as the Bearer on every route the token opens, so a
// rotation never refuses a caller: add the next token, move every caller to it, then make it the token and drop the
// old one. Every check of a presented token goes through bearerCheck here, in constant time.
import { createHash, timingSafeEqual } from "node:crypto";

/** The variable that names the next token, taken beside the token during a rotation. A secret, as AGENTRUN_TOKEN is. */
export const TOKEN_NEXT_ENV = "AGENTRUN_TOKEN_NEXT";

/** Why `token` (from `name`) is no API token, in words; undefined when it is one: 32 characters or more, no whitespace. */
export function tokenProblem(token: string, name = "the token"): string | undefined {
  return token.length < 32 || /\s/.test(token) ? `${name} must be 32 characters or more, with no whitespace` : undefined;
}

/** The tokens a server takes, in order: the token, then the next token when one is given and is not the token already. */
export function acceptedTokens(token: string, next: string | undefined): readonly string[] {
  return next === undefined || next === token ? [token] : [token, next];
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/** A test of an Authorization header: true when it is exactly `Bearer <one of tokens>`. The header and each token's
 *  `Bearer ` line are hashed first, so every comparison is of two 32-byte digests whatever was sent, and `equal`
 *  (node:crypto's timingSafeEqual) compares them in constant time. Every token is compared on every call, with no early
 *  return on a match, so the time taken says neither whether a token matched nor which. */
export function bearerCheck(tokens: readonly string[], equal: (a: Buffer, b: Buffer) => boolean = timingSafeEqual): (header: string | undefined) => boolean {
  if (tokens.length === 0) throw new TypeError("a server takes at least one token");
  const expected = tokens.map((token) => digest(`Bearer ${token}`));
  return (header) => {
    const given = digest(String(header ?? ""));
    let matched = 0;
    for (const want of expected) matched |= equal(given, want) ? 1 : 0;
    return matched === 1;
  };
}
