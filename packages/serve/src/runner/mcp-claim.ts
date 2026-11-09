// The runner's MCP claim step: once per claim, before the run's loop starts (tl-mcp's note, sections 1, 4 and 5).
//
// The pin. A run's pin (the granted MCP tools as their servers listed them, each server's URL then, its prices) is made
// at its first claim by mcpPinOf over the registry's rows and written by store.mcp.pinOnce: in its own store transaction,
// behind the claim's epoch fence, inserted only when the run has none. So it exists before anything is sent, is written
// once and never rewritten, and a crash between it and the loop's first commit leaves it for the next claim to read as
// written (the first claim's snapshot, by design). tl-mcp acked this over the note's first "same commit as the first
// journal entries" (11-08); the note's section 1 says so now. A pin that cannot be made refuses the claim in its words.
// At every claim the pin is checked again: a pinned tool that is a meta tool now refuses the claim in words, nothing sent.
//
// The credentials. The pinned servers' credentials are unsealed (store/seal.ts openMcpCredential) into this step's
// memory only: handed to the run's gateway, never written to the journal, a command row, the timeline or a log line. The
// redaction set is fed from the same map. Both are dropped at release(), at the loop's end, or when the claim's signal
// aborts. A credential that can't be used gives its server's calls a reason (mcp-servers.ts UNUSABLE) and they are refused
// unsent: no seal key (checked before any refresh, so none is sent), sealed under another key or for another origin than
// its row's url (damaged), a sign-in refused or expired (signedOut), a refresh that got no answer (silent).
//
// fresh(). After the pin check and before the loop, and again on a command-row resume: an OAuth access token past its
// expiry is refreshed, bounded (4 s a request, two tries), under the server's refresh lease (leaseRefresh, then the
// network outside any transaction, then refreshToken writing the new set and clearing the lease): one refresh at a time,
// so a provider that rotates refresh tokens never sees one spent twice; a claim without the lease takes the set its
// holder keeps, woken when a holder in this process lets the lease go (read once more at the lease's end for one
// elsewhere), never polling. A refresh once sent is never cut short: a shutdown, a lost claim or the run's end stops
// only what is not yet sent, and an answer still on the wire is awaited within its deadline and kept, since the
// authorization server may already have spent the old refresh token. A token still valid but near its expiry is
// used at once and refreshed behind it, never holding the claim. After any awaited refresh the claim's epoch is
// confirmed again: a claim lost meanwhile is Fenced, and the loop never starts.
import { randomUUID } from "node:crypto";
import { REFRESH_REQUEST_MS, refreshed, refused, systemNetwork, type OAuthNetwork, type TokenSet } from "../mcp-oauth.js";
import { type McpCredentials, type McpPin, mcpPinOf } from "../mcp-gateway.js";
import { META_REASON, metaToolOf } from "../mcp-meta.js";
import { REFRESH_MARGIN_MS, UNKNOWN_EXPIRY_MS, UNUSABLE } from "../mcp-servers.js";
import { openMcpCredential, sealMcpCredential, type McpCredential } from "../store/seal.js";
import { type Claim, Fenced, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, type McpServerRow, RefreshLeaseLost, type Store } from "../store/index.js";

/** A claim the MCP step refused, in the words a person reads: nothing was sent. */
export class McpClaimRefused extends Error {
  override name = "McpClaimRefused";
}

export interface McpClaimOptions {
  store: Pick<Store, "mcp" | "runs">;
  claim: Pick<Claim, "runId" | "epoch">;
  /** The run's granted tools, by catalog name (`mcp:<server>/<tool>` among them). */
  grants: readonly string[];
  /** The runner's seal key (the server's): undefined when it was started without one. */
  sealKey: Buffer | undefined;
  /** The claim's signal: aborted when the claim is lost or the runner stops. */
  signal: AbortSignal;
  /** A refresh's bound: each request's time and how many tries (REFRESH_REQUEST_MS, two). */
  bounds?: { requestMs?: number; tries?: number };
  /** The clock, in ms. */
  now?: () => number;
  /** The authorization servers' network (mcp-oauth.ts). */
  network?: OAuthNetwork;
}

