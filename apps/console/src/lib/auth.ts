import type { ClientError } from "./client";

export type AuthMode = "signed_in" | "sign_in" | "setup" | "token_link";

/** Where the person stands, from `GET /v2/auth/session`: no password yet (the first visit sets it), a password and no
 *  session (sign in), or signed in. A server without accounts has no session route (404): it is reached through the
 *  link it printed, which carries its token once, unless `probe` (the status of a protected read) says the browser is
 *  in already. */
export function authMode(r: { status: number; body: unknown }, probe?: number): AuthMode {
  // No accounts: a protected read that already succeeds (a token the request carries) is in; otherwise use the link.
  if (r.status === 404) return probe === 200 ? "signed_in" : "token_link";
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

/** The setup code the server's printed link carries (`#code=`), taken once: the rest of the fragment is what the
 *  address keeps, so the code does not stay in the URL or the history (as the server's own setup page does). */
export function takeSetupCode(hash: string): { code: string | null; rest: string } {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const code = params.get("code");
  if (code === null) return { code: null, rest: hash };
  params.delete("code");
  const left = params.toString();
  return { code, rest: left ? `#${left}` : "" };
}
