import type { ClientError } from "./client";

export type AuthMode = "signed_in" | "sign_in" | "setup" | "token_link";

/** Where the person stands, from `GET /v2/auth/session`: no password yet (the first visit sets it), a password and no
 *  session (sign in), or signed in. A server without accounts has no session route (404): it is reached through the
 *  link it printed, which carries its token once. */
export function authMode(r: { status: number; body: unknown }): AuthMode {
  if (r.status === 404) return "token_link";
  const s = (r.body ?? {}) as { password_set?: boolean; signed_in?: boolean };
  if (s.signed_in) return "signed_in";
  return s.password_set ? "sign_in" : "setup";
}

/** A refused sign-in or setup, in plain words; otherwise the server's own message. */
export function signInProblem(e: ClientError): string {
  if (e.status === 401) return "That is not the password.";
  if (e.status === 429) return "Too many sign-ins from here. Try again in 15 minutes.";
  if (e.status === 403 && /has its owner/.test(e.message)) return "This server has its owner already: sign in.";
  if (e.status === 403 && /setup code/.test(e.message)) return "That setup code is not the one in the server's log, or it has expired.";
  return e.fields?.[0]?.message ?? e.message;
}
