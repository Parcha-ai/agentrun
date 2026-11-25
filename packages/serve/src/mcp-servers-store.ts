// The owner's remote MCP servers over the one store (store.mcp, store.mcpOauth): the registry and the sign-ins in flight.
// The probe and request validation are mcp-probe.ts'. The credential is one sealed blob per row (store/seal.ts §7, the
// url's origin bound inside), so a read opens it to show the auth's header names, the OAuth note and whether the sign-in
// expired. The server never starts without its seal key, so every credential is kept sealed under it.
//
// Per the run-time ruling, the runner reads MCP servers, pins and credentials from the store at a run's claim
// (runner/mcp-claim.ts), including the OAuth token refresh. So this server-side registry has NO headers()/headersForRun()
// and does NO token refresh: it is the owner's create/preview/save/refresh(tools)/remove and the OAuth sign-in, and nothing
// a run's launch calls.
import { heldApiOnlyMcpOrigins, offApiOnlyMcpOrigins } from "./mcp-api-only-origins.js";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import {
  type Auth, authOf, canonical, credentialInQuery, credentialInQueryWords, credentialMissing, type HeaderMap, savedOrGiven, shownUrl, type Listed, listServer, marked, MAX_OAUTH_VALUE_BYTES, type McpPrices,
  type McpTool, nameOf, notFound, oauthValueValid, pricesListed, pricesOf, scopesValid, urlOf,
} from "./mcp-probe.js";
import { listMcpServers, openMcpRow, putPendingSignIn, removeMcpServer, removeMcpServerIfCredential, rewriteMcpServer, saveMcpServerIfCredential, takePendingSignIn, type RemovedMcpServer } from "./mcp-store.js";
import { checkPrivateHosts, privateOAuthHosts, savePrivateOAuthHosts } from "./mcp-private-hosts.js";
// MCP's secret writes, registered with the one gate as the registry loads (the server's dispatch reads them).
import { credentialMark, ownersAuthConfig, tokensAccount } from "./mcp-secret-writes.js";
import { ownersComposioUsers, ownersUser } from "./composio-owners.js";
import type { ComposioCredentialOf } from "./composio-triggers.js";
import { type SecretMeta, secretMeta, secretName } from "./secret-writes.js";
import { type ClientKind, dialAt, issuerOf, LOOPBACK, MAX_PENDING, MCP_SETTINGS_PAGE, mcpServerAt, McpSignIns, type OAuthNetwork, type Pending, type PendingStore, reasonOf, SIGN_IN_AGAIN, systemNetwork, type TokenSet } from "./mcp-oauth.js";
import { type Cleanup, cleanupOf, COMPOSIO_KEY_ENV, COMPOSIO_ORIGIN, composioAccountKey, composioEnvKey, composioKeyFromEnv, composioMadeKey, type ComposioMade, composioPerRun, droppedOf, madeToWrite, recordedMade, releasedOf, storedMade } from "./composio-made.js";
import { asking, COMPOSIO_PER_RUN, COMPOSIO_OWNERS_USER_WORDS, COMPOSIO_USER, COMPOSIO_USER_ID, composioAccount, composioAccountBoundWords, type ComposioAccount, type ComposioControl, composioListingAddress, composioListsAccount, composioServerId } from "./composio-preset.js";
import { mcpSourceKey, type RecordedRow, recordedForAnother, savedByToken, sourceOf, type SourceRecord, sourceToWrite, standInGiven, storedSource, toolkitGiven } from "./mcp-sources.js";
import { SEAL_KEY_ENV, sealKeyIn } from "./tool-keys.js";
import { GITHUB_MCP_ONLY, GITHUB_MCP_ORIGIN, githubMcpUrl } from "./github.js";
import { serverGate, type ToolSettingsMap } from "./tool-plane.js";
import { toolEffect } from "./tool-gate.js";
import { HARNESSES } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { droppedWords, mcpGrantNameProblem, mcpToolName } from "./tool-names.js";
import { type McpCredential, type McpCredentialMark, type Mcp, type McpOauth, type McpOwnersMark, type McpServerRow, type Settings, type Store } from "./store/index.js";
import { isObject, unknownFields } from "./validate.js";
import { MCP_ALLOW_LOOPBACK_ENV, restartToAllow } from "./start-switches.js";

/** Stamped on each account row checkAccount writes: the row was read for the server's Composio user alone. A row without
 *  it predates that filter and is never shown. */
const ACCOUNT_READ_FOR = "user";

/** How many writes an owner's save or tools refresh makes over a row whose credential a run's refresh keeps changing,
 *  each re-applied onto the row read again, before it is refused in words. */
const REWRITE_TRIES = 3;
const SCOPE_LIST = "scopes is a list of 1 to 32 OAuth scopes.";
/** The longest an MCP server's address check (its name's lookup) may take before a door answers. */
const ADDRESS_CHECK_MS = 15_000;
const MAX_VALUE_BYTES = MAX_OAUTH_VALUE_BYTES;

/** The store slice this layer reads and writes; `settings` for the private-network OAuth hosts the owner allows and each
 *  server's source and toolkit (mcp-sources.ts). */
type McpServersStore = { readonly mcp: Mcp; readonly mcpOauth: McpOauth; readonly settings: Pick<Settings, "get" | "put" | "remove" | "removeIf">; flush: Store["flush"] };

/** The row a conditional save wrote, or the refusal when it wrote nothing: the server's credential changed while the save
 *  listed its tools (another save, a sign-in or a removal landed), and writing would drop or undo it. */
function changedMeanwhile(name: string, saved: McpServerRow | undefined): McpServerRow {
  if (!saved) throw new ApiError("precondition_failed", `The MCP server ${name}'s credential changed while this save ran (another save, a sign-in or a removal): read it again, then save again.`);
  return saved;
}

/** What a deleted Composio preset server leaves to remove on Composio: the MCP server it made (its id, from the removed
 *  row's own address) and the key it was made with (the removed row's sealed x-api-key, held for the one call), or
 *  `unusable` when either can't be had (a key that does not open here, an address that names no server): the delete of
 *  our row still stands, and the answer says to remove it in Composio by hand. Taken from the row actually removed, never
 *  a row read before it, so a server saved again under the name meanwhile is not the one deleted on Composio. */
//  `cleanup`: what else is to go there, and what stays (composio-made.ts), when the server's save recorded what it stands on.
export type ComposioHandle = ({ id: string; key: string } | { unusable: true }) & { cleanup?: Cleanup };
function composioHandleOf(removed: RemovedMcpServer | undefined, cleanup: Cleanup | undefined, keyEnv: typeof COMPOSIO_KEY_ENV | undefined): ComposioHandle {
  const id = removed ? composioServerId(removed.url) : undefined;
  // A server saved with api_key_env seals no key: its variable's value, as this process was started with it.
  const key = composioKeyOf(removed?.opened) ?? (keyEnv && composioKeyFromEnv(keyEnv));
  return { ...(id && key ? { id, key } : { unusable: true as const }), ...(cleanup ? { cleanup } : {}) };
}
/** The Composio key a preset row's opened credential holds (its x-api-key header); none when it does not open. */
function composioKeyOf(open: RemovedMcpServer["opened"]): string | undefined {
  const headers = open && "credential" in open && open.credential.type === "headers" ? (open.credential.headers as HeaderMap) : undefined;
  return headers ? Object.entries(headers).find(([header]) => header.toLowerCase() === "x-api-key")?.[1] : undefined;
}
/** What a save over a preset server leaves to do at Composio, with the key the server was saved with before, which made
 *  what it left; `unusable` when that key does not open here. `mcp`: the Composio MCP server the row named before, which
 *  the preset made and the row names no longer (a preset save over it makes a new one; an ordinary save moves it off
 *  Composio). `cleanup`: what that save had made there besides that this one no longer stands on (composio-made.ts
 *  droppedOf; all of it, as a delete's cleanupOf, for a row moved off Composio). */
export type ComposioDropped = ({ key: string } | { unusable: true }) & { cleanup: Cleanup; mcp?: string };
/** A preset row's save guard (McpServersOverStore.save): `turn`, the Composio turns its write and cleanup take; `inUse`,
 *  refused while Composio triggers use the server (composio-triggers.ts inUse). */
export type SaveGuard = { turn: <T>(work: () => Promise<T>) => Promise<T>; inUse: () => Promise<void> };

/** The sign-ins in flight over the store (store.mcpOauth): the sign-in's secret parts (the PKCE verifier and the OAuth
 *  client, with its secret) sealed together by its state, the rest of its working state plain JSON the callback rebuilds.
 *  `set` sweeps what has expired and refuses past MAX_PENDING live rows before it writes (what the PendingStore contract
 *  promises), and a start with no verifier is a bug, not a row. `take` deletes and returns in one atomic statement
 *  (store.mcpOauth.take), so a replay or an expired state takes nothing. */
