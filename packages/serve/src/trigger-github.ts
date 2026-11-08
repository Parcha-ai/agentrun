// GitHub: a trigger source pushed to the server by its one GitHub App (github-connection.ts), at the App's one hook,
// /v2/hooks/github, verified with the App's webhook secret (trigger-signatures.ts's github scheme). A trigger names the
// events it takes (accept, trigger-accept.ts) and keeps no secret of its own; one event fires every trigger that takes
// it, each its own firing, keyed by the SHA-256 of the signed body (GitHub signs neither X-GitHub-Delivery nor
// X-GitHub-Event). The App's ping is answered, and its installation events go to the connection, which checks each with
// GitHub before it keeps its installation list or turns the github triggers off.
import { FIELDS } from "./github-connection.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { type Scheme, SIGNATURE_SCHEMES } from "./trigger-signatures.js";
import { isObject } from "./validate.js";

/** The longest of a sender's words a payload's attrs keep. */
const ATTR_CHARS = 200;
const scheme: Scheme = SIGNATURE_SCHEMES.github;

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const cut = (text: string) => text.slice(0, ATTR_CHARS);

/** The source's fields, checked: each issue through `bad`. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void): Source | undefined {
  if (value.accept === undefined) return bad("accept", "missing", "accept lists the GitHub events this trigger takes ({event, actions?, where?}): a github trigger takes only the events it names"), undefined;
  const accept = acceptOf(value.accept, bad);
  return accept ? { kind: "github", accept } : undefined;
}

export const github: TriggerAdapter = {
  id: "github",
  label: "GitHub trigger",
  delivery: "push",
  owner: false,
  // The connection's App, the server's one: its secrets, and what is no secret beside them (github-connection.ts).
  settings: { scope: "server", fields: { [FIELDS.appId]: { public: true }, [FIELDS.slug]: { public: true }, [FIELDS.clientId]: { public: true }, [FIELDS.settingsUrl]: { public: true }, [FIELDS.installations]: { public: true }, [FIELDS.privateKey]: { format: "pem" }, [FIELDS.webhookSecret]: {} } },
  describe: '{kind: "github", accept: [{event, actions?, where?}]}',
  fires: "a GitHub event the server's GitHub App delivers to /hooks/github that its `accept` takes (`github`)",
  firedBy: "`github`: an event the server's GitHub App delivered that the trigger's accept took, its key from the trigger and the SHA-256 of the signed body.",
  schemas: [closedSchema({ kind: { const: "github" }, accept: { ...ACCEPT_SCHEMA, description: "The GitHub events this trigger takes, from the server's one GitHub App (Connect GitHub): a rule's `event` is X-GitHub-Event, `actions` the body's `action`, `where` conditions on the body. Every github trigger whose accept takes an event fires, each its own run. Required." } })],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "accept"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}) !== undefined,
  // Each event it takes is its own work (a review per pull request); max_active_runs bounds it.
  concurrent: () => true,
  takes: (source, event) => acceptRefusal(source.accept as Rule[], event.event, event.body),
  push: {
    maxBodyBytes: 256 << 10,
    key: FIELDS.webhookSecret,
    headers: (headers, nowMs) => scheme.precheck(headers, nowMs),
    verify: (key, headers, body, nowMs) => scheme.verify(key, headers, body, nowMs),
    // The App's ping (made, or its hook edited) is answered; its installation events are its own, kept and answered.
    async handshake(headers, body, ctx) {
      const event = scheme.eventOf(headers, undefined);
      if (event === "ping") return { status: 200, body: { ok: "pong" } };
      // The App's own installations: the connection's to check with GitHub and keep (github-connection.ts).
      if (event === "installation") return (await ctx.notice("installation", jsonOf(body.toString("utf8")))) ?? { status: 200, body: { ok: "noted" } };
      return undefined;
    },
    parse(headers, body) {
      const text = body.toString("utf8");
      const doc = jsonOf(text);
      const event = scheme.eventOf(headers, doc);
      const action = isObject(doc) && typeof doc.action === "string" ? doc.action : undefined;
      const installation = isObject(doc) && isObject(doc.installation) && Number.isSafeInteger(doc.installation.id) ? String(doc.installation.id) : undefined;
      const repo = isObject(doc) && isObject(doc.repository) && typeof doc.repository.full_name === "string" ? doc.repository.full_name : undefined;
      const delivery = scheme.deliveryIdOf?.(headers);
      const attrs = {
        scheme: "github",
        ...(event !== undefined ? { event: cut(event) } : {}),
        ...(action !== undefined ? { action: cut(action) } : {}),
        ...(delivery !== undefined ? { delivery: cut(delivery) } : {}),
        ...(installation !== undefined ? { installation } : {}),
        ...(repo !== undefined ? { repo: cut(repo) } : {}),
        ...scheme.attrsOf?.(doc),
      };
      return [{ key: scheme.firingKeyOf(headers, body), text, attrs, ...(event !== undefined ? { event } : {}), body: doc }];
    },
  },
};
