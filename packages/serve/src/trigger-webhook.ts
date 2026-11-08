// The signed webhook: a trigger source pushed to the server. A POST to /v2/hooks/{trigger_id}, signed under the
// trigger's own secret, is a firing, keyed by the sender's id for it. How it is signed is one of the schemes in
// trigger-signatures.ts, `signature` naming the trigger's (default `standard`): the request is checked by the scheme
// whose signature header it carries, and one of another scheme than its trigger's is refused as any bad signature is.
// `accept` (trigger-accept.ts) takes only the events it names, and a trigger with it starts a run per event it takes.
import { MIN_KEY_BYTES } from "./standard-webhooks.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { DEFAULT_SCHEME, SCHEME_NAMES, SIGNATURE_SCHEMES, schemeOf } from "./trigger-signatures.js";

/** The longest of a sender's event names a log line keeps. */
const ATTR_CHARS = 200;

/** The scheme a trigger's source takes. */
const schemeName = (source: Source): string => (typeof source.signature === "string" ? source.signature : DEFAULT_SCHEME);

/** The source's own fields, checked: each issue through `bad`. Undefined when one does not read. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void): Source | undefined {
  let failed = false;
  if (value.signature !== undefined && !(SCHEME_NAMES as readonly unknown[]).includes(value.signature)) {
    failed = true;
    bad("signature", "not_an_option", `signature is one of ${SCHEME_NAMES.join(", ")} (default ${DEFAULT_SCHEME})`);
  }
  const accept = value.accept === undefined ? undefined : acceptOf(value.accept, (...args) => ((failed = true), bad(...args)));
  if (failed) return undefined;
  return { kind: "webhook", ...(value.signature !== undefined ? { signature: value.signature } : {}), ...(accept ? { accept } : {}) };
}

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const webhook: TriggerAdapter = {
  id: "webhook",
  label: "webhook trigger",
  delivery: "push",
  owner: false,
  settings: { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES } } },
  describe: `{kind: "webhook", signature?: ${SCHEME_NAMES.map((name) => `"${name}"`).join(" | ")}, accept?: [{event, actions?, where?}]}`,
  fires: "a signed request to /hooks/{trigger_id} (`webhook`) that its `accept` takes",
  firedBy: "`webhook`: a signed request to /hooks/{trigger_id}, its key from the trigger and the request's delivery id under its signature scheme (`webhook-id`, `X-GitHub-Delivery`).",
  schemas: [
    closedSchema(
      { kind: { const: "webhook" } },
      {
        signature: { enum: SCHEME_NAMES, default: DEFAULT_SCHEME, description: `How each request is signed; a request signed under another scheme is refused. ${SCHEME_NAMES.map((name) => SIGNATURE_SCHEMES[name].describe).join(" ")}` },
        accept: ACCEPT_SCHEMA,
      },
    ),
  ],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "signature", "accept"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}) !== undefined,
  concurrent: (source) => source.accept !== undefined,
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
    // The request is the firing: its delivery id keys it, and its body, whatever it holds, is what the run is given. A
    // trigger with `accept` takes only the events it names, the event as its scheme reads it.
    parse(headers, body, source) {
      const asked = schemeOf(headers);
      if ("refusal" in asked) return [];
      const text = body.toString("utf8");
      const rules = source?.accept as Rule[] | undefined;
      if (rules) {
        const doc = jsonOf(text);
        const event = asked.scheme.eventOf(headers, doc);
        const ignored = acceptRefusal(rules, event, doc);
        if (ignored) return { ignored, ...(event !== undefined ? { event: event.slice(0, ATTR_CHARS) } : {}) };
      }
      return [{ key: asked.scheme.deliveryIdOf(headers), text }];
    },
  },
};
