// Browser sign-ins under the secrets plan (SECRETS-PLAN.md, tl-browser's row: rules 1, 3 and 5). A saved sign-in is a
// sealed pointer to the browser vendor's object (a Browserbase context, a Kernel profile) that holds the agent's cookies.
//
// Rule 1, the writes: no route takes a browser credential in its body. A sign-in is saved inside a run (pi-browser opens
// the vendor's profile with save:true and the run path keeps its pointer, sealed, in store.signIns), never by an API
// write; the one browser route that changes a sign-in, DELETE /agents/{agent_id}/sign-ins/{key} (forgetSignIn), has no
// body. So this plane registers no secret-field predicate with secret-writes.ts, marks no field `x-agentrun-secret`, and
// gives the planted-secret harness no write route. browserBodyCredentials is the check that keeps it so.
//
// Rule 3, the views: each saved sign-in carries its one secret under `secret`, in the metadata shape every plane gives
// (signInSecretMeta), beside its own state (held | ready | unreadable). Never the pointer, a prefix, a length or a hash.

import { registerSecretWrite, type SecretMeta, type SecretPredicate, type SecretSource, secretMeta, secretName } from "./secret-writes.js";

export type { SecretMeta };

/** Where a saved sign-in's credential came from: a person signing in during a run. */
export const SIGN_IN_SOURCE: SecretSource = "sign-in";

/** A saved sign-in's secret as metadata (secret-writes.ts secretMeta): named secretName("sign-in", agent, provider), set (a
 *  row exists only with a sealed pointer, whether or not it opens here), from a sign-in, changed when its pointer was
 *  saved (the row's saved_at; a run verifying it, verified_at, keeps the same pointer and changes nothing). */
export function signInSecretMeta(row: { agentId: string; provider: string; savedAt: number }): SecretMeta {
  return secretMeta(secretName("sign-in", row.agentId, row.provider), { set: true, source: SIGN_IN_SOURCE, changedAt: new Date(row.savedAt) });
}

/** The browser plane's secret body fields, by operationId, for secret-writes.ts's one gate: none, since no browser route
 *  takes a credential in its body (rule 1 above). Registered below all the same, so a browser route that takes one is
 *  added here and gated with no other change. */
export const SIGN_IN_SECRET_FIELDS: Readonly<Record<string, SecretPredicate>> = {};
for (const [operationId, predicate] of Object.entries(SIGN_IN_SECRET_FIELDS)) registerSecretWrite(operationId, predicate);

/** The browser plane's secret write routes, for the planted-secret harness: none. A sign-in is saved inside a run (the
 *  vendor's profile with save:true, kept by the run path in store.signIns), never through an API write, so the harness
 *  plants one straight into the store (test/sign-ins-planted.mjs plantedSignIn) instead of through a route. */
export const SIGN_IN_WRITE_ROUTES: readonly string[] = [];

/** A request body field that names a browser credential: a vendor context or profile, a sign-in's pointer or ref, a
 *  sealed pointer, or a browser vendor's key. `pointer` alone is a JSON pointer (triggers' payload paths), not one. */
export const BROWSER_CREDENTIAL_FIELD = /^(?:ref|sign_?in_?ref|(?:browser_?)?context(?:_?id)?|profile(?:_?(?:id|name))?|(?:sealed_?pointer|pointer_?sealed)|(?:browserbase|kernel)_?api_?key)$/i;
/** A field of a browser operation's body that names any credential at all (a key, a token, a secret, a cookie...). */
const ANY_CREDENTIAL_FIELD = /(?:api_?key|token|secret|password|passwd|cookie|session|bearer|authorization|credential|sealed|context|profile|^ref$|pointer)/i;

type Json = Record<string, unknown>;

/** The browser plane's operations in an OpenAPI document and what their bodies name: `operations` (by operationId, the
 *  tool settings' browser pick as `putToolSettings#browser`), `credentials` (a credential field in a browser operation's
 *  body, as `operationId.field.path`), `anywhere` (a browser credential field in any operation's body), and `bodies` (the
 *  browser operations' body schemas, resolved). A browser operation is one whose path holds `/sign-ins` or `/browser`,
 *  or that is tagged `sign-ins` or `browser`. */
export function browserBodyCredentials(doc: Json): { operations: string[]; credentials: string[]; anywhere: string[]; bodies: unknown[] } {
  const resolve = (value: unknown): unknown => {
    const ref = (value as { $ref?: unknown } | null)?.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return value;
    return resolve(ref.slice(2).split("/").reduce<unknown>((at, key) => (at as Json | undefined)?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc));
  };
  /** Each property of `schema` (nested, through items, compositions and conditions), as `at.name`. */
  const fields = (schema: unknown, at: string, seen = new Set<unknown>()): Array<{ name: string; path: string; schema: unknown }> => {
    const s = resolve(schema) as Json | undefined;
    if (!s || typeof s !== "object" || seen.has(s)) return [];
    seen.add(s);
    const out: Array<{ name: string; path: string; schema: unknown }> = [];
    for (const [name, inner] of Object.entries((s.properties as Json | undefined) ?? {})) {
      out.push({ name, path: `${at}.${name}`, schema: inner }, ...fields(inner, `${at}.${name}`, seen));
    }
    for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) if (s[key] && typeof s[key] === "object") out.push(...fields(s[key], at, seen));
    for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) for (const inner of (s[key] as unknown[] | undefined) ?? []) out.push(...fields(inner, at, seen));
    for (const inner of Object.values((s.patternProperties as Json | undefined) ?? {})) out.push(...fields(inner, at, seen));
    return out;
  };
  const bodyOf = (op: Json): unknown[] => Object.values(((resolve(op.requestBody) as Json | undefined)?.content as Record<string, Json> | undefined) ?? {}).map((media) => media.schema);
  const operations: string[] = [];
  const credentials: string[] = [];
  const anywhere: string[] = [];
  const bodies: unknown[] = [];
  for (const [path, item] of Object.entries((doc.paths as Record<string, Json> | undefined) ?? {})) {
    for (const op of Object.values(item) as Json[]) {
      if (!op || typeof op !== "object" || typeof op.operationId !== "string") continue;
      const id = op.operationId;
      const body = bodyOf(op).flatMap((schema) => fields(schema, id));
      for (const field of body) if (BROWSER_CREDENTIAL_FIELD.test(field.name)) anywhere.push(field.path);
      const tags = (op.tags as string[] | undefined) ?? [];
      const browser = /\/(?:sign-ins|browser)(?:\/|$)/.test(path) || tags.includes("sign-ins") || tags.includes("browser");
      // The tool settings' browser pick (which vendor a run's browser is on) is the browser plane's too.
      const picks = body.filter((field) => field.name === "browser");
      if (browser) {
        operations.push(id);
        bodies.push(...bodyOf(op).map(resolve));
        for (const field of body) if (ANY_CREDENTIAL_FIELD.test(field.name)) credentials.push(field.path);
      } else if (picks.length) {
        operations.push(`${id}#browser`);
        for (const pick of picks) {
          bodies.push(resolve(pick.schema));
          for (const field of fields(pick.schema, pick.path)) if (ANY_CREDENTIAL_FIELD.test(field.name)) credentials.push(field.path);
        }
      }
    }
  }
  return { operations: [...new Set(operations)], credentials, anywhere, bodies };
}
