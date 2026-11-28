// A workspace's own MCP servers (workspace-scope.ts): an API-only server's backend saves, per tenant, servers that no
// other tenant reads, calls or overwrites, beside the install's shared ones (the operator's, saved unscoped).
//
// A workspace's server is kept in the one registry under its row key, "<workspace>/<name>" (a workspace's name never
// holds "/", nor a server's), so each workspace has its own namespace with no schema change: the primary key keeps
// two workspaces' "github" apart, and everything bound to the row key is bound to the workspace with it: the sealed
// credential's AAD (mcp_servers|<workspace>/<name>|sealed, store/seal.ts), so a credential copied to another
// workspace's row does not open; and the server's records (mcp-record-keys.ts), so a save's source, its Composio record
// and its account are the workspace's own. A shared server keeps its bare name, its row and AAD as before.
//
// The code above the store (McpServersOverStore, the secret-write gate, a run's claim) names servers as a run grants
// them, by the bare name. An McpView maps that name onto the row it means, and back: a scoped request's view
// (requestMcp) reaches its workspace's rows alone, so another workspace's server reads as an unknown name, and an
// unscoped one's the shared rows alone. A run's claim (runMcp) reads each server its pin names from its workspace's row
// when it has one, else from the shared row of that name.
import type { Mcp, McpServerRow, Settings } from "./store/index.js";
import { composioAccountKey, composioMadeKey, mcpSourceKey } from "./store/mcp-record-keys.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { workspaceNow } from "./workspace-scope.js";

/** The row key of the server `name` in `workspace`: the bare name for a shared one (no workspace). */
export const mcpRowKey = (name: string, workspace: string | undefined): string => (workspace === undefined ? name : `${workspace}/${name}`);

/** The workspace a row key is in, or undefined for a shared row. */
export const mcpRowWorkspace = (key: string): string | undefined => {
  const at = key.indexOf("/");
  return at < 0 ? undefined : key.slice(0, at);
};

/** How a view reaches the registry: the row key a bare `name` means (undefined: none the view reaches), and the bare name
 *  a row is shown under (undefined: a row the view does not show). */
export interface McpNames {
  keyOf(name: string): string | undefined;
  nameOf(key: string): string | undefined;
}

/** The registry through a view: what it names, by its bare names. */
export type McpView = Mcp & {
  /** The row key `name` is kept under here: its credential is sealed at it (mcp-store.ts). */
  rowKey(name: string): string;
};

/** The settings keys of a server's records, each before the server's name (mcp-record-keys.ts). */
const RECORDS = [mcpSourceKey, composioMadeKey, composioAccountKey].map((key) => key(""));

/** The settings key a server record's `key` is kept under in the view: a record of a server's name, its row key's; every
 *  other key as it is. Undefined for a record of a name the view does not reach. */
function recordKey(names: McpNames, key: string): string | undefined {
  const prefix = RECORDS.find((one) => key.startsWith(one));
  const name = prefix === undefined ? undefined : key.slice(prefix.length);
  // A name that is no server's (a key under the prefix for something else) is kept as it is; a row key ("/") goes through
  // the view as a name does, so a request never reaches another workspace's record by naming its row.
  if (name === undefined || (!MCP_SERVER_NAME.test(name) && !name.includes("/"))) return key;
  const at = names.keyOf(name);
  return at === undefined ? undefined : `${prefix}${at}`;
}

const refused = (name: string): never => {
  throw new Error(`The MCP server ${name} is not in reach of this request.`);
};

/** `store` with its registry and its servers' records seen through `names`: every bare name in, its row key; every row
 *  out, its bare name, and `sealedAs` its row key when the two differ. A name the view does not reach reads as no
 *  server, and is never written. */
