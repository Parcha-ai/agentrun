// The store's one sealing rule: every sealed column is today's AES-256-GCM seal (pi-durable-agent's seal/unseal, the one
// the tool keys use) under the server's seal key, bound to where it lives by its AAD, "<table>|<row key>|<column>". A value
// copied to another row, column or table does not open. The store holds only the sealed bytes; the key stays in the
// server's (and a runner's) environment, and the server's writer and the runner's unseal both seal and open through here.
//
// An MCP server's credential is the one sealed column of its row, AAD mcp_servers|<name>|sealed, whose plaintext is the
// credential as JSON with the server's origin inside it. Opened for a row whose url has another origin (an edit of the url
// column by someone who can write the store but has no key), it is refused as damaged, so a credential is never sent to a
// host it was not saved for.
import { seal, unseal } from "@parcha/pi-durable-agent";

/** Where a sealed value lives: its table, its row's key and its column. */
export interface SealedAt {
  readonly table: string;
  readonly row: string;
  readonly column: string;
}

/** The sealed columns the store has. */
export const sealedAt = {
  mcpServer: (name: string): SealedAt => ({ table: "mcp_servers", row: name, column: "sealed" }),
  oauthVerifier: (state: string): SealedAt => ({ table: "mcp_oauth_pending", row: state, column: "verifier" }),
  sealedKey: (name: string): SealedAt => ({ table: "sealed_keys", row: name, column: "sealed" }),
  /** A run's browser session's live viewer token (browser-live.ts): one row per run and session tag. */
  liveViewer: (runId: string, tag: string): SealedAt => ({ table: "browser_viewers", row: `${runId}/${tag}`, column: "sealed" }),
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

/** Seals `credential` for server `name`, with the origin of `url` inside it. */
export function sealMcpCredential(key: Buffer, name: string, credential: McpCredential, url: string): Uint8Array {
  return sealColumn(key, sealedAt.mcpServer(name), JSON.stringify({ ...credential, origin: new URL(url).origin }));
}

/** An MCP credential opened, or why it is not usable: none saved; unopened (sealed for another row, or under another
 *  key, or not the store's format); damaged (sealed for another origin than its row's url). Never the credential then. */
export type OpenedMcpCredential = { readonly credential: McpCredential & { readonly origin: string } } | { readonly unusable: "none" | "unopened" | "damaged"; readonly why: string };

export function openMcpCredential(key: Buffer, row: { readonly name: string; readonly url: string; readonly sealed: Uint8Array | null }): OpenedMcpCredential {
  if (row.sealed === null) return { unusable: "none", why: `the MCP server ${row.name} has no credential saved` };
  let credential: McpCredential & { origin?: unknown };
  try {
    credential = JSON.parse(unsealColumn(key, sealedAt.mcpServer(row.name), row.sealed).toString("utf8"));
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
