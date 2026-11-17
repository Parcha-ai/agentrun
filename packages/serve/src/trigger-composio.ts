// Composio: a trigger source set up from here (composio-triggers.ts). A trigger names a saved Composio server, one of its
// toolkit's events (Composio's trigger slug) and that event's config; making it makes the trigger instance on Composio
// for the account the server is connected as, and the project's one webhook subscription at this server's address when
// there is none yet. The server fills in what it made: `instance_id`, Composio's id for the instance, and `hook`, the id
// of the project's route, /v2/hooks/composio/{hook}, whose secret (the subscription's, Composio's own) is sealed under
// that scope. Every event of the project comes to that one route, checked once with the secret (trigger-signatures.ts's
// composio scheme); each trigger whose instance is the delivery's metadata.trigger_id and whose `accept` takes it fires,
// each its own run. This is the one way Composio's events start runs: a webhook trigger takes no composio signature.
// A config can hold a credential (HubSpot's deal-stage event takes {app_id, developer_api_key}). Composio's trigger
// schemas mark no field secret (their `config` is a plain JSON schema: type, title, description, required), so a field is
// sealed by its name (sealedConfigFields), or as an address carrying a credential (credentialUrl): kept in this source's sealed settings, the trigger keeping SEALED_MASK in its
// place and the field named in `sealed_config`, so no answer, row or log holds it (composio-triggers.ts).
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { type Scheme, SIGNATURE_SCHEMES } from "./trigger-signatures.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject, type Json } from "./validate.js";

/** The longest of a sender's words a payload's attrs keep. */
const ATTR_CHARS = 200;
const scheme: Scheme = SIGNATURE_SCHEMES.composio;
/** A Composio trigger slug: upper case, digits and `_` (GITHUB_ISSUE_ADDED_EVENT). */
export const COMPOSIO_EVENT = /^[A-Z0-9][A-Z0-9_]{0,127}$/;
/** The id of a project's route here, made once when its subscription is made or moved here. */
export const COMPOSIO_HOOK = /^cph_[0-9a-f]{24}$/;
/** An id Composio gives a trigger instance (ti_...). */
const INSTANCE = /^[A-Za-z0-9_-]{1,100}$/;
/** The most bytes an event's config holds, as JSON. */
const CONFIG_BYTES = 8 * 1024;
/** The source's field the move of a subscription is asked with: at a create alone, never kept. */
export const MOVE_FIELD = "move_subscription";
/** The settings field the project's subscription secret is sealed under, one scope per hook. */
export const COMPOSIO_SECRET = "secret";
/** The settings fields a trigger's sealed config value is kept under, one scope per trigger and field (configScope):
 *  CONFIG_SECRET for a value the server's list of its secrets can hold (8 bytes or more, no whitespace), so a run that
 *  echoes it is cut; CONFIG_UNLISTED, sealed and masked all the same, for one too short or spaced for that list. */
export const CONFIG_SECRET = "config";
export const CONFIG_UNLISTED = "config_unlisted";
/** What a trigger keeps, and answers, in place of a sealed config value. */
export const SEALED_MASK = "[sealed]";
/** The source's field that names its sealed config fields, set by this server. */
export const SEALED_FIELD = "sealed_config";
/** The settings scope of trigger `id`'s sealed config field `field`. */
export const configScope = (id: string, field: string) => `config:${id}:${encodeURIComponent(field)}`;

/** The words of a config field's name, lower case: snake, kebab, dotted and camel case split (developerApiKey and
 *  developer_api_key both read developer, api, key). */
const wordsOf = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A word of a name read as its singular: a trailing s dropped (tokens, secrets, keys), from a word of two letters or more. */
const singular = (word: string): string => (word.length > 1 && word.endsWith("s") ? word.slice(0, -1) : word);
/** A word that names a credential wherever it stands in a name, read as its singular (credentials, tokens). */
const SECRET_WORDS = new Set(["secret", "password", "passwd", "passphrase", "passcode", "pwd", "pat", "token", "credential", "apikey", "hapikey", "jwt", "dsn", "sig", "authorization", "bearer", "cookie"]);
/** A word that, beside a credential's word, makes the name a count or size of it (max_tokens, token_count, tokens_used,
 *  tokens_per_minute, password_min_length): no credential. */
