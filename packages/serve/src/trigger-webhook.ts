// The signed webhook: a trigger source pushed to the server. A POST to /v2/hooks/{trigger_id}, signed under the
// trigger's own secret, is a firing, keyed by the sender's id for it. How it is signed is one of the schemes in
// trigger-signatures.ts, `signature` naming the trigger's (default `standard`): the request is checked by the scheme
// whose signature header it carries, and one of another scheme than its trigger's is refused as any bad signature is.
import { MIN_KEY_BYTES } from "./standard-webhooks.js";
import { closedSchema, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { DEFAULT_SCHEME, SCHEME_NAMES, SIGNATURE_SCHEMES, schemeOf } from "./trigger-signatures.js";

/** The scheme a trigger's source takes. */
const schemeName = (source: Source): string => (typeof source.signature === "string" ? source.signature : DEFAULT_SCHEME);

/** The source's own fields, checked: each issue through `bad`. Undefined when one does not read. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void): Source | undefined {
  let failed = false;
  if (value.signature !== undefined && !(SCHEME_NAMES as readonly unknown[]).includes(value.signature)) {
    failed = true;
    bad("signature", "not_an_option", `signature is one of ${SCHEME_NAMES.join(", ")} (default ${DEFAULT_SCHEME})`);
  }
  if (failed) return undefined;
  return { kind: "webhook", ...(value.signature !== undefined ? { signature: value.signature } : {}) };
}

export const webhook: TriggerAdapter = {
  id: "webhook",
  label: "webhook trigger",
  delivery: "push",
  owner: false,
  settings: { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES } } },
  describe: `{kind: "webhook", signature?: ${SCHEME_NAMES.map((name) => `"${name}"`).join(" | ")}}`,
  fires: "a signed request to /hooks/{trigger_id} (`webhook`)",
  firedBy: "`webhook`: a signed request to /hooks/{trigger_id}, its key from the trigger and the request's delivery id under its signature scheme (`webhook-id`, `X-GitHub-Delivery`).",
  schemas: [
    closedSchema(
      { kind: { const: "webhook" } },
      {
        signature: { enum: SCHEME_NAMES, default: DEFAULT_SCHEME, description: `How each request is signed; a request signed under another scheme is refused. ${SCHEME_NAMES.map((name) => SIGNATURE_SCHEMES[name].describe).join(" ")}` },
      },
    ),
  ],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "signature"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}) !== undefined,
  push: {
    maxBodyBytes: 256 << 10,
    key: "secret",
    headers(headers, nowMs) {
      const asked = schemeOf(headers);
      return "refusal" in asked ? asked.refusal : asked.scheme.precheck(headers, nowMs);
    },
    verify(key, headers, body, nowMs, source) {
      const asked = schemeOf(headers);
      if ("refusal" in asked) return asked.refusal;
      const refusal = asked.scheme.verify(key, headers, body, nowMs);
      // The trigger's scheme is checked after the signature, so a request of another scheme costs what any refusal does.
      return refusal ?? (source && schemeName(source) !== asked.name ? "other_scheme" : undefined);
    },
    // The request is the firing: its delivery id keys it, and its body, whatever it holds, is what the run is given.
    parse(headers, body) {
      const asked = schemeOf(headers);
      if ("refusal" in asked) return [];
      return [{ key: asked.scheme.deliveryIdOf(headers), text: body.toString("utf8") }];
    },
  },
};
