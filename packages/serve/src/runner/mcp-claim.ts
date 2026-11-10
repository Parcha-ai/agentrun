// The runner's MCP claim step: once per claim, before the run's loop starts.
//
// The pin. A run's pin (the granted MCP tools as their servers listed them, each server's URL then, its prices) is made
// at its first claim by mcpPinOf over the registry's rows and written by store.mcp.pinOnce: in its own store transaction,
// behind the claim's epoch fence, inserted only when the run has none. So it exists before anything is sent, is written
// once and never rewritten, and a crash between it and the loop's first commit leaves it for the next claim to read as
// written (the first claim's snapshot, by design), rather than in the same commit as the first journal entries. A pin
// that cannot be made refuses the claim in its words.
// At every claim the pin is checked again: a pinned tool that is a meta tool now refuses the claim in words, nothing sent.
//
// The credentials. The pinned servers' credentials are unsealed (store/seal.ts openMcpCredential) into this step's
// memory only: handed to the run's gateway, never written to the journal, a command row, the timeline or a log line.
// Every value handed over (a header's, a bearer's token alone, an access token refreshed mid-claim, a github_app token
// minted or minted again) is held by the run's one redactor (`redact`) at that moment, through the one place an entry is
// made, so a log line or error text the run writes is cut of it as the gateway's own scrub cuts a call's answer. The
// entries are dropped at release(), at the loop's end, or when the claim's signal aborts. A credential that can't be
// used gives its server's calls a reason (mcp-probe.ts UNUSABLE) and they are refused unsent: sealed under another key
// or for another origin than its row's url (damaged), a sign-in refused or expired (signedOut), a refresh that got no
// answer (silent), an address the check refuses (blocked). A runner never starts without the seal key
// (seal-key.ts ensureSealKey), so a claim always has one.
//
// fresh(). After the pin check and before the loop, and again on a command-row resume: an OAuth access token past its
// expiry is refreshed, bounded (the call within MCP_REFRESH_CALL_MS; a request not yet dialled within 4 s, and tried again
// only when it provably never left: a refused or unmade connection, an address check out of time; one request that left
// is sent once, its answer awaited within the call's deadline, and after no answer the lease is held to its end so no
// claim sends the possibly spent refresh token again), under the server's refresh lease (leaseRefresh, then the
// network outside any transaction, then keepRefreshed writing the new set iff the credential is still the one it started
// from, and clearing the lease if still ours; a newer credential drops ours, logged by name): one refresh at a time,
// so a provider that rotates refresh tokens never sees one spent twice; a claim without the lease takes the set its
// holder keeps, woken when a holder in this process lets the lease go (read once more at the lease's end for one
// elsewhere), never polling. A refresh once sent is never cut short: a shutdown, a lost claim or the run's end stops
// only what is not yet sent, and an answer still on the wire is awaited within its deadline and kept, since the
// authorization server may already have spent the old refresh token. A token still valid but near its expiry is
// used at once and refreshed behind it, never holding the claim. After any awaited refresh the claim's epoch is
// confirmed again: a claim lost meanwhile is Fenced, and the loop never starts.
//
// check(). Before each call leaves (the gateway's `before`), the server's row stamp is read (store.mcp.stamp: its url,
// auth, credential_changed_at and its token's end by the store's clock; no tools, no sealed bytes): a server removed
// since loses its entry, so the call is refused unsent; a credential replaced or a server moved since is opened again, so
// the next call sends the new one (or is refused for the move); and an OAuth access token within REFRESH_MARGIN_MS of its
// end is refreshed first, through open's lease path, then the call goes. Concurrent calls to one server share one such
// open.
import { randomUUID } from "node:crypto";
import { EndpointRefused, REFRESH_REQUEST_MS, refreshed, refused, RequestUnsent, type Seen, systemNetwork, type OAuthNetwork, type TokenSet } from "../mcp-oauth.js";
import { type McpCredentials, type McpPin, mcpPinOf } from "../mcp-gateway.js";
import { META_REASON, metaToolOf } from "../mcp-meta.js";
import { boundTool, type McpTool } from "../mcp-probe.js";
import { privateOAuthHosts } from "../mcp-private-hosts.js";
import { GITHUB_MCP_ONLY, GITHUB_MCP_ORIGIN, githubMcpUrl } from "../github.js";
import { type GithubAppAccess, type GithubTimer, githubTokens } from "./mcp-github.js";
import { ClaimRefused } from "./loop-contract.js";
import { REFRESH_MARGIN_MS, UNKNOWN_EXPIRY_MS, UNUSABLE } from "../mcp-servers.js";
import { tokenLeftOf } from "../mcp-probe.js";
import { openMcpCredential, sealMcpCredential, type McpCredential } from "../store/seal.js";
import { type Claim, Fenced, MCP_REFRESH_CALL_MS, type McpServerRow, type Store } from "../store/index.js";