const COUNT_WORDS = new Set(["max", "min", "num", "number", "count", "limit", "total", "used", "usage", "budget", "remaining", "per", "length", "size", "quota"]);
/** Two words that name a credential together, the one after the other (connection_string); neither does alone. */
const SECRET_PAIRS: readonly (readonly [string, string])[] = [["connection", "string"]];

/** Whether config field `name` is named like a credential. Each word is read as its singular (a trailing s dropped), and
 *  the name is a credential's when a word is secret, password, passwd, passphrase, passcode, pwd, pat, token, credential,
 *  apikey, hapikey, jwt, dsn, sig, authorization, bearer or cookie; when it has connection then string; or when its last
 *  word is key (api_key, api_keys, developer_api_key, private_key; key_id and keyword are not). A credential's word with a
 *  count's word (COUNT_WORDS) just before or after it names a count, not a credential (max_tokens, token_count; a
 *  budget_api_key is still a key). Conservative otherwise: a field so named that holds no secret is sealed all the same. */
export const secretConfigName = (name: string): boolean => {
  const words = wordsOf(name).map(singular);
  const counted = (i: number) => COUNT_WORDS.has(words[i - 1] ?? "") || COUNT_WORDS.has(words[i + 1] ?? "");
  return words.some((word, i) => SECRET_WORDS.has(word) && !counted(i)) || (words.at(-1) === "key" && !counted(words.length - 1)) || SECRET_PAIRS.some(([first, then]) => words.some((word, i) => word === first && words[i + 1] === then));
};

/** An address in any scheme with an authority (scheme://...): its authority, path, query and fragment, split by hand so a
 *  form a URL parser refuses (mongodb://h1:1,h2:2/db) is read too. */
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)[^?#]*(\?[^#]*)?(#.*)?$/is;
/** Whether query or fragment `part` (with its leading ? or #) has a parameter with a value named like a credential. */
const credentialParam = (part: string | undefined): boolean => part !== undefined && [...new URLSearchParams(part.slice(1))].some(([name, given]) => given !== "" && secretConfigName(name));

/** Whether `value` is an address, in any scheme (https, postgres, redis, amqp, mongodb+srv...), that carries a
 *  credential: a user part (user:pass@, :pass@, or a token alone as in https://TOKEN@host: any userinfo), or a query or
 *  fragment parameter with a value whose name is a credential's (secretConfigName: ?token=, ?api_key=, #access_token=).
 *  Such a value is sealed whole, whatever its field's name. Conservative: a user name with no secret (ssh://git@host)
 *  is sealed too. */
export const credentialUrl = (value: string): boolean => {
  const parts = ADDRESS.exec(value);
  if (!parts) return false;
  return parts[1]!.includes("@") || credentialParam(parts[2]) || credentialParam(parts[3]);
};

/** Whether `value` is one a credential's field seals: a string, not empty, or a number (its decimal text is what is
 *  sealed; the config keeps its type wherever the value goes). A switch, null, an object or an array is not. */
export const sealableValue = (value: unknown): value is string | number => (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value));

/** The fields of `config` sealed at a save without its schema: each named like a credential (secretConfigName) whose value
 *  is sealable (sealableValue), and each whose value is an address carrying a credential (credentialUrl). A create adds
 *  those its event's schema marks (sealedSchemaFields). */
export const sealedConfigFields = (config: unknown): string[] =>
  isObject(config) ? Object.entries(config).filter(([name, value]) => (sealableValue(value) && secretConfigName(name)) || (typeof value === "string" && credentialUrl(value))).map(([name]) => name) : [];

/** The JSON Schema types a credential's value may have. */
const SEALABLE_TYPES = ["string", "number", "integer"];

/** The fields of an event's config schema a save seals: each property the schema marks as a credential (format: password,
 *  or writeOnly), whatever its name; and each named like a credential that may hold a string or a number (its type is one
 *  of those, or says none). What the console's form takes as a password. */