export function mcpView<S extends { mcp: Mcp; settings: Pick<Settings, "get" | "put" | "remove" | "removeIf"> }>(store: S, names: McpNames): S & { mcp: McpView } {
  const raw = store.mcp;
  const key = (name: string) => names.keyOf(name) ?? refused(name);
  const shown = <R extends McpServerRow | undefined>(row: R): R => {
    if (!row) return row;
    const name = names.nameOf(row.name);
    if (name === undefined) return undefined as R;
    return (name === row.name ? row : { ...row, name, sealedAs: row.name }) as R;
  };
  const mark = <M extends { record: string } | undefined>(given: M): M => (given ? { ...given, record: recordKey(names, given.record) ?? refused(given.record) } : given);
  const reach = <T>(name: string, read: (at: string) => Promise<T | undefined>): Promise<T | undefined> => {
    const at = names.keyOf(name);
    return at === undefined ? Promise.resolve(undefined) : read(at);
  };
  const mcp: McpView = {
    rowKey: key,
    put: async (server) => shown(await raw.put({ ...server, name: key(server.name) })),
    putIfCredential: async (server, expected, tokens, owns) => shown(await raw.putIfCredential({ ...server, name: key(server.name) }, expected, mark(tokens), mark(owns))),
    rewrite: async (server, seen, owns) => shown(await raw.rewrite({ ...server, name: key(server.name) }, seen, mark(owns))),
    remove: (name) => reach(name, (at) => raw.remove(at)),
    removeIfCredential: (name, expected, tokens) => reach(name, (at) => raw.removeIfCredential(at, expected, mark(tokens))),
    servers: async () => (await raw.servers()).flatMap((row) => shown(row) ?? []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    server: (name) => reach(name, async (at) => shown(await raw.server(at))),
    stamp: (name) => reach(name, (at) => raw.stamp(at)),
    pin: (runId) => raw.pin(runId),
    leaseRefresh: async (name, lease) => {
      const got = await raw.leaseRefresh(key(name), lease);
      return { ...got, row: shown(got.row) ?? refused(name) };
    },
    keepRefreshed: async (name, keep) => {
      const got = await raw.keepRefreshed(key(name), keep);
      return { ...got, row: shown(got.row) };
    },
    releaseRefresh: (name, holder) => raw.releaseRefresh(key(name), holder),
  };
  const settings = store.settings;
  const view = {
    ...settings,
    get: async (at: string) => {
      const mapped = recordKey(names, at);
      return mapped === undefined ? undefined : settings.get(mapped);
    },
    put: (at: string, value: unknown) => settings.put(recordKey(names, at) ?? refused(at), value),
    remove: async (at: string) => {
      const mapped = recordKey(names, at);
      if (mapped !== undefined) await settings.remove(mapped);
    },
    removeIf: async (at: string, was: unknown) => {
      const mapped = recordKey(names, at);
      return mapped === undefined ? false : settings.removeIf(mapped, was);
    },
  };
  // A proxy, not a copy: the store's own methods (flush, close) keep their store as `this`.
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "mcp") return mcp;
      if (prop === "settings") return view;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as S & { mcp: McpView };
}

/** The request's view (mcpView), read at each call from the request being served: a scoped one's workspace rows alone
 *  under their bare names; an unscoped one's (and the server's own work's) shared rows alone. */
export const requestNames: McpNames = {
  keyOf: (name) => (name.includes("/") ? undefined : mcpRowKey(name, workspaceNow())),
  nameOf: (key) => {
    const workspace = workspaceNow();
    if (workspace === undefined) return key.includes("/") ? undefined : key;
    return mcpRowWorkspace(key) === workspace ? key.slice(workspace.length + 1) : undefined;
  },
};

/** The row key `name` resolves to for an agent's run in `workspace` (null or undefined: none): its workspace's row when
 *  one is saved, else the shared row's name (saved or not). */
export async function resolvedMcpKey(mcp: Pick<Mcp, "server">, name: string, workspace: string | null | undefined): Promise<string> {
  if (workspace === null || workspace === undefined) return name;
  const own = mcpRowKey(name, workspace);
  return (await mcp.server(own)) ? own : name;
}

/** A run's view: each of `servers` (bare names) at the row resolvedMcpKey gives for the run's `workspace`; every other row
 *  under its own key, as an unscoped reader of the whole registry sees it, but a shared row one of them shadows. */
export async function runMcp<S extends { mcp: Mcp; settings: Pick<Settings, "get" | "put" | "remove" | "removeIf"> }>(store: S, workspace: string | null | undefined, servers: readonly string[]): Promise<S & { mcp: McpView }> {
  const keys = new Map<string, string>();
  for (const name of servers) keys.set(name, await resolvedMcpKey(store.mcp, name, workspace));
  const names = new Map([...keys].map(([name, at]) => [at, name]));
  const shadowed = (key: string) => keys.has(key) && keys.get(key) !== key;
  return mcpView(store, { keyOf: (name) => keys.get(name) ?? name, nameOf: (key) => names.get(key) ?? (shadowed(key) ? undefined : key) });
}