function pendingOverStore(store: McpServersStore, sealKey: Buffer): PendingStore {
  return {
    async set(state, entry) {
      if (!entry.verifier) throw new ApiError("internal", "A sign-in cannot be saved with no PKCE verifier.");
      const now = Date.now();
      await store.mcpOauth.sweepExpired(now);
      if ((await store.mcpOauth.count(now)) >= MAX_PENDING) throw new ApiError("rate_limited", `There are already ${MAX_PENDING} MCP sign-ins in flight; finish or wait one out, then start the sign-in again.`);
      await putPendingSignIn(store, sealKey, {
        state,
        server: entry.name,
        verifier: entry.verifier,
        ...(entry.client ? { client: entry.client } : {}),
        working: { url: entry.url, was: entry.was, ...(entry.scope ? { scope: entry.scope } : {}), kind: entry.kind, ...(entry.discovery ? { discovery: entry.discovery } : {}), ...(entry.resource ? { resource: entry.resource } : {}), ...(entry.source ? { source: entry.source } : {}) },
        expiresAt: entry.expires,
      });
    },
    async take(state) {
      const row = await takePendingSignIn(store, sealKey, state, Date.now());
      if (!row) return undefined;
      const w = (row.working ?? {}) as { url: string; was: string | null; scope?: string; kind: ClientKind; discovery?: unknown; resource?: string; source?: SourceRecord };
      return {
        name: row.server, url: w.url, was: w.was ?? null, ...(w.scope ? { scope: w.scope } : {}), kind: w.kind,
        ...(row.client ? { client: row.client as Pending["client"] } : {}), verifier: row.verifier,
        ...(w.discovery ? { discovery: w.discovery as Pending["discovery"] } : {}), ...(w.resource ? { resource: w.resource } : {}), ...(w.source ? { source: w.source } : {}),
        expires: row.expiresAt,
      };
    },
  };
}

/** The saved credential opened for a run of this server's own reads (preview by name, refresh, save keeping it): its
 *  headers to send, or the refusal that asks for it again. `env`: the headers are a Composio key read from this variable
 *  (a server saved with api_key_env), nothing sealed. */
type Opened = { headers: HeaderMap; credential: McpCredential & { origin: string }; env?: typeof COMPOSIO_KEY_ENV };

export class McpServersOverStore {
  /** The connected GitHub App's installation token for listing a `github_app` server's tools as it is previewed, saved
   *  or refreshed (github-connection.ts tokenForListing); a run's own is minted at its claim (runner/mcp-claim.ts). Set by
   *  the server; absent, such a server's tools can't be listed (github_not_connected). */
  appToken?: (signal?: AbortSignal) => Promise<{ token: string } | { unusable: string } | { failed: string }>;
  /** The one origin a github_app server may have (GITHUB_MCP_ORIGIN; a test's fake through the server's seam): the App's
   *  tokens are minted for, and sent to, nothing else. */
  appOrigin = GITHUB_MCP_ORIGIN;
  /** The one origin a key read from the environment is sent to (COMPOSIO_ORIGIN; a test's fake through the server's
   *  seam): a Composio server saved with api_key_env at any other address is refused (composioEnvKey). */
  composioOrigin = COMPOSIO_ORIGIN;
  /** Where Composio is for a refresh's account check (checkAccount): the real one, or a test's fake through the server's
   *  seam. */
  composioControl: ComposioControl = {};
  private readonly sealKey: Buffer;
  private readonly signIns: McpSignIns;
  /** The callbacks under way, which close() waits out before the server lets its data go. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Each server name's save turn (nameTurn): the last save in it, settled either way. */
  private readonly nameTurns = new Map<string, Promise<unknown>>();
  private readonly stopped = new AbortController();
  /** Whether this server is a local install (attach): only then may an MCP server's URL be on loopback. */
  private loopback = false;
  /** Whether this is a template eval's own scratch server (ServeOptions.mcpStandIns): only there is a save's `source`
   *  taken, for a fake the eval made to stand in for a package's need. Every other server records what made it. */
  standIns = false;

  constructor(private readonly store: McpServersStore, private readonly env: NodeJS.ProcessEnv, private readonly version: string, private readonly network: OAuthNetwork = systemNetwork) {
    // The server never starts without a seal key (seal-key.ts bootSealKey), so there is no keyless registry: every
    // credential is kept sealed under it.
    const sealKey = sealKeyIn(env[SEAL_KEY_ENV], "MCP servers' credentials");
    this.sealKey = sealKey;
    this.signIns = new McpSignIns(network, pendingOverStore(store, sealKey), () => privateOAuthHosts(store));
  }

  /** This server's address as a browser reaches it and where it listens (McpServers.attach). `local`: whether its
   *  operator said this is a local install (ServeOptions.mcpLoopback, the CLI's AGENTRUN_MCP_ALLOW_LOOPBACK=1), the one kind
   *  of server an MCP server's URL may be on loopback for. Never inferred from where it listens: a hosted container
   *  listens on loopback behind its proxy too. Omitted, or never attached, it is not one. `beside`: a runner's registry
   *  (registryListing), attached at no address of its own, is held to the own addresses of the server beside it. */
  attach(base: string, listening: string, local?: boolean, beside: readonly string[] = []): void {
    this.signIns.base = base.replace(/\/+$/, "");
    this.signIns.listening = listening.replace(/\/+$/, "");
    this.signIns.beside = [...beside];
    this.loopback = local === true;
    this.signIns.loopback = this.loopback;
  }

  /** This server's own addresses (McpSignIns.own): where it listens, and its public address when that is on loopback. A
   *  read on loopback, here or by the runner beside it (Serve.own), never goes to their ports. */
  get own(): readonly string[] {
    return this.signIns.own;
  }

  clientDocument() {
    return this.signIns.clientDocument();
  }

  /** The origin the authorization server sends the browser back to. */
  get callbackOrigin(): string {
    return new URL(this.signIns.base).origin;
  }

  /** Where a server-side read of a URL may go (a feed's, a calendar's), as an MCP server's requests may: this server's
   *  network, its own addresses (never read), the private-network hosts the owner allows (read now, at each call), loopback
   *  only on a local install, and stopped with the server. */
  async outboundReach(): Promise<{ network: OAuthNetwork; reach: { own: readonly string[]; allowed: readonly string[]; loopback: boolean }; signal: AbortSignal }> {
    return { network: this.network, reach: { own: this.signIns.own, allowed: await privateOAuthHosts(this.store), loopback: this.loopback }, signal: this.stopped.signal };
  }

  /** The server's own tool settings, set as the server starts. */
  toolSettings: () => ToolSettingsMap = () => ({});

