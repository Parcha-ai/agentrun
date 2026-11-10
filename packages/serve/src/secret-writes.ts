// Who may write a secret, and which writes are secret writes: the one place both are decided. A secret (a model key, a
// tool key, an MCP header or token, a computer vendor's key, a trigger source's signing secret...) is written only from
// the owner's signed-in session: never with the server's API token, which a run's process, an agent's MCP client or a
// script may hold. The server's dispatch makes one check (server.ts): an operation that writesSecret() with its body, from
// a caller mayWriteSecrets() does not allow, is 403 in SECRET_WRITE_REFUSAL. Each plane registers which of its
// operations, and which body fields, are secret writes (registerSecretWrite), so a token may still make a plane's
// non-secret edits (an MCP server with no auth, its prices). The API document marks each secret field
// `x-agentrun-secret: true`, and a test fails for a marked operation with no predicate here, so a new route can't skip it.
//
// Every secret's view answers one shape (secretMeta): its name, whether it is set, where it came from, and when it last
// changed. Never a value, a prefix, a length or a hash.
import type { IncomingMessage } from "node:http";
import { byConsoleSession, byOwnerSession } from "./page.js";

/** The one refusal a secret write from anything but the owner's session gets (403 forbidden). */
export const SECRET_WRITE_REFUSAL = "Saving, replacing or removing a secret takes the owner's signed-in session in the console; the API token can't write secrets.";

// ---- who may write a secret ------------------------------------------------------------------------------------------

/**
 * Whether the console a launcher opened on a loopback-bound server with no accounts (no password: the browser that
 * followed the launch link, `/?launch=<code>`, its cookie a session id made at random and kept by the server, never
 * derived from the token, held to this server's own origin and a JSON body as every page write is) counts as the owner
 * for a secret write. The owner's ruling (2026-11-09): yes. The API token never writes a secret, loopback included: it
 * can neither compute a console session nor get one from its own link (page.ts ConsoleSessions); a server bound off loopback needs accounts on to take a
 * secret at all. This one line is the decision; mayWriteSecrets (the dispatch check, and GET /v2/auth/session's
 * secrets_writable) follows it.
 */
export const LOOPBACK_CONSOLE_IS_OWNER = true;

/** What decides it: whether the server has accounts; the request's password session (accounts on), its accounts-off
 *  console session, and whether it came with the API token itself; and whether the SERVER is bound to a loopback address
 *  alone (its listen address, never the request's: a server bound off loopback is reachable from elsewhere, even when this
 *  request came from this machine). */
export type SecretWriterFacts = {
  readonly accounts: boolean;
  readonly passwordSession: boolean;
  readonly consoleSession: boolean;
  readonly token: boolean;
  readonly loopbackBound: boolean;
};

/** Why a caller may not write a secret (GET /v2/auth/session's secrets_reason): token, it is the API token, which never
 *  writes one, on any server; sign_in, it is not the owner's session: accounts on, sign in with the password (or, accounts
 *  off on a loopback-bound server, open the console from the launch link); no_accounts, accounts are off and the server is
 *  reachable off loopback, where no one writes one until accounts are on. */
export type SecretsReason = "token" | "sign_in" | "no_accounts";
export const SECRETS_REASONS: readonly SecretsReason[] = ["token", "sign_in", "no_accounts"];

/** The one decision: whether a caller with these facts may write a secret, and if not, why. The owner's password session
 *  always may; the accounts-off console on a loopback-bound server may where `loopbackConsoleIsOwner`
 *  (LOOPBACK_CONSOLE_IS_OWNER); the API token never may, anywhere. */
export function secretWriteVerdict(facts: SecretWriterFacts, loopbackConsoleIsOwner: boolean = LOOPBACK_CONSOLE_IS_OWNER): { writable: true } | { writable: false; reason: SecretsReason } {
  if (facts.passwordSession) return { writable: true };
  if (!facts.accounts && loopbackConsoleIsOwner && facts.consoleSession && facts.loopbackBound) return { writable: true };
  if (facts.token) return { writable: false, reason: "token" };
  if (!facts.accounts && !facts.loopbackBound) return { writable: false, reason: "no_accounts" };
  return { writable: false, reason: "sign_in" };
}

/** Whether a caller with these facts may write a secret (secretWriteVerdict's answer). */
export const mayWriteSecrets = (facts: SecretWriterFacts, loopbackConsoleIsOwner: boolean = LOOPBACK_CONSOLE_IS_OWNER): boolean => secretWriteVerdict(facts, loopbackConsoleIsOwner).writable;

/** The facts of `req` (page.ts marks its sessions as it answers the request, and stands its cookie in for the token's
 *  header) on a server with `accounts` or not, bound to loopback or not. */
