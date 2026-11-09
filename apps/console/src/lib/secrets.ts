import { useEffect, useState } from "react";
import type { SecretMeta } from "./v2";

/** Where a secret comes from, as every page says it. */
export const SOURCE_WORDS: Record<NonNullable<SecretMeta["source"]>, string> = { env: "Set in the environment", console: "Pasted here", "sign-in": "From sign-in" };
/** Where a secret's name ("<plane>:<id>") has its field: after the plane for a key (tool:<KEY>, model:<KEY>), after the
 *  plane and its owner for the others (mcp:<server>:<field>, computer:<provider>:<KEY>, source:<adapter>:<field>). */
const FIELD_AT: Record<string, number> = { tool: 1, model: 1, mcp: 2, computer: 2, source: 2 };
/** A secret as a page says it, never its "<plane>:<id>" name: the field the name ends in (BROWSERBASE_API_KEY,
 *  X-Api-Key), else the page's own label ("Bearer token", "Signing secret"), else its id without the plane. */
export function secretLabel(name: string, label?: string): string {
  const parts = name.split(":");
  const at = FIELD_AT[parts[0]!];
  const field = at === undefined ? "" : parts.slice(at).join(":");
  return field || label || parts.slice(1).join(":");
}

/** Said once on a page holding secrets when this session may not change them. */
export const SIGN_IN_TO_CHANGE = "Sign in with your password to change secrets.";

/** Whether this session may paste, replace or remove a secret. BASE DEFAULT: this base's session read has no
 *  secrets_writable and its server does not gate secret writes yet, so a session may unless the read says false; the
 *  secrets slice drops this `?? true` in a named commit when it lands. */
export function useSecretsWritable(v2: { session: () => Promise<{ status: number; body: unknown }> }): boolean {
  const [writable, setWritable] = useState(true);
  useEffect(() => {
    let live = true;
    v2.session().then((r) => {
      const body = r.body;
      if (live) setWritable(!(r.status === 200 && typeof body === "object" && body !== null && "secrets_writable" in body && body.secrets_writable === false));
    }, () => {});
    return () => { live = false; };
  }, [v2]);
  return writable;
}