  async close(boundMs = 2_000): Promise<void> {
    this.stopped.abort();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((done) => setTimeout(done, boundMs).unref())]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
    return work;
  }

  /** GET .../oauth/private-hosts: the private-network hosts an authorization server may be on (none by default). */
  async privateHosts(): Promise<{ hosts: string[] }> {
    return { hosts: await privateOAuthHosts(this.store) };
  }

  /** PUT .../oauth/private-hosts: the list replaced in store.settings, durable before it answers; or 422 in words. */
  async setPrivateHosts(body: Record<string, unknown>): Promise<{ hosts: string[] }> {
    const hosts = checkPrivateHosts(body);
    await savePrivateOAuthHosts(this.store, hosts);
    await this.store.flush();
    return { hosts };
  }

  async list() {
    const rows = await listMcpServers(this.store);
    return { servers: await Promise.all(rows.slice().sort((a, b) => a.name.localeCompare(b.name)).map((row) => this.view(row))) };
  }

  async get(name: string) {
    return this.view(await this.need(name));
  }

  /** POST preview: `{url, auth}`, or `{name}` for a saved server with its sealed credential. Stores nothing. `byToken`:
   *  the API token's, as a save's is (givenUrl). */
  async preview(body: Record<string, unknown>, stop?: AbortSignal, byToken = false): Promise<Listed> {
    if (body.name !== undefined && body.url === undefined) {
      const issues = unknownFields(body, ["name"]);
      if (issues.length) throw invalid(issues);
      const name = String(body.name);
      const kept = await this.need(name);
      const url = new URL(kept.url);
      const send = await this.reached(kept.auth, url, stop);
      return marked(kept.url, await this.signInNoted(url, this.listServer(url, await this.withAppToken(kept.auth, url, (await this.opened(name, kept, "name")).headers, stop), send, stop, await this.perRunComposio(name, kept)), stop));
    }
    // `name` with a url: the saved server the form is editing. Its address as every read shows it (shownUrl), sent back
    // unchanged, is the saved one here too (as save and sign-in map it): the browser never gets the real address back.
    // Not over a server the token saved, for anyone but the token (givenUrl): its whole address is given.
    const { name: editing, ...asked } = body;
    const saved = editing === undefined ? undefined : await this.store.mcp.server(String(editing));
    const { url, auth } = this.admit({ ...asked, ...(asked.url !== undefined ? { url: await this.givenUrl(asked.url, saved, byToken) } : {}) });
    // A github_app server's credential is a token of the App, minted here, as for a saved one: its static headers are optional.
    // A per_run server's are optional too: they only list its tools, for a server that lists them only to a caller it knows.
    if (auth.type !== "none" && auth.type !== "github_app" && auth.type !== "per_run" && !auth.headers) throw invalid([credentialMissing(auth.type, "A preview needs the credential it is to connect with.")]);
    const send = await this.reached(auth.type, url, stop);
    // The edit form of a per-run Composio server at its saved address lists it as a preview by name does.
    const perRun = !!saved && auth.type === "headers" && saved.url === url.href && (await this.perRunComposio(String(editing), saved));
    return marked(url.href, await this.signInNoted(url, this.listServer(url, await this.withAppToken(auth.type, url, auth.headers ?? {}, stop), send, stop, perRun), stop));
  }

  /** What an agent's save pins of the saved server `name` (mcp-gateway.ts mcpPinOf): its URL, its tools as it lists them
   *  now (listed once, with its saved credential, as a preview by name lists them; nothing stored), each marked grantable
   *  or not (mcp-meta.ts), and its owner's prices for those still listed. Undefined when no server of that name is saved.
   *  A server whose credential is not this server's to send (per_run, each run hands its own) or whose access token only a
   *  run refreshes (oauth) and that refuses the listing for its credential is pinned as its owner's last save or refresh
   *  listed it, with the credential it had then. Any other failure is the ApiError the listing threw, in its words. */
  async pinListing(name: string, stop?: AbortSignal): Promise<{ url: string; tools: (McpTool & { grantable?: false; reason?: string })[]; prices: McpPrices; toolkit: string | null } | undefined> {
    const row = await this.store.mcp.server(name);
    if (!row) return undefined;
    // A per_run server the API token saved at an origin no longer on the API-only list: refused before it is listed.
    const off = await offApiOnlyMcpOrigins(this.store, name, row);
    if (off) throw new ApiError("agent_not_runnable", off);
    const { toolkit } = await this.sourceOf(row);
    const url = new URL(row.url);
    const pinned = (tools: McpTool[]) => {
      const listed = marked(row.url, { tools });
      return { url: row.url, tools: listed.tools, prices: pricesListed((row.prices ?? undefined) as McpPrices | undefined, listed.tools), toolkit };
    };
    const send = await this.reached(row.auth, url, stop);
    try {
      return pinned((await this.listServer(url, await this.withAppToken(row.auth, url, (await this.opened(name, row, "name")).headers, stop), send, stop, await this.perRunComposio(name, row))).tools);
    } catch (error) {
      if ((row.auth === "per_run" || row.auth === "oauth") && error instanceof ApiError && error.code === "auth_required") return pinned((row.tools as McpTool[]) ?? []);
      throw error;
    }
  }

  /** `listing`, and when it is refused as a server that signs in with OAuth (auth_required, `auth: oauth`), whether that
   *  sign-in can start with no Client ID entered (`details.oauth.registration`, McpSignIns.registration), so the console
   *  asks for one up front. `stop`: the preview's, which cuts that discovery too. */
  private async signInNoted(url: URL, listing: Promise<Listed>, stop?: AbortSignal): Promise<Listed> {
    try {
      return await listing;
    } catch (error) {
      const details = error instanceof ApiError && error.code === "auth_required" ? (error.extra.details as { auth?: string; oauth?: unknown } | undefined) : undefined;
      if (details?.auth === "oauth") {
        const registration = await this.signIns.registration(url, stop);
        if (registration) details.oauth = registration;
      }
      throw error;
    }
  }

  /** PUT: preview, then keep the server with the tools listed. A body with no credential keeps the sealed one, while the
   *  auth type and the URL's origin stay the same. `made`: what made the server, when that is the Composio preset (its
   *  source and toolkit, recorded as they are), and `stands`, what it stands on at Composio (composio-made.ts), recorded
   *  for its delete. `dropped` is told what a save over a preset server leaves to do there, once the row is written: the
   *  MCP server the save before made, when the row names it no longer, and what else that save made that this one no
   *  longer stands on (all of it, for an ordinary save that moves the row off Composio, as a delete), which another saved
   *  server's record now owns or the caller removes. `guard`, a preset row's: the turn its write and cleanup take, once
   *  the listing is done (never across it), and the check of the triggers that use it, made in that turn before a write
   *  that leaves what they stand on (an ordinary save moving the row off Composio, a preset save as another user or auth
   *  config): refused, nothing written. `byToken`: the API token makes the save (a request the secret-write gate read), so
   *  a row it makes is recorded as the token's (mcp-sources.ts savedByToken), and it writes over a saved row only while
   *  that row still carries the token's mark, compared in the row's own statement (412, nothing written, when an owner's
   *  save took it meanwhile). */
  async save(name: string, body: Record<string, unknown>, stop?: AbortSignal, checkedAgainst?: McpCredentialMark, made?: SourceRecord, stands?: ComposioMade, dropped?: (left: ComposioDropped) => void, guard?: SaveGuard, byToken = false) {
    nameOf(name);
    const was = await this.store.mcp.server(name);
    // Its URL as every read shows it (shownUrl), sent back unchanged: the saved one; over a server the token saved, only
    // in the token's own save (givenUrl).
    const { url, auth, prices, toolkit, standIn } = this.admit({ ...body, ...(body.url !== undefined ? { url: await this.givenUrl(body.url, was, byToken) } : {}) }, true);
    // What the server is (its source and toolkit, mcp-sources.ts): from what made it and the owner's toolkit, over what it
    // is now, checked before anything is listed; written once the server is, for the row it wrote.
    const sourceIssues: InputIssue[] = [];
    const wasSource = await this.sourceOf({ name, auth: auth.type, createdAt: was?.createdAt });
    // Whether the row was a Composio preset server (auth headers, source composio), read before this save writes its own;
    // and the variable its key was read from, when it was saved with api_key_env.
    const wasPreset = was !== undefined && was.auth === "headers" && (await this.sourceOf(was)).source === "composio";
    const wasKeyEnv = wasPreset ? await this.keyEnvOf(was!) : undefined;
    // An ordinary save that moves a Composio preset row to another address makes it another service's server: it stops being
    // Composio's, whatever its path looks like, so its delete never sends the key it holds to Composio. It is url's, with the
    // toolkit the same save names, else none.
    const moved = !made && !standIn && was !== undefined && wasSource.source === "composio" && was.url !== url.href;
    const written = sourceToWrite(made ?? standIn, toolkit, moved ? { source: "url", toolkit: null } : wasSource, auth.type, sourceIssues);
    const source = moved ? (written ?? { source: "url" as const, toolkit: null }) : written;
    if (sourceIssues.length) throw invalid(sourceIssues);
    const send = await this.reached(auth.type, url, stop);
    // The credential this save may write over: the one the secret-write gate let it through against (`checkedAgainst`,
    // its credentialMark), else the one read here. The write compares it in its own statement, after the listing's wait.
    const against = checkedAgainst !== undefined ? checkedAgainst : credentialMark(was);
    let credential: McpCredential | undefined;
    // A credential kept (no new one sent): the row's sealed value as read, never sealed again nor written; the save rewrites
    // the rest of the row by a compare-and-set on it (rewriteKeeping), so a run's refreshed set kept meanwhile stands. A new
    // one is the owner's, written over whatever is there.
    let keeping = false;
    let headers = auth.headers;
    if (auth.type === "github_app") {
      // Its own headers are only its static ones (its token is minted): new ones are kept; none sent keeps the saved ones,
      // at the same origin only, as any saved credential.
      if (headers) credential = { type: "headers", headers };
      else if (was?.auth === "github_app" && was.sealed !== null) {
        if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the headers again, so saved ones never go to another origin.`)]);
        const open = await this.opened(name, was, "auth.headers");
        headers = open.headers;
        keeping = true;
      }
    } else if (auth.type === "per_run") {
      // Keeps no credential: the headers sent, if any, only list its tools now. Each run hands its own (mcp_auth).
    } else if (auth.type !== "none" && !headers) {
      if (!was || was.auth !== auth.type) throw invalid([credentialMissing(auth.type, `The server ${name} has no saved ${auth.type} credential to keep.`)]);
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the credential again, so a saved one never goes to another origin.`)]);
      const open = await this.opened(name, was, credentialMissing(auth.type, "").field);
      headers = open.headers;
      // A key read from the environment is no sealed one to keep: the row is written sealing none again.
      keeping = !open.env;
    } else if (auth.type !== "none" && !stands?.key_env) {
      // A Composio key read from the environment (`stands.key_env`) only lists the tools now: the row seals none.
      credential = { type: "headers", headers: headers! };
    } else if (stands?.key_env) {
      // ...and only at Composio's origin: an address Composio answered elsewhere is refused, and the key is not sent there.
      const got = composioEnvKey(name, url.href, stands.key_env, this.composioOrigin);
      if ("refused" in got) throw invalid([{ field: "url", reason: got.reason, message: got.refused }]);
    }
    // The token keeps no sealed credential: the secret-write gate lets its save over no sealed row (mcp-secret-writes.ts
    // tokenWriteOverRefused), so one read here is an owner's, saved since. Refused as changed meanwhile, nothing written.
    if (byToken && keeping) changedMeanwhile(name, undefined);
    // The API-only token's ordinary save (no `made`, on a store that holds the API-only list): its gate let it over no row
    // but one the token saved (mcp-secret-writes.ts tokenWriteOverRefused), so a row read here that the token did not save
    // is one written since. Checked in the write below, on the row this save read.
    const held = byToken && made === undefined && (await heldApiOnlyMcpOrigins(this.store)) !== undefined;
    // A per-run Composio server, made so now (`stands`) or saved so and kept at its address by an ordinary save.
    const perRun = Boolean(stands?.per_run) || (!made && was !== undefined && auth.type === "headers" && was.url === url.href && (await this.perRunComposio(name, was)));
    const listed = await this.listServer(url, await this.withAppToken(auth.type, url, headers ?? {}, stop), send, stop, perRun);
    // The Composio preset prices each action it granted (its price_usd): one its server doesn't list goes unpriced, as the
    // preset's answer names it (not_served), never a refusal. An owner's prices name only tools the server lists.
    const asked = made && prices ? pricesListed(prices, listed.tools) : prices;
    const unlisted = Object.keys(asked ?? {}).filter((tool) => !listed.tools.some((listedTool) => listedTool.name === tool));
    if (unlisted.length) throw invalid(unlisted.map((tool) => ({ field: `prices.${tool}`, reason: "not_an_option", message: `The server ${name} lists no tool ${tool}; its tools are ${listed.tools.map((t) => t.name).join(", ") || "none"}.` })));
    // The row as saved over `row` (the one read, or read again): a body with no `prices` keeps the saved ones, for the tools
    // still listed at the same address; a preset save over a preset row keeps them at the new address its Composio server
    // has (each preset save makes one), so a re-save never leaves a priced action unmetered.
    const fields = (row: McpServerRow | undefined) => {
      const priced = asked ?? (row && (row.url === url.href || (made && wasPreset)) ? pricesListed((row.prices ?? undefined) as McpPrices | undefined, listed.tools) : undefined);
      return {
        name, url: url.href, auth: auth.type, protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
        ...(priced && Object.keys(priced).length ? { prices: priced } : {}),
      };
    };
    // From here, in the guard's turn (a preset row's): what it stood on read, the triggers checked, the row written, and
    // what it leaves at Composio counted.
    const write = async () => {
      if (guard && wasPreset) {
        const stood = recordedMade(await this.store.settings.get(composioMadeKey(name)), was!.createdAt);
        if (moved || (made && stands && (!stood || stood.user !== stands.user || Boolean(stood.per_run) !== Boolean(stands.per_run) || (stood.auth_config?.id ?? null) !== (stands.auth_config?.id ?? null)))) await guard.inUse();
      }
      // Who saved the row (mcp-sources.ts `by`): the token marks a row it makes, and keeps the mark on its own; the owner's
      // row stays the owner's under the token's save. The owner's save over a saved row drops the token's mark in the
      // store's transaction that writes the row, once it is written (`owns`, McpOwnersMark): a save refused (412) leaves
      // the row and its record as they were, so the server stays the token's; one that lands is the owner's with no
      // moment between its row and its record, so the token's write or delete, which compares the mark in its own
      // statement, never takes the row the owner saved.
      const recorded = was ? await this.store.settings.get(mcpSourceKey(name)) : undefined;
      const wasToken = was !== undefined && savedByToken(recorded, was.createdAt);
      const mark = byToken && (was === undefined || wasToken);
      // The API-only token's save lands only on a row it saved, or none: one another wrote is refused, unwritten, even
      // when the token's own row holds the name by the write (the store's statement compares only that row's mark).
      if (held && !mark) changedMeanwhile(name, undefined);
      const owns = !byToken && was !== undefined ? { record: mcpSourceKey(name) } : undefined;
      // The token's first save of the name writes the row's record, marked, in the transaction that writes the row (`made`,
      // McpTokensMark): an owner's read never finds the token's new row unmarked, so never takes its address for the owner's.
      const recordOf = (row: { createdAt: number }) => (source ? storedSource(source, row, !made && source === standIn, mark) : storedSource({ source: "url", toolkit: null }, row, false, true));
      const first = byToken && was === undefined;
      const saved = keeping
        // Re-applied only onto a row that still holds a credential of this auth type, at the address this save read: never
        // onto another one's, nor over a row another save moved meanwhile (a Composio save over it, whose cleanup removed the
        // MCP server at the address read; Composio's share an origin). It writes no credential column, so it never drops or
        // replaces one.
        ? await this.rewriteKeeping(name, was!, fields, "save", (fresh) => fresh.auth === auth.type && fresh.sealed !== null && fresh.url === was!.url, owns)
        // A new credential, or none: written only while the row's credential is still `against`, and the token's over a
        // saved row only while that row still carries its mark (savedByToken), both in the store's one statement: the
        // check and the write are one step, so an owner's save that lands after the gate's read is never written over.
        : changedMeanwhile(name, await saveMcpServerIfCredential(this.store, this.sealKey, { ...fields(was), ...(credential ? { credential } : {}) }, against, { githubMcpOrigin: this.appOrigin, ...(byToken ? { tokens: { record: mcpSourceKey(name), ...(first ? { made: recordOf } : {}) } } : {}), ...(owns ? { owns } : {}) }));
      // A save over a saved row that names its source records it after the row (the first save's went with its row): the
      // record is marked only when the token saves over a row it saved (mark is wasToken here).
      if (!first && source) await this.store.settings.put(mcpSourceKey(name), recordOf(saved));
      // The Composio MCP server the row named before, when the preset made it (the row was a preset server) and the row names
      // it no longer: a preset save over it made a new one, or an ordinary save moved the row off Composio.
      const madeBefore = wasPreset && (made || moved) ? composioServerId(was!.url) : undefined;
      const leftMcp = madeBefore !== undefined && madeBefore !== composioServerId(url.href) ? madeBefore : undefined;
      let left: Cleanup | undefined;
      // What it stands on at Composio: what the preset found and made, over what the server saved before over this row had
      // made. A row moved off Composio stands on nothing there: its delete removes nothing at Composio.
      if (made && stands) {
        // An auth config the owner named (auth_config_id) is theirs from this save on: every other saved server's claim to
        // have made it is let go first, so neither this record nor theirs, nor what they hand on, ever removes it. One the
        // token names it only uses: its naming lets go no other server's claim (an owner's server that made it still
        // removes it at its delete, or hands it on as any shared one), and its own record says it made none.
        const listed = (await this.composioRecords()).filter(([other]) => other !== name);
        const released = stands.auth_config?.named && !byToken ? releasedOf(stands.auth_config.id, listed) : [];
        await this.handOver(listed, released);
        const others = listed.map(([other, record, at]): [string, ComposioMade, number] => [other, released.find(([one]) => one === other)?.[1] ?? record, at]);
        const before = was ? recordedMade(await this.store.settings.get(composioMadeKey(name)), was.createdAt) : undefined;
        const record = madeToWrite(stands, before, others.map(([, other]) => other));
        await this.store.settings.put(composioMadeKey(name), storedMade(record, saved));
        // What the save before made that this one no longer stands on: another saved server's now (its record rewritten to
        // own it), or the caller's to remove at Composio, with the key it was made with.
        if (was && before) {
          const done = droppedOf(before, record, others.map(([other, mine]): [string, ComposioMade] => [other, mine]));
          await this.handOver(others, done.handover);
          left = done.cleanup;
        }
      } else if (moved) {
        // Moved off Composio: what its save made there goes as a delete's does (cleanupOf), the MCP server first, unless the
        // new address names the same Composio MCP server, which still stands on it.
        const before = recordedMade(await this.store.settings.get(composioMadeKey(name)), was!.createdAt);
        await this.store.settings.remove(composioMadeKey(name));
        // Only for a caller in the Composio turn (`dropped`, with its `guard`), so no preset save still at Composio is counted out.
        if (before && leftMcp && dropped) {
          const others = (await this.composioRecords()).filter(([other]) => other !== name);
          const done = cleanupOf(before, others.map(([other, record]): [string, ComposioMade] => [other, record]));
          await this.handOver(others, done.handover);
          left = done.cleanup;
        }
      }
      if (was && (leftMcp || left?.remove.length || left?.kept.length)) {
        let key: string | undefined;
        try {
          key = composioKeyOf(openMcpRow(this.sealKey, was));
        } catch {
          key = undefined;
        }
        key ??= wasKeyEnv && composioKeyFromEnv(wasKeyEnv);
        dropped?.({ ...(key ? { key } : { unusable: true as const }), cleanup: left ?? { remove: [], kept: [] }, ...(leftMcp ? { mcp: leftMcp } : {}) });
      }
      return saved;
    };
    // The name's turn (nameTurn) inside the guard's: the row and its record are written with no other save of the name between.
    const saved = guard ? await guard.turn(() => this.nameTurn(name, write)) : await this.nameTurn(name, write);
    await this.store.flush();
    return this.view(saved);
  }

  /** `work` in the turn of the saved server `name`, after every save of that name already in it: a save over a saved row
   *  writes the row and then its source record (mcp-sources.ts), so a token's mark it keeps never lands on a row an owner's
   *  save wrote between the two. The token's first save of the name writes its row and marked record in one transaction
   *  (McpTokensMark made), with no moment between them. One server holds a store (StoreOwned), so the turn is this
   *  process's. A delete takes none: its statement compares the mark itself (Mcp.removeIfCredential), and it drops a
   *  record only while it is the one it read (Settings.removeIf). */
  private async nameTurn<T>(name: string, work: () => Promise<T>): Promise<T> {
    const mine = (this.nameTurns.get(name) ?? Promise.resolve()).then(work);
    const held = mine.then(() => undefined, () => undefined);
    this.nameTurns.set(name, held);
    try {
      return await mine;
    } finally {
      if (this.nameTurns.get(name) === held) this.nameTurns.delete(name);
    }
  }

  /** POST refresh: list the saved server's tools again, keep them, and say what was added, removed and changed. A
   *  Composio server's account is read again at Composio too (checkAccount). */
  async refresh(name: string, stop?: AbortSignal) {
    const was = await this.need(name);
    const send = await this.reached(was.auth, new URL(was.url), stop);
    const open = await this.opened(name, was, "name");
    const listed = await this.listServer(new URL(was.url), await this.withAppToken(was.auth, new URL(was.url), open.headers, stop), send, stop, await this.perRunComposio(name, was));
    const before = new Map((was.tools as McpTool[]).map((tool) => [tool.name, canonical(tool)]));
    const after = new Map(listed.tools.map((tool) => [tool.name, canonical(tool)]));
    // A refresh re-lists the tools and leaves the credential as it is (rewriteKeeping: a run's refreshed set kept meanwhile
    // stands); it keeps updated_at (not an owner edit) and lets listed_at move to now. Re-applied only onto the same address
    // and auth type it listed.
    const saved = await this.rewriteKeeping(name, was, (row) => {
      const prices = pricesListed((row.prices ?? undefined) as McpPrices | undefined, listed.tools);
      return {
        name, url: row.url, auth: row.auth, protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
        ...(Object.keys(prices).length ? { prices } : {}), updatedAt: row.updatedAt,
      };
    }, "refresh", (fresh) => fresh.url === was.url && fresh.auth === was.auth);
    await this.checkAccount(saved, stop);
    await this.store.flush();
    return {
      added: [...after.keys()].filter((tool) => !before.has(tool)),
      removed: [...before.keys()].filter((tool) => !after.has(tool)),
      changed: [...after.keys()].filter((tool) => before.has(tool) && before.get(tool) !== after.get(tool)),
      server: await this.view(saved),
    };
  }

  /** A Composio preset server's account read at Composio and kept (composioAccountKey) for every read of the server to
   *  say: connected or not, and each connected account's label. Only a server whose save recorded its user and auth config
   *  (composio-made.ts): one per-run (each run names its own account), of a toolkit with no sign-in (no auth config), or
   *  saved before that was recorded has none. A failure keeps `unknown`, and the refresh goes on: its tools are listed. */
  private async checkAccount(row: McpServerRow, stop?: AbortSignal): Promise<void> {
    if (row.auth !== "headers") return;
    const { source, toolkit } = await this.sourceOf(row);
    const made = recordedMade(await this.store.settings.get(composioMadeKey(row.name)), row.createdAt);
    if (source !== "composio" || !toolkit || !made?.auth_config || made.per_run) return;
    const of = { user: made.user, toolkit, auth_config: made.auth_config.id };
    let account: ComposioAccount;
    try {
      const key = Object.entries((await this.opened(row.name, row, "api_key")).headers).find(([header]) => header.toLowerCase() === "x-api-key")?.[1];
      account = key ? await composioAccount(asking(this.composioControl, key, stop, "its account was not checked"), of) : { state: "unknown" };
    } catch {
      account = { state: "unknown" };
    }
    await this.store.settings.put(composioAccountKey(row.name), { of: row.createdAt, ...of, ...account, read_for: ACCOUNT_READ_FOR, checked_at: new Date().toISOString() });
  }

  /** The account a refresh last read for `row` (checkAccount, its only writer), while it was read for what the server
   *  stands on now (`made`, its save's record, and its toolkit) and for the server's user alone (ACCOUNT_READ_FOR); none
   *  otherwise, so a row kept by 0.1.0-beta.57 or beta.58, which took any ACTIVE account under the auth config, says
   *  nothing until the next refresh. */
  private async accountOf(row: McpServerRow, toolkit: string | null, made: ComposioMade | undefined): Promise<(ComposioAccount & { checked_at: string }) | undefined> {
    if (!toolkit || !made?.auth_config || made.per_run) return undefined;
    const kept = await this.store.settings.get(composioAccountKey(row.name));
    if (!isObject(kept) || kept.read_for !== ACCOUNT_READ_FOR || kept.of !== row.createdAt || kept.toolkit !== toolkit || kept.user !== made.user || kept.auth_config !== made.auth_config.id) return undefined;
    const { state, labels, checked_at } = kept as ComposioAccount & { checked_at: string };
    return { state, ...(labels?.length ? { labels } : {}), checked_at };
  }

  /** Writes a change over the row it read (`was`), its credential left as it is, by a compare-and-set on that row's
   *  credential, address, auth type and last edit (store.mcp.rewrite), so a save made since is never written back over,
   *  even one that kept the address and auth type (a repricing). A lost one (a run kept a refreshed set meanwhile, or a
   *  save landed) reads the row again and re-applies the change onto it, while `still` holds of it, at most REWRITE_TRIES
   *  writes; then it is refused in words, nothing written. A refresh re-applied so takes the fresh row's prices. */
  private async rewriteKeeping(name: string, was: McpServerRow, fields: (row: McpServerRow) => Parameters<typeof rewriteMcpServer>[1], doing: "save" | "refresh", still: (row: McpServerRow) => boolean, owns?: McpOwnersMark): Promise<McpServerRow> {
    let row = was;
    for (let tries = 1; ; tries++) {
      const saved = await rewriteMcpServer(this.store, fields(row), { sealed: row.sealed, url: row.url, auth: row.auth, updatedAt: row.updatedAt }, { githubMcpOrigin: this.appOrigin, ...(owns ? { owns } : {}) });
      if (saved) return saved;
      const fresh = await this.store.mcp.server(name);
      if (!fresh) throw notFound(name);
      // A save over a row changed meanwhile is the owner's to redo, read again: never retried as it stands.
      if (!still(fresh) && doing === "save") changedMeanwhile(name, undefined);
      if (!still(fresh)) throw new ApiError("unavailable", `The MCP server ${name} was changed while this ${doing} was made; nothing was saved. Read it again and try again.`);
      if (tries >= REWRITE_TRIES) throw new ApiError("unavailable", `The MCP server ${name}'s credential kept changing while this ${doing} was made (a run refreshing its token); nothing was saved. Try again.`);
      row = fresh;
    }
  }

  /** DELETE. `checkedAgainst`: the credential the secret-write gate let a token's removal through against (one with
   *  none: removing it drops no secret); the row goes only while it is still that, in the store's one statement, so a
   *  credential saved meanwhile is never dropped by it. An OAuth one's sign-in is then let go at its authorization server
   *  (its refresh token revoked, RFC 7009, where its metadata names a revocation_endpoint), behind the answer: best effort,
   *  never holding or failing the removal. A claimed run sees the removal at its next call (runner/mcp-claim.ts check).
   *  `byToken`: the API token removes it, which it may only while the row is one the token saved (savedByToken): its
   *  credential and its mark are compared in the deleting statement itself (Mcp.removeIfCredential), never in a read
   *  before it, so an owner's save that lands after the gate's check (it drops the mark in the transaction that writes
   *  its row) is never removed, and nothing is sent to Composio for it. */
  async remove(name: string, checkedAgainst?: McpCredentialMark, byToken = false): Promise<{ composio?: ComposioHandle }> {
    const row = await this.need(name);
    // The credential the row goes against: the gate's, else (a token's removal the gate did not read) the one read here.
    const expected = checkedAgainst !== undefined ? checkedAgainst : byToken ? credentialMark(row) : undefined;
    // Whether it is a Composio preset server: from its record (source composio), read before the row goes.
    const preset = row.auth === "headers" && (await this.sourceOf(row)).source === "composio";
    // What it stands on at Composio, as its save recorded it (none: saved before that was recorded, or not a preset).
    const stands = preset ? recordedMade(await this.store.settings.get(composioMadeKey(name)), row.createdAt) : undefined;
    // The credential revoked is the one the deleting statement saw (RETURNING): a run's refresh landing before it is in it,
    // one landing after finds no row to keep. A sign-in kept as expired has no refresh token left to revoke.
    const removed = expected === undefined ? await removeMcpServer(this.store, this.sealKey, name)
      : expected === null ? undefined : await removeMcpServerIfCredential(this.store, this.sealKey, name, expected, byToken ? { record: mcpSourceKey(name) } : undefined);
    if (expected !== undefined && !removed) changedMeanwhile(name, undefined);
    // Its records go with it, each only while it is still the one read here, compared in the deleting statement
    // (Settings.removeIf): one a server saved again under the name wrote meanwhile stays (the token's first save writes its
    // marked record with its row, so the row it saved never reads as the owner's). One left behind is never read for
    // another row (mcp-sources.ts), so a server saved again says what it is afresh.
    const drop = async (key: string) => {
      const recorded = await this.store.settings.get(key);
      if (recorded !== undefined && !recordedForAnother(recorded, row.createdAt)) await this.store.settings.removeIf(key, recorded);
    };
    await drop(mcpSourceKey(name));
    await drop(composioAccountKey(name));
    // What it made at Composio that another saved server uses stays, that one's now (its record rewritten to own it); the
    // rest the delete route removes there.
    let cleanup: Cleanup | undefined;
    if (stands) {
      await drop(composioMadeKey(name));
      const others = (await this.composioRecords()).filter(([other]) => other !== name);
      const done = cleanupOf(stands, others.map(([other, record]): [string, ComposioMade] => [other, record]));
      await this.handOver(others, done.handover);
      cleanup = done.cleanup;
    }
    await this.store.flush();
    const open = removed?.opened;
    const credential = open && "credential" in open && open.credential.type === "oauth" && !(open.credential as { expired?: true }).expired ? open.credential : undefined;
    if (credential && removed) void this.track(this.signIns.revoke(credential.set as TokenSet, removed.url, this.stopped.signal));
    return preset ? { composio: composioHandleOf(removed, cleanup, stands?.key_env) } : {};
  }

  /** Whether `name` is a Composio preset server now (auth headers, source composio): a save of it takes the Composio turn,
   *  since one that moves it off Composio removes there what the preset made for it. */
  async composioPreset(name: string): Promise<boolean> {
    const row = await this.store.mcp.server(name);
    return row !== undefined && row.auth === "headers" && (await this.sourceOf(row)).source === "composio";
  }

  /** Writes each record a cleanup passes a thing to (composio-made.ts `handover`), for its own row of `others`. */
  private async handOver(others: readonly [string, ComposioMade, number][], handover: readonly [string, ComposioMade][]): Promise<void> {
    for (const [other, record] of handover) {
      const of = others.find(([n]) => n === other)?.[2];
      if (of !== undefined) await this.store.settings.put(composioMadeKey(other), storedMade(record, { createdAt: of }));
    }
  }

  /** The saved servers' records of what they stand on at Composio (composio-made.ts), each read for its own row: name,
   *  record and the row's created_at. */
  private async composioRecords(): Promise<[string, ComposioMade, number][]> {
    const rows = await listMcpServers(this.store);
    const read = await Promise.all(rows.map(async (row) => [row.name, recordedMade(await this.store.settings.get(composioMadeKey(row.name)), row.createdAt), row.createdAt] as const));
    return read.filter((entry): entry is readonly [string, ComposioMade, number] => entry[1] !== undefined).map(([name, record, at]) => [name, record, at]);
  }

  /** POST .../{name}/oauth/start: `{url, scopes?, client_id?, client_secret?, toolkit?}`; answers the URL the owner opens.
   *  Its toolkit, as a save's, is written for the server the sign-in saves. */
  async oauthStart(name: string, body: Record<string, unknown>): Promise<{ authorization_url: string }> {
    nameOf(name);
    const issues = unknownFields(body, ["url", "scopes", "client_id", "client_secret", "toolkit"]);
    const current = await this.store.mcp.server(name);
    // Its URL as every read shows it (shownUrl), sent back unchanged: the saved one, but over a server the token saved,
    // whose address the token chose (givenUrl): the owner's sign-in names it whole.
    const url = urlOf(await this.givenUrl(body.url, current), issues);
    const { scopes, client_id, client_secret } = body;
    if (scopes !== undefined && !scopesValid(scopes)) issues.push({ field: "scopes", reason: "invalid", message: SCOPE_LIST });
    for (const [field, text] of [["client_id", client_id], ["client_secret", client_secret]] as const)
      if (text !== undefined && !oauthValueValid(text)) issues.push({ field, reason: "invalid", message: `${field} is text, at most ${MAX_VALUE_BYTES} bytes.` });
    if (client_secret !== undefined && client_id === undefined) issues.push({ field: "client_id", reason: "missing", message: "A client_secret goes with the client_id it is the secret of." });
    const source = sourceToWrite(undefined, toolkitGiven(body, issues), await this.sourceOf({ name, auth: "oauth", createdAt: current?.createdAt }), "oauth", issues);
    if (issues.length) throw invalid(issues);
    // The MCP server's own address first: its sign-in's discovery is sent there.
    await this.reached("oauth", url!);
    const was = await this.store.mcp.server(name);
    // A body with no client_id signs in again with the client kept in the sealed token set, for the same origin only.
    const kept = typeof client_id !== "string" && was?.auth === "oauth" && new URL(was.url).origin === url!.origin ? this.openedSet(was) : undefined;
    // The kept client goes with the authorization server it was registered at (keptFor): another one gets a new client.
    const keptFor = kept ? issuerOf(kept.discovery) : undefined;
    const client = typeof client_id === "string" ? { client: { client_id, ...(typeof client_secret === "string" ? { client_secret } : {}) }, kind: "pre-registered" as const } : kept && keptFor ? { client: kept.client, kind: kept.kind, keptFor } : {};
    return { authorization_url: await this.signIns.start(name, url!, { was: was ? saving(was) : null, ...(scopes ? { scope: (scopes as string[]).join(" ") } : {}), ...client, ...(source ? { source } : {}) }) };
  }

  /** GET .../oauth/callback: its state's sign-in finished (the code exchanged, the token set sealed, the tools listed and
   *  kept). Answers where to send the browser; 400 for a state that is unknown, used or expired. */
  oauthCallback(query: URLSearchParams, stop?: AbortSignal): Promise<string> {
    return this.track(this.callback(query, AbortSignal.any([this.stopped.signal, ...(stop ? [stop] : [])])));
  }

  private async callback(query: URLSearchParams, stop: AbortSignal): Promise<string> {
    let entry: Pending;
    try {
      entry = await this.signIns.takePending(query.get("state"));
    } catch (error) {
      if (error instanceof ApiError && error.code === "bad_request") throw error;
      return `${MCP_SETTINGS_PAGE}?sign_in=failed&error=${await reasonOf(error)}`;
    }
    const back = (error?: string) => `${MCP_SETTINGS_PAGE}?server=${entry.name}&sign_in=${error ? `failed&error=${error}` : "ok"}`;
    try {
      const error = query.get("error");
      if (error) return back(/^[a-z_]{1,64}$/.test(error) ? error : "sign_in_failed");
      // Checked again before the code is spent: the owner's list may have changed since the start.
      const send = await this.reached("oauth", new URL(entry.url), stop);
      const set = await this.signIns.finish(entry, query.get("code") ?? "", query.get("iss") ?? undefined, stop);
      const listed = await this.listServer(new URL(entry.url), { authorization: `Bearer ${set.tokens.access_token}` }, send, stop);
      const now = await this.store.mcp.server(entry.name);
      // Saved, signed in to again or forgotten since this sign-in started: that stands.
      if ((now ? saving(now) : null) !== entry.was) return back("changed_meanwhile");
      const prices = now?.url === entry.url ? ((now.prices ?? undefined) as McpPrices | undefined) : undefined;
      // Written only while the row is still the one just read, in the store's one statement: a save that lands in between
      // stands too. A sign-in is the owner's alone: over a row the token saved, it drops the token's mark in the
      // transaction that writes the signed-in row (`owns`), as the owner's save does, so the server is the owner's once
      // the sign-in lands, and one refused leaves it the token's.
      const saved = await saveMcpServerIfCredential(this.store, this.sealKey, {
        name: entry.name, url: entry.url, auth: "oauth", protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
        ...(prices && Object.keys(prices).length ? { prices } : {}), credential: { type: "oauth", set },
      }, credentialMark(now), now ? { owns: { record: mcpSourceKey(entry.name) } } : {});
      if (!saved) return back("changed_meanwhile");
      // What the start said the server is, written for the row just saved, as a save's is.
      if (entry.source) await this.store.settings.put(mcpSourceKey(entry.name), storedSource(entry.source, saved));
      await this.store.flush();
      return back();
    } catch (error) {
      return back(await reasonOf(error));
    }
  }

  /** `perRun`: the server is a per-run Composio server, whose saved address names no user, which Composio refuses even
   *  for a listing: listed as composio-preset.ts COMPOSIO_LISTING_USER, at that address alone. */
  private listServer(url: URL, headers: HeaderMap, send: typeof fetch, stop?: AbortSignal, perRun = false): Promise<Listed> {
    // The shared probe (mcp-probe.listServer), bound also to this server's own stop, each request sent as `send` (reached).
    return listServer(perRun ? composioListingAddress(url) : url, headers, this.version, AbortSignal.any([this.stopped.signal, ...(stop ? [stop] : [])]), send);
  }

  /** Whether the saved server `row` (named `name`) is a per-run Composio server (composio-made.ts composioPerRun). */
  private async perRunComposio(name: string, row: { auth: string; createdAt: number }): Promise<boolean> {
    return composioPerRun(row, await this.store.settings.get(composioMadeKey(name)));
  }

  /** How a request to the MCP server at `url` goes, or a 422 on url before anything is sent to it (or a token minted for
   *  it): a github_app server anywhere but GitHub's hosted MCP (GITHUB_MCP_ONLY, as withAppToken says), and at it, as it
   *  is, since that one origin is this server's to name, never the owner's; any other server held to the address rule
   *  (mcp-oauth.ts mcpServerAt, the one an authorization server's endpoint is held to), with the private-network hosts the
   *  owner allows read now, loopback only for a local install. The fetch it answers dials the address checked. A name
   *  that does not resolve is the unreachable server it always was (424). */
  private async reached(type: string, url: URL, stop?: AbortSignal): Promise<typeof fetch> {
    // A saved row's URL is held to the save's rule too: one with a credential in its query is refused, nothing sent.
    const inQuery = credentialInQuery(url);
    if (inQuery) throw invalid([{ field: "url", reason: "invalid", message: credentialInQueryWords(inQuery) }]);
    if (type === "github_app") {
      if (!githubMcpUrl(url, this.appOrigin)) throw invalid([{ field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY }]);
      return fetch;
    }
    // A URL on loopback as written, on a server its operator never said is a local install: refused, saying how to say so.
    if (!this.loopback && LOOPBACK.test(url.hostname)) throw invalid([{ field: "url", reason: "not_allowed", message: loopbackWords(url.hostname) }]);
    const signal = AbortSignal.any([AbortSignal.timeout(ADDRESS_CHECK_MS), this.stopped.signal, ...(stop ? [stop] : [])]);
    let at: Awaited<ReturnType<typeof mcpServerAt>>;
    try {
      at = await mcpServerAt(url, signal, this.network, { own: this.signIns.own, allowed: await privateOAuthHosts(this.store), loopback: this.loopback });
    } catch (error) {
      if (stop?.aborted || this.stopped.signal.aborted) throw error;
      // Its address check outlived its time: a name lookup that never answered.
      throw new ApiError("upstream_failed", `Could not reach the MCP server at ${url.origin} (DNS lookup timed out after ${ADDRESS_CHECK_MS / 1000} s).`);
    }
    if ("refused" in at) {
      if (at.unresolved) throw new ApiError("upstream_failed", `Could not reach the MCP server at ${url.origin} (ENOTFOUND).`);
      throw invalid([{ field: "url", reason: "not_allowed", message: `${at.refused.charAt(0).toUpperCase()}${at.refused.slice(1)}.` }]);
    }
    return dialAt(this.network, at.address) as typeof fetch;
  }

  private async need(name: string): Promise<McpServerRow> {
    const row = await this.store.mcp.server(name);
    if (!row) throw notFound(name);
    return row;
  }

  /** The saved credential of `row` opened, or the refusal that asks for it again. The credential of the row the caller
   *  read and checked, never the one saved now: a save at another address with a new credential while the caller waited
   *  (its address check, a listing) must never have that credential sent to the old address. */
  private async opened(name: string, row: McpServerRow, field: string): Promise<Opened> {
    // A Composio server saved with api_key_env: its key is its variable's value as the server was started with it
    // (composioKeyFromEnv), refused by name when unset.
    // Sent to Composio's origin alone (composioEnvKey): a row at any other address is refused by name, and nothing is sent.
    const keyEnv = await this.keyEnvOf(row);
    if (keyEnv) {
      const got = composioEnvKey(name, row.url, keyEnv, this.composioOrigin);
      if ("refused" in got) throw invalid([{ field, reason: got.reason, message: got.refused }]);
      const headers = { "x-api-key": got.key };
      return { headers, credential: { type: "headers", headers, origin: new URL(row.url).origin }, env: keyEnv };
    }
    // No credential kept: none for a server that takes none, nor for a github_app server with no static headers, nor for a
    // per_run server (each run hands its own).
    if (row.auth === "none" || row.sealed === null) return { headers: {}, credential: { type: "headers", headers: {}, origin: new URL(row.url).origin } };
    const open = openMcpRow(this.sealKey, row);
    if (!("credential" in open)) throw invalid([{ field, reason: "missing", message: `The saved credential of ${name} does not open here (sealed under another seal key, or damaged): send it again.` }]);
    const credential = open.credential;
    if (credential.type === "oauth") {
      if ((credential as { expired?: true }).expired) throw invalid([{ field, reason: "expired", message: `The sign-in to ${name} expired or was revoked: ${SIGN_IN_AGAIN}.` }]);
      return { headers: { authorization: `Bearer ${(credential.set as TokenSet).tokens.access_token}` }, credential };
    }
    return { headers: credential.headers as HeaderMap, credential };
  }

  /** The variable a Composio server saved with api_key_env reads its key from (composio-made.ts key_env): a headers row
   *  that seals no credential, whose record for this row names it. None for every other row. */
  async keyEnvOf(row: McpServerRow): Promise<typeof COMPOSIO_KEY_ENV | undefined> {
    if (row.auth !== "headers" || row.sealed !== null) return undefined;
    return recordedMade(await this.store.settings.get(composioMadeKey(row.name)), row.createdAt)?.key_env;
  }

  /** The saved OAuth token set of `row` (the row read and checked, as opened), for a sign-in again that reuses the kept
   *  client. */
  private openedSet(row: McpServerRow): TokenSet | undefined {
    if (row.auth !== "oauth") return undefined;
    const open = openMcpRow(this.sealKey, row);
    return "credential" in open && open.credential.type === "oauth" ? (open.credential.set as TokenSet) : undefined;
  }

  /** A saved Composio preset server's key (its sealed x-api-key), its toolkit and the auth config its save recorded
   *  (composio-made.ts; none for a server saved before that was recorded), and for a trigger's own steps (`field`) the
   *  Composio user its address names (`user_id`, the preset's default when none): what its Composio triggers are made with
   *  (composio-triggers.ts). The server's own routes (`route`) are answered no user: none of them sends one. Refused when
   *  `name` is no such server: on the trigger's `source.server` at its create (`field`), as a 404 on the server's own
   *  routes (`route`). The key goes only to Composio. */
  async composioOf<R extends "field" | "route">(name: string, refusal: R): Promise<ComposioCredentialOf<R>> {
    const refuse = (message: string) => (refusal === "route" ? new ApiError("not_found", message) : invalid([{ field: "source.server", reason: "not_an_option", message }]));
    const row = await this.store.mcp.server(name);
    if (!row) throw refusal === "route" ? notFound(name) : refuse(`No MCP server ${name}: save a Composio server in Settings → MCP servers first.`);
    const { source, toolkit } = await this.sourceOf(row);
    if (source !== "composio" || row.auth !== "headers") throw refuse(`${name} is not a Composio server: only one saved with Settings → MCP servers → Composio makes Composio triggers.`);
    if (!toolkit) throw refuse(`${name} is a Composio server of no toolkit this server can name: save it again with its toolkit's slug.`);
    const recorded = await this.store.settings.get(composioMadeKey(name));
    // A trigger runs as one Composio account, and a per-run server has none: each run names its own.
    if (refusal === "field" && composioPerRun(row, recorded)) throw refuse(`${name} takes its Composio account from each run (saved with user_id "${COMPOSIO_PER_RUN}"), and a trigger runs as one account: save a Composio server for that account to make its triggers.`);
    const { headers } = await this.opened(name, row, refusal === "field" ? "source.server" : "api_key");
    const key = Object.entries(headers).find(([header]) => header.toLowerCase() === "x-api-key")?.[1];
    if (!key) throw refuse(`${name}'s saved credential holds no Composio key: save it again with its key.`);
    const config = recordedMade(recorded, row.createdAt)?.auth_config?.id;
    const made = { key, toolkit, ...(config ? { auth_config: config } : {}) };
    // A route sends Composio no user: its events, its triggers and the project's subscription are read by the key, and a
    // delete or a save takes the project's turn by it, so it is answered none, and a server with a blank user keeps its
    // routes and that turn.
    if (refusal === "route") return made as ComposioCredentialOf<R>;
    // Only an address with no user_id at all is the default user's: an empty one is a blank user, refused below.
    const user = new URL(row.url).searchParams.get("user_id") ?? COMPOSIO_USER;
    // A user that is no Composio user id (a blank one Composio may read as every user) is refused for a trigger's own steps
    // before Composio is asked anything: a create sends the user (its account read, its connect link, its instance's
    // upsert).
    if (!COMPOSIO_USER_ID.test(user)) throw refuse(`${name}'s saved Composio user ${JSON.stringify(user)} is no Composio user id: save the server again with its user.`);
    return { ...made, user } as ComposioCredentialOf<R>;
  }

  /** What the saved server `row` is, for a template's apply to match (mcp-sources.ts sourceOf): github on the GitHub App's
   *  tokens, else its record, else url with none. */
  async sourceOf(row: RecordedRow & { name: string }): Promise<SourceRecord> {
    return sourceOf(row, await this.store.settings.get(mcpSourceKey(row.name)));
  }

  /** The API token's Composio save stands on no auth config a server the owner saved stands on (ownersAuthConfig,
   *  mcp-secret-writes.ts), named (before anything is sent) or found as the toolkit's own (before anything is made):
   *  composio-preset.ts composioSave `standsOn`. 403, naming the owner's server, nothing saved. */
  async tokenStandsOn(authConfig: string): Promise<void> {
    const owners = await ownersAuthConfig(this.store, authConfig);
    if (owners) throw new ApiError("forbidden", `The Composio auth config ${authConfig} is the one the owner's MCP server ${owners} stands on: an API token's server never uses it, so it never acts as the owner's connected account or removes what the owner's server made. Name an auth config of the token's own (auth_config_id). A server the token saved on it before its Composio users were namespaced (0.1.0-beta.56 and earlier) can't be saved again: delete it (DELETE /settings/mcp-servers/{name}), then save a new one. Nothing was saved.`);
  }

  /** On an API-only server, the refusal of a run's binding (`binding`, handed at `field`) of the per-run Composio server
   *  `name` (`row`), or undefined when it stands: its user must be none the owner calls as here (composio-owners.ts ownersComposioUsers), and
   *  a connected account it names one Composio lists under that user for the server's toolkit, read with the server's
   *  key (composioListsAccount). Composio not answering, or the key not opening, throws, and an account past the read's
   *  bound is refused: a binding is never taken unchecked. Each refusal says which check refused it, and never quotes
   *  what was sent. */
  async tokenBinding(name: string, row: McpServerRow, binding: { user_id: string; connected_account_id?: string }, field: string, control: ComposioControl, signal?: AbortSignal): Promise<InputIssue | undefined> {
    if (ownersUser(await ownersComposioUsers(this.store), binding.user_id)) return { field: `${field}.composio_user_id`, reason: "not_allowed", message: `That composio_user_id can't be used: ${COMPOSIO_OWNERS_USER_WORDS}. Nothing was started.` };
    const account = binding.connected_account_id;
    if (account === undefined) return undefined;
    const { toolkit } = await this.sourceOf(row);
    const key = Object.entries((await this.opened(name, row, field)).headers).find(([header]) => header.toLowerCase() === "x-api-key")?.[1];
    if (!toolkit || !key) throw invalid([{ field, reason: "not_an_option", message: `The MCP server ${name} names no Composio toolkit or key to check this run's connected account with: save it again. Nothing was started.` }]);
    let listed: Awaited<ReturnType<typeof composioListsAccount>>;
    try {
      listed = await composioListsAccount(asking(control, key, signal, "nothing was started"), binding.user_id, toolkit, account);
    } catch {
      throw new ApiError("upstream_failed", `Composio didn't answer the check of this run's connected account for the MCP server ${name}, and a run's account is never taken unchecked: nothing was started. Try again.`);
    }
    if (listed === "unbounded") return { field: `${field}.connected_account_id`, reason: "not_allowed", message: `That connected_account_id can't be checked: Composio lists ${composioAccountBoundWords()} for this run's composio_user_id and the server's toolkit, so this start can't check them all, and a run's account is never taken unchecked. Nothing was started.` };
    if (listed === "unlisted") return { field: `${field}.connected_account_id`, reason: "not_allowed", message: `That connected_account_id is not listed under this run's composio_user_id: Composio lists no such account of that user for the server's toolkit. Name one of that user's own accounts, or none. Nothing was started.` };
    return undefined;
  }

  /** The API token's Composio save stands on no ACTIVE account it found for its user unless a server the token saved
   *  holds it as made here (tokensAccount, mcp-secret-writes.ts): one no record here names may be the owner's, saved by
   *  hand, connected in Composio's dashboard, or kept after its server's delete. Checked for each ACTIVE one before
   *  anything is made (composio-preset.ts composioSave `accountOn`): 403, nothing saved. */
  async tokenAccountOn(user: string, account: string): Promise<void> {
    if (account && (await tokensAccount(this.store, account))) return;
    throw new ApiError("forbidden", `The Composio user_id ${user} already has a connected account here that no server the API token saved holds as one it connected: an API token's server never acts as it. Name a user_id of the token's own. Nothing was saved.`);
  }

  /** A body's URL for the saved row `saved` (savedOrGiven: its shown address sent back unchanged is its saved one), but
   *  over a row the API token saved, whose address the token chose and every read shows only the origin of, for anyone
   *  but the token (`byToken`): refused on `url`, so the owner's credential, a sign-in's or a header's, goes only to an
   *  address the owner named whole. An address with nothing hidden (shown as it is) is taken as given. Who saved it is
   *  read for the row `saved` as it still is: the row read again after its record, unchanged (every save moves its last
   *  edit, and the owner's drops the token's mark in the transaction that writes the row), or the request is refused
   *  (412), so a record read after a save moved the row never vouches for the address read before it. */
  private async givenUrl(given: unknown, saved: McpServerRow | undefined, byToken = false): Promise<unknown> {
    if (byToken || !saved || typeof given !== "string" || given !== shownUrl(saved.url) || given === saved.url) return savedOrGiven(given, saved?.url);
    const recorded = await this.store.settings.get(mcpSourceKey(saved.name));
    const now = await this.store.mcp.server(saved.name);
    if (now?.url !== saved.url || now.createdAt !== saved.createdAt || now.updatedAt !== saved.updatedAt) throw new ApiError("precondition_failed", `The MCP server ${saved.name} changed while this request read it (another save, a sign-in or a removal): read it again, then send it again.`);
    if (!savedByToken(recorded, saved.createdAt)) return savedOrGiven(given, saved.url);
    throw invalid([{ field: "url", reason: "not_an_option", message: `The MCP server ${saved.name} was saved by an API token, which chose its address, and reads show only its origin: give its full URL, so your credential goes only to an address you named.` }]);
  }

  private async view(row: McpServerRow) {
    const name = row.name;
    const { source, toolkit } = await this.sourceOf(row);
    const settings = this.toolSettings();
    const tools = (row.tools as McpTool[]) ?? [];
    const prices = (row.prices ?? undefined) as McpPrices | undefined;
    const listed = marked(row.url, { protocol: row.protocol ?? "unknown", server_info: row.serverInfo ?? null, ...(typeof row.instructions === "string" ? { instructions: row.instructions } : {}), tools });
    const unmetered = tools.filter((tool) => !(prices && Object.hasOwn(prices, tool.name))).map((tool) => tool.name);
    // A key read from the environment (api_key_env) is no credential kept here: its header is named, its value never read.
    // Its save's record, read once: the key's variable and the account kept for it.
    const made = row.auth === "headers" ? recordedMade(await this.store.settings.get(composioMadeKey(name)), row.createdAt) : undefined;
    const keyEnv = row.sealed === null ? made?.key_env : undefined;
    const opened = keyEnv || row.auth === "none" || row.auth === "per_run" || (row.auth === "github_app" && row.sealed === null) ? null : openMcpRow(this.sealKey, row);
    const cred = opened && "credential" in opened ? opened.credential : undefined;
    const set = cred?.type === "oauth" ? (cred.set as TokenSet) : undefined;
    const expired = cred?.type === "oauth" && (cred as { expired?: true }).expired === true;
    const updatedAt = new Date(row.updatedAt).toISOString();
    // A refresh moves listed_at, not updated_at, so the two differ after a refresh (updatedAt for a row from before the
    // column).
    const listedAt = new Date(row.listedAt ?? row.updatedAt).toISOString();
    const account = source === "composio" ? await this.accountOf(row, toolkit, made) : undefined;
    return {
      name,
      // Its origin, the path and query held as a secret (shownUrl): the whole URL is only ever sent to the server itself.
      url: shownUrl(row.url),
      // Where its tools come from and the toolkit they are: what a template's MCP needs are matched on at apply.
      source,
      toolkit,
      ...(prices && Object.keys(prices).length ? { prices } : {}),
      ...listed,
      // Each priced tool's price in USD a call, as the owner saved them, on every read.
      ...(prices && Object.keys(prices).length ? { prices } : {}),
      // Each tool's effect by its annotations as listed now (toolEffect), and its permission under them: what a run pinned
      // from this listing gets. A run already going keeps the marks its own pin holds.
      tools: listed.tools.map((tool) => {
        const effect = toolEffect(tool.annotations);
        return { ...tool, effect, ...serverGate(mcpToolName(name, tool.name), settings, effect), ...grantProblemsOf(this.env, name, tool) };
      }),
      ...(unmetered.length ? { not_metered: unmetered } : {}),
      auth: { type: row.auth, ...(row.auth === "headers" || row.auth === "github_app" ? { headers: keyEnv ? ["x-api-key"] : Object.keys((cred?.type === "headers" ? cred.headers : {}) as HeaderMap) } : {}), ...(keyEnv ? { api_key_env: keyEnv } : {}) },
      credential: opened === null ? null : !cred ? ("unreadable" as const) : expired ? ("expired" as const) : ("sealed" as const),
      ...(set ? { oauth: { ...(set.expires_at ? { expires_at: set.expires_at } : {}), scopes: (set.tokens.scope ?? "").split(" ").filter(Boolean), client: set.kind, ...(set.client?.client_id ? { client_id: set.client.client_id } : {}) } } : {}),
      listed_at: listedAt,
      updated_at: updatedAt,
      secret: secretOf(row, keyEnv),
      // A Composio server's account as its last refresh read it: connected or not, and each connected one's label.
      ...(account ? { composio_account: account } : {}),
    };
  }

  /** A body's URL, auth and prices, and a save's source and toolkit (`priced`: a save's body), or 422. */
  private admit(body: Record<string, unknown>, priced = false): { url: URL; auth: Auth; prices?: McpPrices; toolkit: string | null | undefined; standIn?: SourceRecord } {
    const issues: InputIssue[] = unknownFields(body, priced ? ["url", "auth", "prices", "toolkit", ...(this.standIns ? ["source"] : [])] : ["url", "auth"]);
    const url = urlOf(body.url, issues);
    const auth = authOf(body.auth, issues);
    const prices = pricesOf(body.prices, issues);
    const toolkit = priced ? toolkitGiven(body, issues) : undefined;
    const standIn = priced && this.standIns ? standInGiven(body, toolkit, issues) : undefined;
    // The App's tokens go to GitHub alone: a github_app server is GitHub's hosted MCP, nothing else, refused in that rule's
    // words in place of any other its URL drew.
    if (url && auth?.type === "github_app" && !githubMcpUrl(url, this.appOrigin)) issues.splice(0, issues.length, ...issues.filter((issue) => issue.field !== "url"), { field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY });
    if (issues.length) throw invalid(issues);
    return { url: url!, auth: auth!, ...(prices ? { prices } : {}), toolkit, ...(standIn ? { standIn } : {}) };
  }

  /** `headers` and, for a github_app server, an installation token of the connected App to list its tools with. Its URL
   *  is checked first (githubMcpUrl), so a row saved at another address never gets a token minted or sent. */
  private async withAppToken(type: string, url: URL, headers: HeaderMap, stop?: AbortSignal): Promise<HeaderMap> {
    if (type !== "github_app") return headers;
    if (!githubMcpUrl(url, this.appOrigin)) throw invalid([{ field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY }]);
    const minted = this.appToken ? await this.appToken(stop) : { unusable: "This server has no GitHub App: Connect GitHub in Settings." };
    if ("unusable" in minted) throw new ApiError("github_not_connected", minted.unusable);
    if ("failed" in minted) throw new ApiError("github_failed", minted.failed);
    return { ...headers, authorization: `Bearer ${minted.token}` };
  }
}