export interface McpClaimStep {
  /** The run's pin; undefined when it grants no MCP tool. */
  readonly pin: McpPin | undefined;
  /** Each pinned server's URL now, with its headers or why they can't be used: the run's gateway's `credentials`, which
   *  it reads at every request, so a refresh or a removal here reaches a gateway already built. */
  readonly credentials: McpCredentials;
  /** Every credential value held, for the redaction set. */
  readonly secrets: ReadonlySet<string>;
  /** Refresh what has expired, and open the credentials again; then confirm the claim. Before a resumed loop's next
   *  model request. */
  fresh(): Promise<void>;
  /** Drop every credential held: the loop ended, or the claim is lost. */
  release(): void;
}

type OAuthCredential = McpCredential & { type: "oauth"; set: TokenSet; expired?: true };

/** The MCP step of `options.claim`: its pin made or read and checked, its credentials opened (refreshed as due). */
export async function mcpClaim(options: McpClaimOptions): Promise<McpClaimStep> {
  const { store, claim, sealKey, signal } = options;
  const now = options.now ?? Date.now;
  const network = options.network ?? systemNetwork;
  const requestMs = options.bounds?.requestMs ?? REFRESH_REQUEST_MS;
  const tries = options.bounds?.tries ?? 2;
  // The whole refresh call (every try) is given up at the store's one deadline, MCP_REFRESH_CALL_MS (two tries of 4 s),
  // or sooner at a test's own bound; its lease (MCP_REFRESH_LEASE_MS, the store's default) outlasts that, so the lease
  // never lapses while the call may still spend the refresh token. A holder that dies frees it for the next claim.
  const callMs = Math.min(MCP_REFRESH_CALL_MS, requestMs * tries);
  const holder = `${claim.runId}@${claim.epoch}:${randomUUID()}`;
  const pin = await pinOf(options);
  const credentials: McpCredentials = Object.create(null);
  const secrets = new Set<string>();
  // Refreshes started behind a token still valid: stopped at release.
  const behind = new AbortController();
  let released = false;

  const release = () => {
    released = true;
    behind.abort();
    for (const name of Object.keys(credentials)) delete credentials[name];
    secrets.clear();
  };
  signal.addEventListener("abort", release, { once: true });

  /** The OAuth token set refreshed at its authorization server, bounded: the new set, or why not. `stop` keeps a request
   *  from being sent, never cuts one short: once sent, the authorization server may already have spent the refresh token
   *  (a provider that rotates them), so its answer is awaited, within its own deadline, for the caller to keep. */
  const refresh = async (row: McpServerRow, set: TokenSet, stop: AbortSignal): Promise<{ set: TokenSet } | { refused: true } | { silent: true } | { unsent: true }> => {
    if (!set.tokens.refresh_token) return { refused: true };
    const call = AbortSignal.timeout(callMs);
    for (let tried = 0; tried < tries && !call.aborted; tried++) {
      if (stop.aborted) return tried === 0 ? { unsent: true } : { silent: true };
      const one = AbortSignal.any([call, AbortSignal.timeout(requestMs)]);
      try {
        return { set: await bounded(refreshed(set, row.url, one, network), one) };
      } catch (error) {
        if (await refused(error)) return { refused: true };
      }
    }
    return { silent: true };
  };

  /** The row as another claim's refresh leaves it: read once; while a lease holds it, read again when this process's
   *  holder lets it go (settledOf), or at the lease's own end for a holder elsewhere. */
  const settled = async (name: string, stop: AbortSignal): Promise<McpServerRow | undefined> => {
    // Waiting before the read, so a holder that lets go between the read and the wait still wakes it.
    const wait = settledOf(store.mcp, name, MCP_REFRESH_LEASE_MS, stop);
    const row = await store.mcp.server(name);
    if (!row || row.refreshHolder === null || stop.aborted) return wait.cancel(), row;
    await wait.done;
    return await store.mcp.server(name);
  };

  /** Writes `credential` as the server's sealed credential under this step's lease, clearing it: false when the lease
   *  was lost meanwhile (nothing written). */
  const keep = async (row: McpServerRow, credential: OAuthCredential): Promise<boolean> => {
    const { origin: _origin, ...plain } = credential as OAuthCredential & { origin?: string };
    try {
      await store.mcp.refreshToken(row.name, { holder, sealed: sealMcpCredential(sealKey!, row.name, plain as McpCredential, row.url) });
      return true;
    } catch (error) {
      if (error instanceof RefreshLeaseLost) return false;
      throw error;
    }
  };

  /** One pinned server's credential, opened, refreshed when due (awaited for an expired token; behind it for one near
   *  its expiry). `again`: a row another claim's refresh left, opened as it is, never refreshed from here once more. */
  const open = async (name: string, pinnedUrl: string, again?: McpServerRow): Promise<{ awaited: boolean }> => {
    const row = again ?? (await store.mcp.server(name));
    // Forgotten since the pin: its entry goes (an earlier open's URL and headers with it), so the gateway finds no URL
    // for it and refuses its calls unsent.
    if (!row) {
      delete credentials[name];
      return { awaited: false };
    }
    const entry = (extra: { headers?: Record<string, string>; unopened?: string }) => {
      if (released) return;
      // Headers go only to the URL the run was pinned to: a server moved since is refused per call by the gateway.
      credentials[name] = { url: row.url, ...(extra.unopened ? { unopened: extra.unopened } : extra.headers && row.url === pinnedUrl ? { headers: extra.headers } : {}) };
      for (const value of Object.values(extra.headers ?? {})) secrets.add(value);
    };
    if (row.sealed === null) return entry({}), { awaited: false };
    // A seal problem first: no refresh is ever sent for a credential this runner cannot open.
    if (!sealKey) return entry({ unopened: UNUSABLE.noSealKey }), { awaited: false };
    const opened = openMcpCredential(sealKey, row);
    if (!("credential" in opened)) return entry(opened.unusable === "none" ? {} : { unopened: UNUSABLE.damaged }), { awaited: false };
    const credential = opened.credential;
    if (credential.type === "headers") return entry({ headers: { ...credential.headers } }), { awaited: false };
    const oauth = credential as OAuthCredential;
    if (oauth.expired) return entry({ unopened: UNUSABLE.signedOut }), { awaited: false };
    const set = oauth.set;
    const bearer = (tokens: TokenSet) => ({ authorization: `Bearer ${tokens.tokens.access_token}` });
    const due = set.expires_at ? Date.parse(set.expires_at) : Date.parse(set.obtained_at) + UNKNOWN_EXPIRY_MS;
    if (due - now() > REFRESH_MARGIN_MS) return entry({ headers: bearer(set) }), { awaited: false };
    // Another claim's refresh left this row and it is still due: never refreshed from here once more.
    if (again) return entry(due > now() ? { headers: bearer(set) } : { unopened: UNUSABLE.silent }), { awaited: false };
    const settle = async (stop: AbortSignal): Promise<void> => {
      // One refresh at a time per server, across claims and runners: a provider that rotates its refresh tokens spends
      // the one used, so a second refresh with it would sign the server out. Without the lease, take the row the
      // holder leaves.
      const lease = await store.mcp.leaseRefresh(name, { seen: row.sealed, holder });
      if (!lease.leased) {
        const left = await settled(name, stop);
        if (!stop.aborted && !released && left) await open(name, pinnedUrl, left);
        return;
      }
      try {
        const got = await refresh(lease.row, set, stop);
        // Stopped before anything was sent: the lease is let go, the refresh token unspent.
        if ("unsent" in got) return void (await store.mcp.releaseRefresh(name, holder).catch(() => undefined));
        if ("set" in got) {
          // Kept whatever stopped this step meanwhile (a shutdown, a lost claim, the run's end): the authorization server
          // spent the old refresh token, so the new set is the only one any claim can use. The write is the server's row,
          // not the run's; entry() hands it to this step only while it is held.
          if (await keep(lease.row, { type: "oauth", set: got.set })) return entry({ headers: bearer(got.set) });
          if (stop.aborted || released) return;
          // The lease lapsed while it waited, and another claim kept a set: use the row as it is now.
          const left = await store.mcp.server(name);
          return void (left && (await open(name, pinnedUrl, left)));
        }
        if ("refused" in got) {
          // The sign-in is over: kept as expired, so no later claim tries the refresh token again.
          await keep(lease.row, { ...oauth, expired: true });
          return entry({ unopened: UNUSABLE.signedOut });
        }
        // No answer within its deadline: the lease is let go and the refresh token kept for the next try; an access token
        // past its expiry is never handed over.
        await store.mcp.releaseRefresh(name, holder).catch(() => undefined);
        if (due <= now()) entry({ unopened: UNUSABLE.silent });
      } finally {
        // The lease is let go (kept, released, or left to lapse on a failed write): the claims waiting on it read the row.
        settledNow(store.mcp, name);
      }
    };
    if (due > now()) {
      // Still valid: used at once, refreshed behind it.
      entry({ headers: bearer(set) });
      void settle(AbortSignal.any([signal, behind.signal])).catch(() => undefined);
      return { awaited: false };
    }
    await settle(signal);
    return { awaited: true };
  };

  const fresh = async () => {
    if (!pin || released) return;
    let awaited = false;
    for (const [name, pinned] of Object.entries(pin)) if ((await open(name, pinned.url)).awaited) awaited = true;
    // A refresh waited on: the claim may have moved on meanwhile; never start (or go on with) a loop it no longer holds.
    if (awaited) await confirm(store, claim);
  };

  await fresh();
  return { pin, credentials, secrets, fresh, release };
}

