// The store's one sealing rule: every sealed column is today's AES-256-GCM seal (sealing.ts seal/unseal, the one
// the tool keys use) under the server's seal key, bound to where it lives by its AAD, "<table>|<row key>|<column>". A value
// copied to another row, column or table does not open. The store holds only the sealed bytes; the key stays in the
// server's (and a runner's) environment, and the server's writer and the runner's unseal both seal and open through here.
//
// An MCP server's credential is the one sealed column of its row, AAD mcp_servers|<row key>|sealed (its name, or a
// workspace's "<workspace>/<name>", mcp-workspace.ts), whose plaintext is the
// credential as JSON with the server's origin inside it. Opened for a row whose url has another origin (an edit of the url
// column by someone who can write the store but has no key), it is refused as damaged, so a credential is never sent to a
// host it was not saved for.
import { seal, unseal } from "../sealing.js";

/** Where a sealed value lives: its table, its row's key and its column. */
export interface SealedAt {
  readonly table: string;
  readonly row: string;
  readonly column: string;
}

/** The sealed columns the store has. */
export const sealedAt = {
  mcpServer: (name: string): SealedAt => ({ table: "mcp_servers", row: name, column: "sealed" }),
  /** A pending sign-in's sealed column: its PKCE verifier and the OAuth client (with its secret) as one sealed JSON blob. */
  oauthPending: (state: string): SealedAt => ({ table: "mcp_oauth_pending", row: state, column: "sealed" }),
  sealedKey: (name: string): SealedAt => ({ table: "sealed_keys", row: name, column: "sealed" }),
  // A saved browser sign-in's pointer: the one sealed column of the agent-and-provider row, bound to both by a composite
  // row key. A ":" in either part is refused, so agent:provider names one pair only. A tombstone keeps the same sealed
  // bytes under this same binding, so a forgotten pointer still opens.
  signIn: (agentId: string, provider: string): SealedAt => {
    for (const part of [agentId, provider]) if (part.includes(":")) throw new Error(`a sign-in's agent and provider never hold ":": ${JSON.stringify(part)}`);
    return { table: "sign_ins", row: `${agentId}:${provider}`, column: "pointer" };
  },
  /** A run's computer session's live viewer token (browser-live.ts): one row per run, computer kind and session tag. */
  liveViewer: (runId: string, kind: string, tag: string): SealedAt => ({ table: "computer_viewers", row: `${runId}/${kind}:${tag}`, column: "sealed" }),
  /** A run's launch secrets: the MCP credentials its caller handed it for its `per_run` servers (mcp_auth), and its own
   *  model key (model_key), with the gateway's origin it was handed for. */
  runLaunch: (runId: string): SealedAt => ({ table: "run_launch", row: runId, column: "sealed" }),
};

/** The AAD a value at `at` is sealed under. A part with the separator in it is refused: no two places share an AAD. */
export function aadOf(at: SealedAt): string {
  for (const part of [at.table, at.row, at.column]) {
    if (part.includes("|")) throw new Error(`a sealed column's table, row key and column never hold "|": ${JSON.stringify(part)}`);
  }
  return `${at.table}|${at.row}|${at.column}`;
}

export function sealColumn(key: Buffer, at: SealedAt, plain: string | Uint8Array): Uint8Array {
  return Uint8Array.from(seal(key, Buffer.from(plain), aadOf(at)));
}

/** The plain bytes of a value sealed at `at`; throws when it was sealed elsewhere or under another key. */
export function unsealColumn(key: Buffer, at: SealedAt, sealed: Uint8Array): Buffer {
  return unseal(key, Buffer.from(sealed), aadOf(at));
}

/** An MCP server's credential: headers to send, or an OAuth token set (and its client), opaque here. */
export type McpCredential = ({ readonly type: "headers"; readonly headers: Readonly<Record<string, string>> } | { readonly type: "oauth"; readonly set: unknown }) & { readonly [key: string]: unknown };

/** Seals `credential` for the server whose row key is `name` (a workspace's server's is "<workspace>/<name>",
 *  mcp-workspace.ts), with the origin of `url` inside it. */