/** Why a grant of `tool` of `server` is refused where it would run, for a saved server's read (`grant_problems`): by its
 *  name alone on every harness (under `*`), or on one harness whose own MCP client would drop or retype its schema (that
 *  harness's facts, in the words the save's blocker says). Nothing when nothing refuses it. */
function grantProblemsOf(env: NodeJS.ProcessEnv, server: string, tool: McpTool): { grant_problems?: Record<string, string> } {
  const named = mcpGrantNameProblem(server, tool.name);
  const problems: Record<string, string> = named ? { "*": `${mcpToolName(server, tool.name)} ${named}` } : {};
  const schema = tool.input_schema;
  if (!named && isObject(schema)) {
    for (const harness of HARNESSES) {
      const dropped = harnessOf(env, harness)?.facts?.schemaProblems?.(`mcp__${server}__${tool.name}`, schema)[0];
      if (dropped) problems[harness] = droppedWords(mcpToolName(server, tool.name), harness, dropped);
    }
  }
  return Object.keys(problems).length ? { grant_problems: problems } : {};
}

/** Which save of a server this is: a PUT or a sign-in makes a new one (its updated time moves), a refresh of its tools or
 *  token does not change the url. The staleness key an OAuth sign-in carries from start to callback. */
const saving = (row: McpServerRow) => `${row.url} ${row.updatedAt}`;