/** The run's pin: read, and checked against the meta tools known now; or made at its first claim and written once. */
async function pinOf({ store, claim, grants }: McpClaimOptions): Promise<McpPin | undefined> {
  const stored = await store.mcp.pin(claim.runId);
  if (stored) {
    const pinned = stored.body as McpPin;
    for (const [server, { url, tools }] of Object.entries(pinned)) {
      for (const tool of tools) if (metaToolOf(url, tool.name)) throw new McpClaimRefused(`mcp:${server}/${tool.name} can't be granted: ${META_REASON}`);
    }
    return pinned;
  }
  if (!grants.some((name) => name.startsWith("mcp:"))) return undefined;
  const rows = new Map((await store.mcp.servers()).map((row) => [row.name, row]));
  let made: McpPin;
  try {
    made = mcpPinOf(grants, {
      server: (name) => {
        const row = rows.get(name);
        return row && { url: row.url, tools: (row.tools ?? []) as never, ...(row.prices ? { prices: row.prices as Record<string, number> } : {}) };
      },
      headers: () => undefined,
    });
  } catch (error) {
    throw new McpClaimRefused((error as Error).message);
  }
  if (!Object.keys(made).length) return undefined;
  return (await store.mcp.pinOnce(claim as Claim, made)).body as McpPin;
}