/** Every credential value of `headers`: each header's value, and its token alone with any one-word scheme taken off
 *  (`Bearer `), which a server may echo bare (as the gateway's scrub cuts them). */
const credentialValues = (headers: Record<string, string>): string[] =>
  Object.values(headers).flatMap((value) => [value, value.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+(?=\S+$)/, "")]);

/** Whether two sealed credentials are the same bytes (none equals none). */
const sameSealed = (a: Uint8Array | null, b: Uint8Array | null): boolean => (a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b)));

/** A claim the MCP step refused, in the words a person reads: nothing was sent. */
export class McpClaimRefused extends ClaimRefused {
  override name = "McpClaimRefused";
}

export interface McpClaimOptions {
  /** `settings`: the private-network OAuth hosts the owner allows (privateOAuthHosts), read at each refresh. `where`:
   *  the store's identity, which a wait on another claim's refresh lease is keyed by. */
  store: Pick<Store, "mcp" | "runs" | "settings" | "where">;
  claim: Pick<Claim, "runId" | "epoch">;
  /** The run's granted tools, by catalog name (`mcp:<server>/<tool>` among them). */
  grants: readonly string[];
  /** The runner's seal key (the server's): a runner never starts without one (seal-key.ts ensureSealKey). */
  sealKey: Buffer;
  /** The claim's signal: aborted when the claim is lost or the runner stops. */
  signal: AbortSignal;
  /** A refresh's bound: each request's time and how many tries (REFRESH_REQUEST_MS, two). */
  bounds?: { requestMs?: number; tries?: number };
  /** The clock, in ms. */
  now?: () => number;
  /** The authorization servers' network (mcp-oauth.ts). */
  network?: OAuthNetwork;
  /** For a github_app server (auth github_app, nothing sealed): the server's GitHub App mint and the run's repository
   *  (runner/mcp-github.ts). None: such a server's calls are refused in words. */
  githubApp?: GithubAppAccess;
  /** For tests only (no environment or CLI flag maps onto it): the one origin a github_app server may have, a fake for
   *  GitHub's hosted MCP (GITHUB_MCP_ORIGIN). */
  githubMcpOrigin?: string;
  /** For tests: the timer a github_app token's refresh and expiry are armed on. */
  githubTimer?: GithubTimer;
  /** For tests: the timer a wait on another claim's refresh lease, and its next read of the row, are armed on. */
  timer?: SettleTimer;
  /** Where a refreshed set dropped for a newer credential is said, by its server's name only (console.warn by default). */
  log?: (line: string) => void;
  /** The run's one redactor (runner/redact.ts HeldRedact, the spec's `cut`): every credential value this step hands the
   *  gateway is held by it as it is handed over. None: the gateway's per-call scrub alone. */
  redact?: { hold(values: readonly string[]): void };
}

export interface McpClaimStep {
  /** The run's pin; undefined when it grants no MCP tool. */
  readonly pin: McpPin | undefined;
  /** Each pinned server's URL now, with its headers or why they can't be used: the run's gateway's `credentials`, which
   *  it reads at every request, so a refresh or a removal here reaches a gateway already built. */
  readonly credentials: McpCredentials;
  /** Refresh what has expired, and open the credentials again; then confirm the claim. Before a resumed loop's next
   *  model request. */
  fresh(): Promise<void>;
  /** Before each call to pinned server `name` (the gateway's `before`): its row stamp read; opened again when it changed
   *  or its access token is near its end (refreshed first), its entry dropped when it is no longer saved. */
  check(name: string): Promise<void>;
  /** Drop every credential held: the loop ended, or the claim is lost. */
  release(): void;
}