export const secretWriterFacts = (req: IncomingMessage, { accounts, loopbackBound }: { accounts: boolean; loopbackBound: boolean }): SecretWriterFacts => {
  const passwordSession = byOwnerSession(req);
  const consoleSession = byConsoleSession(req);
  return { accounts, passwordSession, consoleSession, token: req.headers.authorization !== undefined && !passwordSession && !consoleSession, loopbackBound };
};

/** Whether `req` may write a secret on this server (secretWriteVerdict over its facts): the one answer the dispatch check
 *  gives. */
export const writesSecretsAllowed = (req: IncomingMessage, server: { accounts: boolean; loopbackBound: boolean }): boolean => mayWriteSecrets(secretWriterFacts(req, server));

/** GET /v2/auth/session's two fields from the verdict: secrets_writable, and secrets_reason only when it is false. */
export function secretsWritableFields(facts: SecretWriterFacts): { secrets_writable: boolean; secrets_reason?: SecretsReason } {
  const verdict = secretWriteVerdict(facts);
  return verdict.writable ? { secrets_writable: true } : { secrets_writable: false, secrets_reason: verdict.reason };
}

// ---- which writes are secret writes ----------------------------------------------------------------------------------

/** Whether an operation's request, with this body (undefined when it has none, as a DELETE), writes a secret. */
export type SecretPredicate = (body: unknown) => boolean;

/** What a request is besides its body, for a predicate that must read what is stored: the route's path parameters (in
 *  the order its pattern names them) and the server's one store. `seen`: what the predicate read to let the request
 *  through, which the dispatch hands its operation, so a write allowed against one stored state is refused when that
 *  state changed before the write lands. */
export type SecretRequest = { readonly params: readonly string[]; readonly store: unknown; seen?: unknown };
/** Whether a request writes a secret by what it would do to what is stored (drop or replace a sealed credential), read
 *  from the store: beside the body's predicate, in the same one check. */
export type StoredSecretPredicate = (body: unknown, request: SecretRequest) => Promise<boolean>;

const registry = new Map<string, SecretPredicate>();
const storedPredicates = new Map<string, StoredSecretPredicate>();
const notSecretWrites = new Map<string, string>();

/** A plane's secret write: operation `operationId` (the API document's), and which bodies of it write a secret; with
 *  `stored`, also which requests of it would drop or replace a secret the store holds. */
export function registerSecretWrite(operationId: string, predicate: SecretPredicate, stored?: StoredSecretPredicate): void {
  registry.set(operationId, predicate);
  if (stored) storedPredicates.set(operationId, stored);
}

/** An operation on a secret's route that writes no secret, said so on purpose, with why: never an oversight, and never
 *  read by the dispatch's check (it stays out of the registry above). */
export function registerNotSecretWrite(operationId: string, reason: string): void {
  notSecretWrites.set(operationId, reason);
}

/** Why `operationId` writes no secret, when a plane said so (registerNotSecretWrite). */
export const notSecretWriteReason = (operationId: string): string | undefined => notSecretWrites.get(operationId);

/** The operations any plane registered. */
export const registeredOperations = (): string[] => [...registry.keys()];

/** Whether `operationId`'s request is decided by what is stored as well as by its body (a stored predicate). */
export const readsStore = (operationId: string): boolean => storedPredicates.has(operationId);

/** Whether `operationId` is a registered secret write at all: only then does the dispatch check read its body. */
export const isSecretWriteOperation = (operationId: string): boolean => registry.has(operationId);

/** Whether this request of `operationId`, with `body`, writes a secret by its body (its plane's predicate). An
 *  unregistered operation writes none. */
export const writesSecret = (operationId: string, body: unknown): boolean => registry.get(operationId)?.(body) === true;

/** Whether this request of `operationId` writes a secret: by its body, or by what it would drop or replace in the store
 *  (its plane's stored predicate). The dispatch's one check asks this. */
export async function writesSecretFor(operationId: string, body: unknown, request: SecretRequest): Promise<boolean> {
  if (writesSecret(operationId, body)) return true;
  const stored = storedPredicates.get(operationId);
  return stored ? (await stored(body, request)) === true : false;
}

// ---- the API document's marks ----------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `schema` (in `doc`, its $refs followed once each) marks any field `x-agentrun-secret: true`. */
function marksSecret(doc: Json, schema: unknown, seen = new Set<unknown>()): boolean {
  if (!isObject(schema) && !Array.isArray(schema)) return false;
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (isObject(schema)) {
    if (schema["x-agentrun-secret"] === true) return true;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
      let target: unknown = doc;
      for (const part of schema.$ref.slice(2).split("/")) target = isObject(target) ? target[part] : undefined;
      if (marksSecret(doc, target, seen)) return true;
    }
  }
  return Object.values(schema).some((value) => marksSecret(doc, value, seen));
}

/** The operations of `doc` that write a secret: their request body marks a field `x-agentrun-secret`, or the operation is
 *  marked whole (a removal, which has no body). The generated CLI leaves every one of them out. */