export { MCP_ALLOW_LOOPBACK_ENV };
/** What a URL on loopback says on a server that is not one, with how to make it one: the switch, its value and the restart
 *  it takes (start-switches.ts). */
export const loopbackWords = (host: string) => `${host} is this machine; ${restartToAllow(MCP_ALLOW_LOOPBACK_ENV)}.`;

/** The owner's MCP registry over the one store. No load() is needed: every read goes to the store (the runner also writes
 *  the OAuth state), so a read is always current. */
export function mcpServersOverStore(store: McpServersStore, env: NodeJS.ProcessEnv, version: string, network?: OAuthNetwork): McpServersOverStore {
  return new McpServersOverStore(store, env, version, network);
}

/** The server's credential as every secret is read (SECRETS-PLAN.md): set or not, how it came ("console": pasted, a
 *  bearer token or headers; "sign-in": an OAuth sign-in; "env": a Composio key read from the variable `keyEnv`, set when
 *  the variable is set now, with no time; null: none), and the credential's own last change. Never a value. */
function secretOf(row: McpServerRow, keyEnv?: typeof COMPOSIO_KEY_ENV): SecretMeta {
  if (keyEnv) return secretMeta(secretName("mcp", row.name), { set: composioKeyFromEnv(keyEnv) !== undefined, source: "env", changedAt: null });
  const set = row.sealed !== null && row.auth !== "none";
  return secretMeta(secretName("mcp", row.name), { set, source: row.auth === "oauth" ? "sign-in" : "console", changedAt: row.credentialChangedAt === null ? null : new Date(row.credentialChangedAt) });
}