export const sealedSchemaFields = (schema: unknown): string[] => {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties).filter(([name, property]) => {
    if (isObject(property) && (property.format === "password" || property.writeOnly === true)) return true;
    const type = isObject(property) ? property.type : undefined;
    return secretConfigName(name) && (type === undefined || SEALABLE_TYPES.includes(String(type)) || (Array.isArray(type) && type.some((one) => SEALABLE_TYPES.includes(String(one)))));
  }).map(([name]) => name);
};

/** A credential in a config, where it is: `name`, its top-level field's name or, below the top level, its JSON Pointer
 *  (/auth/api_key), as sealed_config names it and its sealed scope is keyed (configScope); `path`, its keys from the
 *  config down; `value`. */
export type ConfigSecret = { name: string; path: string[]; value: string | number };
const pointerOf = (path: readonly string[]) => `/${path.map((key) => key.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;

/** Every credential `config` holds in the clear, at any depth: a sealable value (sealableValue: a string, not empty, or a
 *  number), not SEALED_MASK, whose field is named like a credential (secretConfigName), or that is anywhere inside an
 *  object or array so named; and every string that is an address carrying a credential (credentialUrl), wherever it is. A create takes one
 *  at the top level alone (composio-triggers.ts make); a trigger an earlier server kept may hold one deeper. */
export const configSecrets = (config: unknown): ConfigSecret[] => {
  const found: ConfigSecret[] = [];
  const walk = (node: unknown, path: string[], named: boolean): void => {
    if (typeof node === "string" || typeof node === "number") {
      if ((named || (typeof node === "string" && credentialUrl(node))) && sealableValue(node) && node !== SEALED_MASK) found.push({ name: path.length === 1 ? path[0]! : pointerOf(path), path, value: node });
    } else if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...path, String(i)], named));
    else if (isObject(node)) for (const [key, item] of Object.entries(node)) walk(item, [...path, key], named || secretConfigName(key));
  };
  if (isObject(config)) for (const [key, item] of Object.entries(config)) walk(item, [key], secretConfigName(key));
  return found;
};

/** `config` with each of `secrets` as SEALED_MASK, at its place. */
const maskedConfig = (config: Json, secrets: readonly ConfigSecret[]): Json => {
  const copy = structuredClone(config);
  for (const { path } of secrets) {
    let node = copy as Record<string, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    node[path.at(-1)!] = SEALED_MASK;
  }
  return copy;
};

/** `sent`, a PATCH's config, with SEALED_MASK put back at each place `shown` (the config as answered) holds a field named
 *  in `sealed` (sealed_config: a top-level name, or a JSON Pointer read as configSecrets writes it, pointerOf) and `sent`
 *  leaves it out under an object it sends: a sealed value left out is kept. A copy: `sent` is not changed. */
export const sealedKept = (sent: Json, shown: unknown, sealed: readonly string[]): Json => {
  const names = new Set(sealed);
  const places: string[][] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (path.length && names.has(path.length === 1 ? path[0]! : pointerOf(path))) places.push(path);
    else if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...path, String(i)]));
    else if (isObject(node)) for (const [key, item] of Object.entries(node)) walk(item, [...path, key]);
  };
  walk(shown, []);
  const copy = structuredClone(sent);
  for (const path of places) {
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) node = isObject(node) ? node[key] : undefined;
    if (isObject(node) && node[path.at(-1)!] === undefined) node[path.at(-1)!] = SEALED_MASK;
  }
  return copy;
};

/** `source` as every answer sends it: each credential in its config (configSecrets, at any depth) as SEALED_MASK, and
 *  named in sealed_config, whether it is sealed yet or still kept in the clear (a trigger saved before this rule, until
 *  the next start seals it: composio-triggers.ts sealKept). */
export const shownSource = (source: Source): Source => {
  const config = source.config;
  const clear = configSecrets(config);
  if (!clear.length || !isObject(config)) return source;
  const sealed = Array.isArray(source[SEALED_FIELD]) ? (source[SEALED_FIELD] as string[]) : [];
  return { ...source, config: maskedConfig(config, clear), [SEALED_FIELD]: [...new Set([...sealed, ...clear.map((secret) => secret.name)])] };
};

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

type Bad = (field: string, reason: string, message: string) => void;

/** The source's fields, checked: each issue through `bad`. A rule of `accept` names the trigger's own event: it reads one
 *  event alone. */
function fieldsOf(value: Record<string, unknown>, bad: Bad): Source | undefined {
  let failed = false;
  const fail: Bad = (...args) => ((failed = true), bad(...args));
  const { server, event, config, instance_id: instance, hook, [SEALED_FIELD]: sealed } = value;
  if (typeof server !== "string" || !MCP_SERVER_NAME.test(server)) fail("server", server === undefined ? "missing" : "invalid", "server is the name of a saved Composio MCP server (Settings → MCP servers), whose key and account the trigger uses");
  if (typeof event !== "string" || !COMPOSIO_EVENT.test(event)) fail("event", event === undefined ? "missing" : "invalid", "event is one of the server's toolkit's events, as Composio slugs it (GITHUB_ISSUE_ADDED_EVENT): GET /v2/settings/mcp-servers/{name}/composio/events lists them");
  if (!isObject(config) || Buffer.byteLength(JSON.stringify(config), "utf8") > CONFIG_BYTES) fail("config", config === undefined ? "missing" : "invalid", `config is the event's config, an object as its schema says (GitHub's {owner, repo}), at most ${CONFIG_BYTES} bytes as JSON`);
  if (instance !== undefined && !(typeof instance === "string" && INSTANCE.test(instance))) fail("instance_id", "invalid", "instance_id is Composio's id for the trigger's instance, set by this server");
  if (hook !== undefined && !(typeof hook === "string" && COMPOSIO_HOOK.test(hook))) fail("hook", "invalid", "hook is the id of the project's route here, set by this server");
  if (sealed !== undefined && !(Array.isArray(sealed) && sealed.length <= 100 && sealed.every((name) => typeof name === "string" && name.length <= 200))) fail(SEALED_FIELD, "invalid", `${SEALED_FIELD} names the config's sealed fields, set by this server`);
  if (value[MOVE_FIELD] !== undefined && value[MOVE_FIELD] !== true) fail(MOVE_FIELD, "invalid", `${MOVE_FIELD} is true, or left out`);
  const accept = value.accept === undefined ? undefined : acceptOf(value.accept, fail);
  if (accept && typeof event === "string") (accept as Rule[]).forEach((rule, i) => rule.event !== event && fail(`accept[${i}].event`, "invalid", `A composio trigger takes its one event: a rule's event is ${event}.`));
  if (failed) return undefined;
  return {
    kind: "composio", server: server as string, event: event as string, config: config as Json,
    ...(accept ? { accept } : {}), ...(typeof instance === "string" ? { instance_id: instance } : {}), ...(typeof hook === "string" ? { hook } : {}), ...(Array.isArray(sealed) ? { [SEALED_FIELD]: sealed as string[] } : {}), ...(value[MOVE_FIELD] === true ? { [MOVE_FIELD]: true } : {}),
  };
}

