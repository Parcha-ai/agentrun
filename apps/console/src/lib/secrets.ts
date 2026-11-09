import { useEffect, useState } from "react";
import type { SecretField, SessionSecrets } from "./v2";

/** Where a secret comes from, as every page says it. */
export const SOURCE_WORDS: Record<NonNullable<SecretField["source"]>, string> = { env: "Set in the environment", console: "Pasted here", "sign-in": "From sign-in" };
/** Said once on a page holding secrets, off the owner's password session. */
export const SIGN_IN_TO_CHANGE = "Sign in with your password to change secrets.";

/** Whether this session may paste, replace or remove a secret: only the owner's password session, which the session read
 *  says (secrets_writable). Anything else (a token, a server without accounts, a read that failed) may not. */
export const secretsWritableOf = (r: { status: number; body: unknown }): boolean =>
  r.status === 200 && !!r.body && typeof r.body === "object" && (r.body as SessionSecrets).secrets_writable === true;

/** secretsWritableOf for this page's session, read once: false until the read answers. */
export function useSecretsWritable(v2: { session: () => Promise<{ status: number; body: unknown }> }): boolean {
  const [writable, setWritable] = useState(false);
  useEffect(() => {
    let live = true;
    v2.session().then((r) => { if (live) setWritable(secretsWritableOf(r)); }, () => {});
    return () => { live = false; };
  }, [v2]);
  return writable;
}