type OAuthCredential = McpCredential & { type: "oauth"; set: TokenSet; expired?: true };

/** The MCP step of `options.claim`: its pin made or read and checked, its credentials opened (refreshed as due). */
export async function mcpClaim(options: McpClaimOptions): Promise<McpClaimStep> {
  const { store, claim, sealKey, signal } = options;
  const now = options.now ?? Date.now;
  const timer = options.timer ?? systemTimer;
  const network = options.network ?? systemNetwork;
  const log = options.log ?? ((line: string) => console.warn(line));
  const requestMs = options.bounds?.requestMs ?? REFRESH_REQUEST_MS;
  const tries = options.bounds?.tries ?? 2;
  // The whole refresh call (every try) is given up at the store's one deadline, MCP_REFRESH_CALL_MS (two tries of 4 s),
  // or sooner at a test's own bound; its lease (MCP_REFRESH_LEASE_MS, the store's default) outlasts that, so the lease
  // never lapses while the call may still spend the refresh token. A holder that dies frees it for the next claim.
  const callMs = Math.min(MCP_REFRESH_CALL_MS, requestMs * tries);
  const holder = `${claim.runId}@${claim.epoch}:${randomUUID()}`;
  const pin = await pinOf(options);
  const credentials: McpCredentials = Object.create(null);
  // Refreshes started behind a token still valid: stopped at release.
  const behind = new AbortController();
  let released = false;
  /** What each pinned server's entry was opened from (its row's url, auth and credential time, and an OAuth token's end
   *  on this claim's clock), which check() compares the row's stamp with. */
  const stamps = new Map<string, { url: string; auth: string; changedAt: number | null; end?: number }>();
  /** The servers check() found removed: nothing (a github_app token's refresh among it) puts their entry back. */
  const gone = new Set<string>();
  /** The opens check() started, by server: concurrent calls share one. */
  const reopening = new Map<string, Promise<unknown>>();

  // A github_app server's installation token: minted at each claim, refreshed mid-run, held here only.
  const github = githubTokens(options.githubApp, { now, ...(options.githubTimer ? { arm: options.githubTimer } : {}) });

  const release = () => {
    released = true;
    behind.abort();
    github.release();
    for (const name of Object.keys(credentials)) delete credentials[name];
  };
  signal.addEventListener("abort", release, { once: true });

  /** The OAuth token set refreshed at its authorization server, bounded: the new set, or why not. One request is sent per
   *  lease: `stop` and the try's own time (requestMs) bound a request only until it is dialled, and it is tried again only
   *  when it provably never left (RequestUnsent). Once sent, the authorization server may already have spent the refresh
   *  token (a provider that rotates them, and may revoke the grant on its reuse), so it is never cut short nor sent again:
   *  its answer is awaited within the call's deadline. `silent` with `held`: it left and no answer came (or an unclear
   *  failure), so the lease is held to its end and no claim sends that refresh token again meanwhile. */
  const refresh = async (row: McpServerRow, set: TokenSet, stop: AbortSignal): Promise<{ set: TokenSet } | { refused: true } | { silent: true; held?: true } | { unsent: true } | { blocked: string }> => {
    if (!set.tokens.refresh_token) return { refused: true };
    const call = AbortSignal.timeout(callMs);
    const reach = { allowed: await privateOAuthHosts(store) };
    for (let tried = 0; tried < tries && !call.aborted; tried++) {
      // Every try before this one provably never left: nothing is spent.
      if (stop.aborted) return { unsent: true };
      const seen: Seen = {};
      try {
        return { set: await bounded(refreshed(set, row.url, AbortSignal.any([call, stop, AbortSignal.timeout(requestMs)]), network, reach, { within: call, seen }), call) };
      } catch (error) {
        if (await refused(error)) return { refused: true };
        // Its authorization server's address is refused here (mcp-oauth.ts checked): nothing was sent, and a second try
        // meets the same refusal.
        if (error instanceof EndpointRefused) return { blocked: error.message };
        // Never left: tried again, while the call has time.
        if (error instanceof RequestUnsent) continue;
        // It answered with an error and granted nothing (a 5xx, an OAuth error but a revocation): no token is in flight,
        // so the lease is let go for the next claim; never sent again by this one.
        if (seen.failed?.status !== undefined) return { silent: true };
        // It left and no answer came, or failed unclearly: the refresh token may be spent.
        return { silent: true, held: true };
      }
    }
    return { silent: true };
  };

  /** The row as another claim's refresh leaves it: read; while a lease holds it, read again when a holder in this process
   *  lets it go (settledOf, keyed by the store's `where`, so another instance over the same data wakes it too), or at the
   *  next poll (MCP_SETTLE_POLL_MS) for a holder in another process; until the row is let go, its lease lapses (taken
   *  over as it is), or `stop`. */
  const settled = async (name: string, stop: AbortSignal): Promise<McpServerRow | undefined> => {
    for (;;) {
      // Waiting before the read, so a holder that lets go between the read and the wait still wakes it.
      const wait = settledOf(store.where, name, MCP_SETTLE_POLL_MS, stop, timer);
      const row = await store.mcp.server(name);
      // The lease is the store's: judged by the store's clock (refreshLapsed), never this claim's, which on another
      // machine may run ahead of it and read a live lease as lapsed.
      const lapsed = row?.refreshLapsed === true;
      if (!row || row.refreshHolder === null || lapsed || stop.aborted) return wait.cancel(), row;
      await wait.done;
    }
  };

  /** Writes `credential` as the server's sealed credential iff the row's is still the one this refresh started from
   *  (`row.sealed`, its lease's), whoever holds the lease now: its token is spent at the provider, so a lease that lapsed
   *  never loses it. False when the credential changed meanwhile (a newer set, an owner's save): ours is dropped, nothing
   *  written, never retried, and said by the server's name only. */
  const keep = async (row: McpServerRow, credential: OAuthCredential): Promise<boolean> => {
    const { origin: _origin, ...plain } = credential as OAuthCredential & { origin?: string };
    // The set's token life, measured on the clock that stamped it (this process's, mcp-oauth.ts): the store lays it on its own.
    const { kept } = await store.mcp.keepRefreshed(row.name, { seen: row.sealed, sealed: sealMcpCredential(sealKey, row.name, plain as McpCredential, row.url), holder, tokenLeftMs: tokenLeftOf(plain) });
    if (!kept) log(`mcp ${row.name}: its credential changed while this claim refreshed it; the refreshed set was dropped and the server's current one is used`);
    return kept;
  };

  /** One pinned server's credential, opened, refreshed when due (awaited for an expired token; behind it for one near
   *  its expiry, or awaited too when `first`: a call waits on it, check()). `again`: a row another claim's refresh left,
   *  opened as it is, never refreshed from here once more. */
  const open = async (name: string, pinnedUrl: string, again?: McpServerRow, first = false): Promise<{ awaited: boolean }> => {
    const row = again ?? (await store.mcp.server(name));
    // Forgotten since the pin: its entry goes (an earlier open's URL and headers with it), so the gateway finds no URL
    // for it and refuses its calls unsent.
    if (!row) {
      stamps.delete(name);
      delete credentials[name];
      return { awaited: false };
    }
    gone.delete(name);
    stamps.set(name, { url: row.url, auth: row.auth, changedAt: row.credentialChangedAt });
    const entry = (extra: { headers?: Record<string, string>; unopened?: string }) => {
      // Held by the run's redactor before anything else: a value opened is a value to cut, sent or not.
      if (extra.headers) options.redact?.hold(credentialValues(extra.headers));
      if (released || gone.has(name)) return;
      // Headers go only to the URL the run was pinned to: a server moved since is refused per call by the gateway.
      credentials[name] = { url: row.url, ...(extra.unopened ? { unopened: extra.unopened } : extra.headers && row.url === pinnedUrl ? { headers: extra.headers } : {}) };
    };
    // A GitHub App's server keeps no credential: its token is minted for this run (awaited, so the claim is confirmed
    // after it), kept fresh mid-run, and never stored.
    if (row.auth === "github_app") return await github.open(name, entry), { awaited: true };
    if (row.sealed === null) return entry({}), { awaited: false };
    // A seal problem first: no refresh is ever sent for a credential this runner cannot open.
    const opened = openMcpCredential(sealKey, row);
    if (!("credential" in opened)) return entry(opened.unusable === "none" ? {} : { unopened: UNUSABLE.damaged }), { awaited: false };
    const credential = opened.credential;
    if (credential.type === "headers") return entry({ headers: { ...credential.headers } }), { awaited: false };
    const oauth = credential as OAuthCredential;
    if (oauth.expired) return entry({ unopened: UNUSABLE.signedOut }), { awaited: false };
    const set = oauth.set;
    const bearer = (tokens: TokenSet) => ({ authorization: `Bearer ${tokens.tokens.access_token}` });
    // What is left of the access token: by the store's clock (tokenLeftMs, its end stamped by the store when the credential
    // was written), less what this claim's own clock has counted since the row was read; never this claim's clock against
    // the set's expires_at, which the writer stamped on its clock. A row written with no measure of its token (no writer of
    // serve's) is judged by the set's end on this claim's clock.
    const readAt = now();
    const end = set.expires_at ? Date.parse(set.expires_at) : Date.parse(set.obtained_at) + UNKNOWN_EXPIRY_MS;
    const left = (): number => (row.tokenLeftMs === null ? end - now() : row.tokenLeftMs - (now() - readAt));
    stamps.set(name, { url: row.url, auth: row.auth, changedAt: row.credentialChangedAt, end: readAt + left() });
    if (left() > REFRESH_MARGIN_MS) return entry({ headers: bearer(set) }), { awaited: false };
    // Another claim's refresh left this row and it is still due: never refreshed from here once more.
    if (again) return entry(left() > 0 ? { headers: bearer(set) } : { unopened: UNUSABLE.silent }), { awaited: false };
    /** The row another claim's refresh (or an owner's save) left, opened as it is, never refreshed from here once more;
     *  a server forgotten meanwhile loses its entry. */
    const takeLeft = async (left: McpServerRow | undefined): Promise<void> => {
      if (left) await open(name, pinnedUrl, left);
      else delete credentials[name];
    };
    const settle = async (stop: AbortSignal, again = false): Promise<void> => {
      // One refresh at a time per server, across claims and runners: a provider that rotates its refresh tokens spends
      // the one used, so a second refresh with it would sign the server out. Without the lease, take the row the
      // holder leaves.
      const lease = await store.mcp.leaseRefresh(name, { seen: row.sealed, holder });
      if (!lease.leased) {
        const left = await settled(name, stop);
        if (stop.aborted || released || !left) return;
        // Its holder kept nothing and its lease ran out (a refresh that got no answer holds the lease to its end, so its
        // possibly spent token is sent by no one meanwhile): the refresh is this claim's to try now, once.
        if (!again && left.refreshLapsed && sameSealed(left.sealed, row.sealed)) return settle(stop, true);
        await open(name, pinnedUrl, left);
        return;
      }
      try {
        // Read once more under the lease before anything is sent: a claim whose lease lapsed may have kept its set just
        // as this one was granted (keepRefreshed lands for whoever holds the lease), and its refresh token is the one the
        // provider has now. Ours is spent: never sent, the lease let go, the row opened as that claim left it.
        const current = await store.mcp.server(name);
        if (!current || !sameSealed(current.sealed, lease.row.sealed)) {
          await store.mcp.releaseRefresh(name, holder).catch(() => undefined);
          if (!stop.aborted && !released) await takeLeft(current);
          return;
        }
        const got = await refresh(lease.row, set, stop);
        // Stopped before anything was sent: the lease is let go, the refresh token unspent.
        if ("unsent" in got) return void (await store.mcp.releaseRefresh(name, holder).catch(() => undefined));
        // Refused unsent by the address check: the lease is let go, the refresh token unspent, and an access token past
        // its expiry is refused in the check's words (a private host the owner may allow names where).
        if ("blocked" in got) {
          await store.mcp.releaseRefresh(name, holder).catch(() => undefined);
          if (left() <= 0) entry({ unopened: `${UNUSABLE.blocked}: ${got.blocked}` });
          return;
        }
        if ("set" in got) {
          // Kept whatever stopped this step meanwhile (a shutdown, a lost claim, the run's end): the authorization server
          // spent the old refresh token, so the new set is the only one any claim can use. The write is the server's row,
          // not the run's; entry() hands it to this step only while it is held.
          if (await keep(lease.row, { type: "oauth", set: got.set })) return entry({ headers: bearer(got.set) });
          if (stop.aborted || released) return;
          // The credential changed while it refreshed (a newer set, an owner's save): use the row as it is now.
          const left = await store.mcp.server(name);
          return void (await takeLeft(left));
        }
        if ("refused" in got) {
          // The sign-in is over: kept as expired, so no later claim tries the refresh token again. A credential changed
          // meanwhile is the one to use.
          if (await keep(lease.row, { ...oauth, expired: true })) return entry({ unopened: UNUSABLE.signedOut });
          if (stop.aborted || released) return;
          return void (await takeLeft(await store.mcp.server(name)));
        }
        // No answer within its deadline. When its request left (held), the lease is held to its end: the refresh token may
        // be spent, and no claim sends it again before then. Otherwise (it never left, or the server answered and granted
        // nothing) the lease is let go and the refresh token kept for the next try. An access token past its expiry is never
        // handed over.
        if (!("held" in got)) await store.mcp.releaseRefresh(name, holder).catch(() => undefined);
        if (left() <= 0) entry({ unopened: UNUSABLE.silent });
      } finally {
        // The lease is let go (kept, released, or left to lapse on a failed write): the claims waiting on it read the row.
        settledNow(store.where, name);
      }
    };
    if (left() > 0) {
      // Still valid: used at once, refreshed behind it; or, for a call about to leave (`first`), refreshed before it, the
      // token held meanwhile still the one a refresh with no answer leaves.
      entry({ headers: bearer(set) });
      if (!first) {
        void settle(AbortSignal.any([signal, behind.signal])).catch(() => undefined);
        return { awaited: false };
      }
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

  const check = async (name: string): Promise<void> => {
    if (!pin || released || !Object.hasOwn(pin, name)) return;
    const stamp = await store.mcp.stamp(name);
    if (released) return;
    if (!stamp) {
      // Removed since: its entry goes, so its calls are refused unsent; nothing puts it back.
      gone.add(name);
      stamps.delete(name);
      delete credentials[name];
      return;
    }
    const was = stamps.get(name);
    const changed = !was || gone.has(name) || was.url !== stamp.url || was.auth !== stamp.auth || was.changedAt !== stamp.credentialChangedAt;
    // The token's end by the store's clock (tokenLeftMs), else as this claim opened it.
    const left = stamp.tokenLeftMs ?? (was?.end !== undefined ? was.end - now() : null);
    const due = stamp.auth === "oauth" && left !== null && left <= REFRESH_MARGIN_MS;
    if (!changed && !due) return;
    let going = reopening.get(name);
    if (!going) {
      going = open(name, pin[name]!.url, undefined, true).finally(() => reopening.delete(name));
      reopening.set(name, going);
    }
    await going;
  };

  await fresh();
  return { pin, credentials, fresh, check, release };
}

/** The run's pin: read, and checked against the meta tools known now; or made at its first claim and written once. */
async function pinOf({ store, claim, grants, githubMcpOrigin = GITHUB_MCP_ORIGIN }: McpClaimOptions): Promise<McpPin | undefined> {
  // A github_app server anywhere but GitHub's hosted MCP ends the run here, before any token is minted or anything sent:
  // the App's tokens go to GitHub alone (github.ts githubMcpUrl, the one check).
  const offGithub = (server: string, url: string, auth: string | undefined) => {
    if (auth === "github_app" && !githubMcpUrl(url, githubMcpOrigin)) throw new McpClaimRefused(`The MCP server ${server} (${url}) can't be used: ${GITHUB_MCP_ONLY}. Nothing was sent.`);
  };
  const stored = await store.mcp.pin(claim.runId);
  if (stored) {
    const pinned = stored.body as McpPin;
    for (const [server, { url, tools }] of Object.entries(pinned)) {
      for (const tool of tools) if (metaToolOf(url, tool.name)) throw new McpClaimRefused(`mcp:${server}/${tool.name} can't be granted: ${META_REASON}`);
      offGithub(server, url, (await store.mcp.server(server))?.auth);
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
        // The registry keeps each tool as its server listed it (input_schema); the pin holds the harnesses' shape.
        return row && { url: row.url, tools: ((row.tools ?? []) as McpTool[]).map(boundTool), ...(row.prices ? { prices: row.prices as Record<string, number> } : {}) };
      },
      headers: () => undefined,
    });
  } catch (error) {
    throw new McpClaimRefused((error as Error).message);
  }
  if (!Object.keys(made).length) return undefined;
  for (const [server, { url }] of Object.entries(made)) offGithub(server, url, rows.get(server)?.auth);
  return (await store.mcp.pinOnce(claim as Claim, made)).body as McpPin;
}