export const composio: TriggerAdapter = {
  id: "composio",
  label: "Composio trigger",
  delivery: "push",
  owner: false,
  // Each project's subscription secret, Composio's own, sealed under its hook's scope, and each trigger's sealed config
  // value under its own (configScope): composio-triggers.ts keeps them.
  settings: { scope: "server", fields: { [COMPOSIO_SECRET]: {}, [CONFIG_SECRET]: {}, [CONFIG_UNLISTED]: { public: true } } },
  describe: '{kind: "composio", server, event, config, accept?: [{event, where?}], move_subscription?: true}',
  fires: "an event of a saved Composio server's toolkit that Composio delivers to /hooks/composio/{hook} for the trigger's instance, that its `accept` takes (`composio`)",
  firedBy: "`composio`: an event Composio delivered for the trigger's instance (the delivery's metadata.trigger_id) that its accept took, its key from the trigger and the delivery's `webhook-id`.",
  schemas: [
    closedSchema(
      {
        kind: { const: "composio" },
        server: { type: "string", pattern: MCP_SERVER_NAME.source, description: "A saved Composio MCP server (Settings → MCP servers): its key makes the instance, for the account it is connected as." },
        event: { type: "string", pattern: COMPOSIO_EVENT.source, description: "One of the server's toolkit's events, Composio's trigger slug (GET /settings/mcp-servers/{name}/composio/events)." },
        config: { type: "object", description: `The event's config, as its schema in the events list says (GitHub's new-issue event: {owner, repo}). A field named like a credential (a word of its name, read as its singular, is secret, password, passwd, passphrase, passcode, pwd, pat, token, credential, apikey, hapikey, jwt, dsn, sig, authorization, bearer or cookie, unless a count word (max, min, num, number, count, limit, total, used, usage, budget, remaining, per, length, size, quota) is right beside it: max_tokens and token_count are counts; it has connection then string; or its last word is key: developer_api_key, api_keys), or one the event's schema marks with format: password or writeOnly, holding a string or a number, is sealed at the save, as is any http(s) address with a password in its user part or a query parameter so named with a value: Composio gets it, and every answer has "${SEALED_MASK}" in its place, the field named in ${SEALED_FIELD}. One below the config's top level is refused 422. A PATCH that leaves it out or sends "${SEALED_MASK}" keeps it; another value is a change to the config, refused as any is.` },
      },
      {
        accept: { ...ACCEPT_SCHEMA, description: "Optional: which of the event's deliveries fire it. A rule's `event` is the trigger's own, `where` pointers read the delivery, its event's data under `/data` (`/data/title`). None: every delivery for its instance fires." },
        instance_id: { type: "string", readOnly: true, description: "Composio's id for the trigger's instance, set by this server when it makes it: the delivery's metadata.trigger_id. Triggers with the same server, event and config share one." },
        [SEALED_FIELD]: { type: "array", items: { type: "string" }, readOnly: true, description: `The config's sealed fields, set by this server at the save: each answered as "${SEALED_MASK}", its value kept sealed here. Each is a top-level field's name, or, for one an earlier server kept below the top level, its JSON Pointer (/auth/api_key).` },
        hook: { type: "string", pattern: COMPOSIO_HOOK.source, readOnly: true, description: "The id of the project's route here, /hooks/composio/{hook}, set by this server: the address of the project's webhook subscription on Composio." },
        [MOVE_FIELD]: { type: "boolean", enum: [true], writeOnly: true, description: "At a create alone, never kept: the project's webhook subscription is at another address, and the owner moves it here. Without it, such a create is refused 409 composio_subscription_elsewhere, naming the address." },
      },
    ),
  ],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "server", "event", "config", "accept", "instance_id", "hook", SEALED_FIELD, MOVE_FIELD]));
    return fieldsOf(value, bad);
  },
  shown: shownSource,
  wellFormed: (source) => {
    const read = fieldsOf(source, () => {});
    return read !== undefined && typeof read.instance_id === "string" && typeof read.hook === "string";
  },
  // Each delivery is its own work (an issue each); max_active_runs bounds it.
  concurrent: () => true,
  hookOf: (source) => `composio/${String(source.hook)}`,
  // A delivery fires the triggers of its project's route (`scope`, the hook it came to) whose instance it names, and whose
  // filter takes it.
  takes(source, event) {
    if (event.scope === undefined || source.hook !== event.scope) return "other_project";
    if (!event.attrs?.trigger_id || source.instance_id !== event.attrs.trigger_id) return "other_instance";
    return source.accept ? acceptRefusal(source.accept as Rule[], event.event, event.body) : undefined;
  },
  push: {
    maxBodyBytes: 256 << 10,
    key: COMPOSIO_SECRET,
    scoped: true,
    headers: (headers, nowMs) => scheme.precheck(headers, nowMs),
    verify: (key, headers, body, nowMs) => scheme.verify(key, headers, body, nowMs),
    parse(headers, body) {
      const text = body.toString("utf8");
      const doc = jsonOf(text);
      const event = scheme.eventOf(headers, doc);
      const attrs = { scheme: "composio", ...(event !== undefined ? { event: event.slice(0, ATTR_CHARS) } : {}), ...scheme.attrsOf?.(doc) };
      return [{ key: scheme.firingKeyOf(headers, body), text, attrs, ...(event !== undefined ? { event } : {}), body: doc }];
    },
  },
};