export function sealMcpCredential(key: Buffer, name: string, credential: McpCredential, url: string): Uint8Array {
  return sealColumn(key, sealedAt.mcpServer(name), JSON.stringify({ ...credential, origin: new URL(url).origin }));
}

/** An MCP credential opened, or why it is not usable: none saved; unopened (sealed for another row, or under another
 *  key, or not the store's format); damaged (sealed for another origin than its row's url). Never the credential then. */
export type OpenedMcpCredential = { readonly credential: McpCredential & { readonly origin: string } } | { readonly unusable: "none" | "unopened" | "damaged"; readonly why: string };

/** `row`'s credential opened at its row key (`sealedAs`, else its name), its words naming it by `name`. */
export function openMcpCredential(key: Buffer, row: { readonly name: string; readonly sealedAs?: string; readonly url: string; readonly sealed: Uint8Array | null }): OpenedMcpCredential {
  if (row.sealed === null) return { unusable: "none", why: `the MCP server ${row.name} has no credential saved` };
  let credential: McpCredential & { origin?: unknown };
  try {
    credential = JSON.parse(unsealColumn(key, sealedAt.mcpServer(row.sealedAs ?? row.name), row.sealed).toString("utf8"));
  } catch {
    return { unusable: "unopened", why: `the MCP server ${row.name}'s credential does not open with this server's key` };
  }
  let origin: string;
  try {
    origin = new URL(row.url).origin;
  } catch {
    return { unusable: "damaged", why: `the MCP server ${row.name}'s address is not a URL` };
  }
  if (typeof credential?.origin !== "string" || credential.origin !== origin) {
    return { unusable: "damaged", why: `the MCP server ${row.name}'s credential was saved for another address than the one it has now` };
  }
  return { credential: credential as McpCredential & { origin: string } };
}

/** A run's binding of a per-run Composio server: the Composio user its calls run as, and the connected account when the
 *  caller names one. Never kept on the server's row: sealed in the run's launch alone. `by`: who handed it, the API token
 *  or the owner's session, sealed with it so the run can't change it; each claim reads it against the owner's Composio
 *  users (composio-owners.ts). A binding sealed before the mark has none. */
export type ComposioBinding = { readonly user_id: string; readonly connected_account_id?: string; readonly by?: "token" | "owner" };

/** What a run's caller handed one MCP server (`mcp_auth.<server>`): a per_run server's headers, or a per-run Composio
 *  server's binding (its key stays the server's own); each with the origin of the server's url when it was handed, so a
 *  server moved since never receives them. */
export type RunMcpEntry = ({ readonly headers: Readonly<Record<string, string>> } | { readonly composio: ComposioBinding }) & { readonly origin: string };

/** The MCP credentials a run's caller handed it (`mcp_auth` at its start or with a message), by server name. */
export type RunMcpAuth = Readonly<Record<string, RunMcpEntry>>;

/** A run's own model key (`model_key` at its start or with a message): the key its model requests carry, and the origin
 *  of the gateway it was handed for (AGENT_MODEL_BASE_URL's then), so a gateway moved since never receives it. */
export type RunModelKey = { readonly key: string; readonly origin: string };

/** A run's own tool keys (`keys` at its start or with a message, run-keys.ts), by name. */
export type RunToolKeys = Readonly<Record<string, string>>;

/** What a run's launch holds sealed: its handed MCP credentials, its own model key and its own tool keys, each when it
 *  has one. `retired`: each value an earlier seal of the launch held that a message replaced since its turn began (a
 *  host that hands a fresh key with each message), kept only to be cut (the runner's cut, a served read's, its end's
 *  census) and never used, erased with the rest at the run's end. `lost`: a message sealed over bytes that did not open
 *  here, so what they held is not known: every cut of the run is unreadable until its end, which writes no census. */
export type RunLaunchSecrets = { readonly mcp?: RunMcpAuth; readonly model?: RunModelKey; readonly keys?: RunToolKeys; readonly retired?: readonly string[]; readonly lost?: true };