/** The claim still the run's: its epoch unchanged, else Fenced. */
async function confirm(store: Pick<Store, "runs">, claim: Pick<Claim, "runId" | "epoch">): Promise<void> {
  const run = await store.runs.get(claim.runId);
  if (run?.epoch !== claim.epoch) throw new Fenced(claim.runId, claim.epoch);
}

/** How often a claim waiting on another claim's refresh lease reads the server's row again: a holder in another process
 *  (another runner, the server) wakes nothing here, so the row is how its let-go is seen. A refresh call runs up to
 *  MCP_REFRESH_CALL_MS and its lease MCP_REFRESH_LEASE_MS, so a waiter reads the row at most about two dozen times a lease
 *  and sees a holder elsewhere let go within this. A holder in this process wakes it at once. */
export const MCP_SETTLE_POLL_MS = 500;

/** A timer: `fire` after `ms`, unless cleared. For tests, mcpClaim's `timer`. */
export type SettleTimer = (fire: () => void, ms: number) => { clear(): void };
const systemTimer: SettleTimer = (fire, ms) => {
  const handle = setTimeout(fire, ms);
  return { clear: () => clearTimeout(handle) };
};

/** The claims of this process waiting on a server's refresh lease, by the store's `where` (Store.where: two instances
 *  over the same data are one key, two over different data never are) and the server's name: woken when a holder in this
 *  process lets the lease go. */
