import { useEffect, useState } from "react";
import type { SecretField, SessionSecrets } from "./v2";

/** Where a secret comes from, as every page says it. */
export const SOURCE_WORDS: Record<NonNullable<SecretField["source"]>, string> = { env: "Set in the environment", console: "Pasted here", "sign-in": "From sign-in" };
/** Said once on a page holding secrets when this session may not change them, by why: accounts on and not the owner's
 *  password session; or a server with no accounts that isn't on loopback. */
export const SIGN_IN_TO_CHANGE = "Sign in with your password to change secrets.";
export const NO_ACCOUNTS = "This server has no accounts: set secrets in its environment, or turn accounts on to change them here.";
/** A browser on the API token alone: the token never writes a secret; the launcher's link opens a session that may. */
export const TOKEN_ONLY = "Open the console from the server's link to change secrets.";
export type SecretsWhyNot = NonNullable<SessionSecrets["secrets_reason"]>;
export const WHY_NOT_WORDS: Record<SecretsWhyNot, string> = { sign_in: SIGN_IN_TO_CHANGE, no_accounts: NO_ACCOUNTS, token: TOKEN_ONLY };

const sessionOf = (r: { status: number; body: unknown }): SessionSecrets | null => (r.status === 200 && !!r.body && typeof r.body === "object" ? (r.body as SessionSecrets) : null);

/** Whether this session may paste, replace or remove a secret: the server's word alone (secrets_writable), on a server
 *  with accounts or without. Anything else (a token-only browser, no session read, a read that failed) may not. */
export const secretsWritableOf = (r: { status: number; body: unknown }): boolean => sessionOf(r)?.secrets_writable === true;

/** Why this session may not: the server's reason; else, a server with no accounts (its read 404, or `accounts: false`)
 *  is "no_accounts", any other "sign_in". */
export function secretsWhyNot(r: { status: number; body: unknown }): SecretsWhyNot {
  const s = sessionOf(r);
  if (s?.secrets_reason) return s.secrets_reason;
  return r.status === 404 || s?.accounts === false ? "no_accounts" : "sign_in";
}

/** This page's session, read once: whether it may change secrets, and why not. Not writable until the read answers. */
export function useSecrets(v2: { session: () => Promise<{ status: number; body: unknown }> }): { writable: boolean; whyNot: SecretsWhyNot } {
  const [state, setState] = useState<{ writable: boolean; whyNot: SecretsWhyNot }>({ writable: false, whyNot: "sign_in" });
  useEffect(() => {
    let live = true;
    v2.session().then((r) => { if (live) setState({ writable: secretsWritableOf(r), whyNot: secretsWhyNot(r) }); }, () => {});
    return () => { live = false; };
  }, [v2]);
  return state;
}