export function markedOperations(doc: Json): string[] {
  const out: string[] = [];
  for (const item of Object.values((doc.paths ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(item)) {
      if (!isObject(op) || typeof op.operationId !== "string") continue;
      const body = isObject(op.requestBody) ? op.requestBody : undefined;
      if (op["x-agentrun-secret"] === true || (body && marksSecret(doc, body))) out.push(op.operationId);
    }
  }
  return out;
}

/** The marked operations of `doc` no plane registered a predicate for (`registered`): each a route a secret could take
 *  past the dispatch check. Empty is the only passing answer. */
export const unguardedOperations = (doc: Json, registered: readonly string[]): string[] =>
  markedOperations(doc).filter((operationId) => !registered.includes(operationId));

// ---- one metadata shape for every secret's view ----------------------------------------------------------------------
//
// The field and the name (settled 2026-11-09). An object that holds ONE secret carries it as `secret: SecretMeta`; one
// that holds SEVERAL carries `secrets: SecretMeta[]`; no other field name carries a SecretMeta. Its `name` is
// "<plane>:<id>", the plane lowercase and the id as the plane keys it, always built by secretName(plane, ...id):
// "tool:<KEY_NAME>", "model:<KEY_NAME>", "mcp:<server>" (several credentials of one server: "mcp:<server>:<field>"),
// "computer:<provider>:<KEY>", "workspace:archil", "trigger:<id>", "webhook:outbound", "github:app",
// "source:<adapter>:<field>".
//
// Shown once. A value the server mints for a person to copy is shown ONCE, as a field of its own named `<kind>_secret`
// beside `secret: SecretMeta`, and only in the owner session's minting answer (the create, a rotate, the first save):
// so far `signing_secret` alone (a webhook trigger's, POST /triggers and POST /triggers/{id}/secret; the outbound
// webhook's, its first PUT /settings/webhook). A token caller's create answer says `secret_set: true` beside secret.set,
// and no value. MCP mints nothing a person copies: a `client_secret` in any answer is a leak. The planted-secret harness
// (test/fixtures/planted-secrets.mjs) allows a value only in an answer its plant declares as minting (`mints`), to the
// owner's session, and flags it anywhere else: any GET, a token caller's answer, a later answer, the journal, the
// store's rows, the log, an export.

/** Where a secret came from: the environment the server starts with (which always wins, by the same name), pasted in the
 *  console, or obtained by a sign-in (OAuth, Connect); null when it is not set. */
export type SecretSource = "env" | "console" | "sign-in";

/** What a view says of a secret: never its value, a prefix, a length or a hash. `changed_at` is the credential's own
 *  time (when it was pasted, signed in or rotated), not its row's; null when not set or not known. */
export type SecretMeta = { name: string; set: boolean; source: SecretSource | null; changed_at: string | null };

/** A secret's name, "<plane>:<id>": the plane and each part of its id joined with ":" (secretName("computer", provider,
 *  KEY) is "computer:<provider>:<KEY>", secretName("workspace", "archil") "workspace:archil"). */
export function secretName(plane: string, ...id: string[]): string {
  return [plane, ...id].join(":");
}

/** The one shape a secret's view answers. Unset, it has no source and no time. */
export function secretMeta(name: string, { set, source, changedAt }: { set: boolean; source?: SecretSource; changedAt?: string | Date | null }): SecretMeta {
  if (!set) return { name, set: false, source: null, changed_at: null };
  const at = changedAt instanceof Date ? changedAt.toISOString() : (changedAt ?? null);
  return { name, set: true, source: source ?? null, changed_at: at };
}

/** SecretMeta's schema, a component of the API document (`#/components/schemas/SecretMeta`). */
export const SECRET_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "set", "source", "changed_at"],
  description: "What a secret's view says of it: its name, whether it is set, where it came from, and when it last changed. Never a value, a prefix, a length or a hash.",
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]*(:[^:]+)+$", description: "The secret's name, \"<plane>:<id>\": a lowercase plane and the id as the plane keys it, joined with \":\": tool:<KEY_NAME>, model:<KEY_NAME>, mcp:<server> (several of one server: mcp:<server>:<field>), computer:<provider>:<KEY>, workspace:archil, trigger:<id>, webhook:outbound, github:app, source:<adapter>:<field>. An object holding one secret carries it as `secret`, one holding several as `secrets`." },
    set: { type: "boolean", description: "Whether a value is set." },
    source: { enum: ["env", "console", "sign-in", null], description: "Where it came from: env, the environment the server starts with (which always wins, by the same name, and greys the console's field); console, pasted in the console by the owner's session; sign-in, obtained by an OAuth sign-in or Connect. null when not set." },
    changed_at: { type: ["string", "null"], format: "date-time", description: "When the credential itself last changed (pasted, signed in, rotated); null when not set or not known." },
  },
  "x-agentrun-serve": "secrets/1",
} as const;