/** The claim still the run's: its epoch unchanged, else Fenced. */
async function confirm(store: Pick<Store, "runs">, claim: Pick<Claim, "runId" | "epoch">): Promise<void> {
  const run = await store.runs.get(claim.runId);
  if (run?.epoch !== claim.epoch) throw new Fenced(claim.runId, claim.epoch);
}

/** The claims of this process waiting on a server's refresh lease, by the store's MCP registry and the server's name:
 *  woken when the holder lets the lease go, so a waiting claim never polls the row. */
const waiting = new WeakMap<object, Map<string, Set<() => void>>>();

/** A wait for `name`'s lease to be let go by a holder in this process (settledNow), at most `ms`, or until `stop`. */
function settledOf(registry: object, name: string, ms: number, stop: AbortSignal): { done: Promise<void>; cancel(): void } {
  const servers = waiting.get(registry) ?? new Map<string, Set<() => void>>();
  waiting.set(registry, servers);
  const waiters = servers.get(name) ?? new Set<() => void>();
  servers.set(name, waiters);
  let wake!: () => void;
  const done = new Promise<void>((resolve) => (wake = resolve));
  const timer = setTimeout(() => finish(), ms);
  const finish = () => {
    clearTimeout(timer);
    stop.removeEventListener("abort", finish);
    waiters.delete(finish);
    if (waiters.size === 0 && servers.get(name) === waiters) servers.delete(name);
    wake();
  };
  waiters.add(finish);
  stop.addEventListener("abort", finish, { once: true });
  return { done, cancel: finish };
}

/** Wakes every claim of this process waiting on `name`'s refresh lease. */
function settledNow(registry: object, name: string): void {
  for (const finish of [...(waiting.get(registry)?.get(name) ?? [])]) finish();
}

/** `work`, or a rejection as soon as `signal` aborts (a refresh's own fetch may not see the abort at once). */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