/** Seals a run's launch secrets as its launch's sealed column (AAD run_launch|<run_id>|sealed); null when it holds none. */
export function sealRunLaunch(key: Buffer, runId: string, secrets: RunLaunchSecrets): Uint8Array | null {
  const mcp = secrets.mcp && Object.keys(secrets.mcp).length ? secrets.mcp : undefined;
  const keys = secrets.keys && Object.keys(secrets.keys).length ? secrets.keys : undefined;
  const retired = secrets.retired?.length ? secrets.retired : undefined;
  if (!mcp && !secrets.model && !keys && !retired && !secrets.lost) return null;
  return sealColumn(key, sealedAt.runLaunch(runId), JSON.stringify({ ...(mcp ? { mcp } : {}), ...(secrets.model ? { model: secrets.model } : {}), ...(keys ? { keys } : {}), ...(retired ? { retired } : {}), ...(secrets.lost ? { lost: true } : {}) }));
}

/** The tool keys of an opened launch: each name with text for its value, none else. */
const toolKeysOf = (keys: unknown): RunToolKeys | undefined => {
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return undefined;
  const out = Object.fromEntries(Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.keys(out).length ? out : undefined;
};

/** A run's launch secrets, opened: none when its launch holds none; undefined when the bytes do not open under `key` for
 *  this run (sealed for another run, or under another key). */
export function openRunLaunch(key: Buffer, runId: string, sealed: Uint8Array | null): RunLaunchSecrets | undefined {
  if (sealed === null) return {};
  try {
    const opened = JSON.parse(unsealColumn(key, sealedAt.runLaunch(runId), sealed).toString("utf8")) as { mcp?: RunMcpAuth; model?: { key?: unknown; origin?: unknown }; keys?: unknown; retired?: unknown; lost?: unknown };
    const model = typeof opened.model?.key === "string" && typeof opened.model.origin === "string" ? { key: opened.model.key, origin: opened.model.origin } : undefined;
    const keys = toolKeysOf(opened.keys);
    const retired = Array.isArray(opened.retired) ? opened.retired.filter((value): value is string => typeof value === "string") : [];
    return { ...(opened.mcp ? { mcp: opened.mcp } : {}), ...(model ? { model } : {}), ...(keys ? { keys } : {}), ...(retired.length ? { retired } : {}), ...(opened.lost === true ? { lost: true as const } : {}) };
  } catch {
    return undefined;
  }
}

/** What a run the runner starts from run `from` (a check's replay, an audit's shadow) takes of `from`'s launch secrets
 *  (`sealed`, its launch's sealed column), sealed for run `id` alone (AAD run_launch|<id>|sealed): its handed MCP
 *  credentials, and, when `keyed` (the claim of `from` holds its own model key now), that model key with the origin it was
 *  handed for, so the child spends on the key its run brought and never on the server's. Never its tool keys, nor a value
 *  a message retired. The child's copy is erased at the child's own end, as any run's launch secrets are. Undefined when
 *  it takes nothing, or the bytes do not open for `from`. */
export function sealHandedLaunch(key: Buffer, from: string, sealed: Uint8Array | null, id: string, keyed: boolean): Uint8Array | undefined {
  const opened = openRunLaunch(key, from, sealed);
  if (!opened) return undefined;
  return sealRunLaunch(key, id, { ...(opened.mcp ? { mcp: opened.mcp } : {}), ...(keyed && opened.model ? { model: opened.model } : {}) }) ?? undefined;
}

/** Seals a run's handed MCP credentials alone as its launch's sealed column (AAD run_launch|<run_id>|sealed). */
export function sealRunMcpAuth(key: Buffer, runId: string, auth: RunMcpAuth): Uint8Array {
  return sealColumn(key, sealedAt.runLaunch(runId), JSON.stringify({ mcp: auth }));
}

/** A run's handed MCP credentials, opened: none when its launch holds none; undefined when the bytes do not open under
 *  `key` for this run (sealed for another run, or under another key). */
export function openRunMcpAuth(key: Buffer, runId: string, sealed: Uint8Array | null): RunMcpAuth | undefined {
  const opened = openRunLaunch(key, runId, sealed);
  return opened && (opened.mcp ?? {});
}