const waiting = new Map<string, Map<string, Set<() => void>>>();

/** A wait for `name`'s lease to be let go by a holder in this process (settledNow), at most `ms`, or until `stop`. */
function settledOf(where: string, name: string, ms: number, stop: AbortSignal, timer: SettleTimer): { done: Promise<void>; cancel(): void } {
  const servers = waiting.get(where) ?? new Map<string, Set<() => void>>();
  waiting.set(where, servers);
  const waiters = servers.get(name) ?? new Set<() => void>();
  servers.set(name, waiters);
  let wake!: () => void;
  const done = new Promise<void>((resolve) => (wake = resolve));
  const armed = timer(() => finish(), ms);
  const finish = () => {
    armed.clear();
    stop.removeEventListener("abort", finish);
    waiters.delete(finish);
    if (waiters.size === 0 && servers.get(name) === waiters) servers.delete(name);
    if (servers.size === 0 && waiting.get(where) === servers) waiting.delete(where);
    wake();
  };
  waiters.add(finish);
  stop.addEventListener("abort", finish, { once: true });
  return { done, cancel: finish };
}

/** Wakes every claim of this process waiting on `name`'s refresh lease in the store at `where`. */
function settledNow(where: string, name: string): void {
  for (const finish of [...(waiting.get(where)?.get(name) ?? [])]) finish();
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
