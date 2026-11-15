// A person's ChatGPT plan as this server's model source for codex and pi: OpenAI's Sign in with ChatGPT, through pi-ai's
// own flow (its `openai` provider's OAuth: a loopback callback on 127.0.0.1:1455, or the final redirect URL pasted back),
// never one of ours. One sign-in per server: its credential is sealed whole in one row (CHATGPT_PLAN_ROW), and its access
// token goes to api.openai.com/v1/responses as a bearer, billed to the plan. Whoever holds the store and the seal key reads
// it per request (the server, its runners, in their own processes or containers); a token within REFRESH_MARGIN_MS of its
// end is renewed once across all of them: one renewal per refresh token in a process, and one holder at a time across
// processes, by a lease on the row taken with a compare-and-set on its sealed bytes (ChatGPTPlan.renew). A refusal of the renewal (a refresh token spent or revoked) marks the sign-in expired: nothing retries it. No token
// value is logged, journaled, put in a view or an error: each one read joins the redaction list (secrets.ts holdSecret).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialUnavailable } from "@parcha/agentrun-kernel/host";
import { holdSecret } from "./secrets.js";
import { registerSecretWrite } from "./secret-writes.js";
import { putSealedKey, removeSealedKey } from "./server-keys.js";
import { type SealedKeys, sealColumn, sealedAt, type Settings, STORE_WRITE_DEADLINE_MS, unsealColumn } from "./store/index.js";

// Every operation of the sign-in is the owner's session's alone (secret-writes.ts), the token in none of them: its view
// holds no token, but a pending sign-in's link is the owner's to open.
for (const operation of ["getChatGPTSignIn", "startChatGPTSignIn", "finishChatGPTSignIn", "signOutChatGPT"]) registerSecretWrite(operation, () => true);

/** The sealed row that holds the sign-in. */
export const CHATGPT_PLAN_ROW = "chatgpt:plan";
/** The model provider a plan model is named under (`chatgpt/<model-id>`), so a run's billing is never chosen silently. */
export const PLAN_PROVIDER = "chatgpt";
/** Where plan requests go. */
export const PLAN_ORIGIN = "https://api.openai.com";
/** The models listed when OpenAI's list can't be read at sign-in. */
export const PLAN_FALLBACK_MODELS: readonly string[] = Object.freeze(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
/** The model a run on the plan gets when it names none. */
export const PLAN_DEFAULT_MODEL = "gpt-6.1-sol";

const OPENID_CONFIGURATION = "https://auth.openai.com/.well-known/openid-configuration";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const AGENT_NAME = "AgentRun";
const HOST_ID_SETTING = "chatgpt_host_id";
const PENDING_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
/** The longest one refresh call at OpenAI may take: its holder gives it up by then. */
const REFRESH_CALL_MS = 15_000;
/** A refresh lease's length (60 s): the call, the write back (STORE_WRITE_DEADLINE_MS) and 35 s spare, so a lease never lapses
 *  while its holder may still spend the token. Its end is written on the holder's clock and judged on each reader's own:
 *  sealed_keys has no store clock to lease by, so a reader whose clock runs more than the 35 s spare ahead of the holder's
 *  can take a lease still live, and send a refresh token the holder may be spending (which OpenAI answers by revoking
 *  the sign-in). Hosts that share a store keep their clocks in step (NTP) for this. A holder that dies holds the others
 *  up for the lease's length at most. */
const REFRESH_LEASE_MS = REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS + 35_000;
/** How often a reader waiting on a peer's renewal reads the row again. */
const LEASE_WAIT_MS = 200;
const RENEW_LATER = "OpenAI could not renew the ChatGPT sign-in just now: try again in a moment.";
/** Where pi-ai's flow sends the browser at its end: the address a person pastes back from a remote server. */
/** OpenAI's fixed callback for this flow, built from its parts: a packed package carries no loopback URL as one string. */
const REDIRECT = Object.assign(new URL("http://callback.invalid/auth/callback"), { hostname: "127.0.0.1", port: "1455" });

export type PlanState = "signed_out" | "pending" | "signed_in" | "expired";
/** GET /settings/chatgpt: never a token. */
export type PlanView = { state: PlanState; email?: string; plan?: string; authorize_url?: string; expires_at?: string; models?: string[] };

type Credential = { type: "oauth"; access: string; refresh: string; expires: number; clientId: string; scopes?: string[] };
/** The sealed row. `lease`: a renewal in flight, its holder and its end (ms, on the holder's clock). */
type Row = { v: 1; state: "signed_in" | "expired"; credential: Credential; email?: string; plan?: string; models: string[]; lease?: { holder: string; until: number } };

/** The words a run or a request gets when there is no plan token to send. */
export const SIGNED_OUT = "This server is not signed in to ChatGPT: sign in under Settings → Model keys, or name a model on a key.";
export const EXPIRED = "This server's ChatGPT sign-in expired: sign in again under Settings → Model keys.";

/** A sign-in step refused, in words a person acts on (the routes' 400). */
export class PlanSignInRefused extends Error {}
/** No plan token can be had now (signed out, expired, or OpenAI could not renew it), in plain words: a model proxy
 *  refuses the request in these words (CredentialUnavailable). */
export class PlanUnavailable extends CredentialUnavailable {}

/** What a run reads of the plan: whether it is signed in now, its models, and its token, asked per request; `watch`
 *  tells each token as it is read or renewed, for a redactor. */
export interface PlanReader {
  readonly state: "signed_out" | "signed_in" | "expired";
  readonly models: readonly string[];
  token(): Promise<string>;
  /** Told OpenAI answered 401 to a request sent with `sent`: the next token() renews it, unless the store already holds
   *  another. */
  refused(sent: string): Promise<void>;
  watch(listener: (tokens: string[]) => void): void;
}

/** Where an environment object carries the plan's reader: a symbol, so no spawn, spread into an env list or JSON of it
 *  carries it (Node builds a child's environment from its string keys alone). */
const PLAN = Symbol.for("agentrun.chatgpt-plan");
/** `env`'s plan reader, if it has one. */
export const planOf = (env: NodeJS.ProcessEnv): PlanReader | undefined => (env as { [PLAN]?: PlanReader })[PLAN];
/** `env` carrying `plan`, in place: an enumerable symbol property, so an object spread of it keeps it. */
export function withPlan<E extends NodeJS.ProcessEnv>(env: E, plan: PlanReader | undefined): E {
  if (plan) Object.defineProperty(env, PLAN, { value: plan, enumerable: true, configurable: true, writable: true });
  return env;
}
/** Whether `env` runs on the plan now. */
export const signedIn = (env: NodeJS.ProcessEnv): boolean => planOf(env)?.state === "signed_in";

/** The claims of a JWT's payload, read without checking its signature (only for what a view shows), or none. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The email and plan a token names (OpenAI's profile and auth claims), for display alone. pi-ai keeps no ID token, so the
 *  access token's claims, which carry the same, are read. */
function whoOf(token: string): { email?: string; plan?: string } {
  const claims = claimsOf(token);
  const profile = claims["https://api.openai.com/profile"] as { email?: unknown } | undefined;
  const auth = claims["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined;
  const email = typeof profile?.email === "string" ? profile.email : typeof claims.email === "string" ? claims.email : undefined;
  const plan = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
}

/** Whether a renewal's refusal is for good: the refresh token spent, expired or revoked (a 400 or 401 from the token
 *  endpoint, as pi-ai words it), not a network fault or a 5xx. */
const refusedForGood = (error: unknown): boolean => /\((400|401)\)|invalid_grant|refresh_token_(reused|expired|invalidated)/.test(String((error as Error)?.message ?? ""));

/** Whether a renewal that failed surely left its refresh token unspent: OpenAI answered with a fault (a 5xx, a 429), or
 *  the request never reached it (no address, no connection). A timeout, or a fault once it was sent, may have spent it. */
function unspent(error: unknown): boolean {
  if (/token request failed \((?!400|401)\d{3}\)/.test(String((error as Error)?.message ?? ""))) return true;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

/** The renewals in flight in this process, by the refresh token they spend: two readers of one sign-in share one. */
const flights = new Map<string, Promise<string>>();

type Pending = { abort: AbortController; state: string; authorizeUrl: string; expiresAt: number; paste: (url: string) => void; result: Promise<void>; timer: NodeJS.Timeout };

export interface ChatGPTPlanDeps {
  /** `settings`: where a server keeps its host id, for a sign-in; a runner, which never signs in, has none. */
  readonly store: { readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "remove" | "replaceIf">; readonly settings?: Pick<Settings, "putIfAbsent"> };
  readonly sealKey: Buffer;
  readonly now?: () => number;
  /** Told after a sign-in, a sign-out or an expiry changed the state. */
  readonly changed?: () => void | Promise<void>;
  readonly log?: (fields: Record<string, string>) => void;
}

/** The plan over one store: a server's (sign-in, sign-out, its reading) or a runner's (the token, per request). */
export class ChatGPTPlan implements PlanReader {
  private snapshot: Row | undefined;
  private pending: Pending | undefined;
  /** An access token OpenAI refused (refused): token() renews rather than send it again. */
  private refusedAccess: string | undefined;
  /** Moved on by each sign-in started and each sign-out: a sign-in keeps its credential only while it is unmoved since it
   *  started, so a sign-out (or a newer sign-in) while it finishes wins. */
  private epoch = 0;
  private readonly watchers = new Set<(tokens: string[]) => void>();
  constructor(private readonly deps: ChatGPTPlanDeps) {}

  watch(listener: (tokens: string[]) => void): void {
    this.watchers.add(listener);
    if (this.snapshot) listener([this.snapshot.credential.access, this.snapshot.credential.refresh]);
  }

  /** Each token of `credential` joins this process's redaction, and every watcher's. */
  private hold(credential: Credential): void {
    holdSecret(credential.access, credential.refresh);
    for (const listener of this.watchers) listener([credential.access, credential.refresh]);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get state(): "signed_out" | "signed_in" | "expired" {
    return this.snapshot?.state ?? "signed_out";
  }

  get models(): readonly string[] {
    return this.snapshot?.models ?? [];
  }

  /** The row as sealed now, opened; none with none saved or one that does not open. */
  private async read(): Promise<Row | undefined> {
    return (await this.readSealed())?.row;
  }

  /** The row as sealed now, opened, with the bytes it was read as (what a compare-and-set on it compares). */
  private async readSealed(): Promise<{ row: Row; bytes: Uint8Array } | undefined> {
    const bytes = await this.deps.store.sealedKeys.get(CHATGPT_PLAN_ROW);
    if (bytes === undefined) return undefined;
    try {
      const row = JSON.parse(unsealColumn(this.deps.sealKey, sealedAt.sealedKey(CHATGPT_PLAN_ROW), bytes).toString("utf8")) as Row;
      if (row?.v !== 1 || !row.credential?.access || !row.credential.refresh) return undefined;
      this.hold(row.credential);
      return { row, bytes };
    } catch {
      return undefined;
    }
  }

  /** `row` sealed as the store keeps it: fresh bytes at each seal. */
  private seal(row: Row): Uint8Array {
    return sealColumn(this.deps.sealKey, sealedAt.sealedKey(CHATGPT_PLAN_ROW), JSON.stringify(row));
  }

  /** `row` saved only while the store still holds `was` (SealedKeys.replaceIf): the bytes it was saved as, or none when
   *  the row had changed. */
  private async swap(was: Uint8Array, row: Row): Promise<Uint8Array | undefined> {
    const bytes = this.seal(row);
    return (await this.deps.store.sealedKeys.replaceIf(CHATGPT_PLAN_ROW, was, bytes)) ? bytes : undefined;
  }

  private async write(row: Row): Promise<void> {
    this.hold(row.credential);
    await putSealedKey(this.deps.store, this.deps.sealKey, CHATGPT_PLAN_ROW, JSON.stringify(row));
    this.snapshot = row;
  }

  /** Reads the sealed row into the state a reader sees. Returns this. */
  async load(): Promise<this> {
    this.snapshot = await this.read();
    return this;
  }

  view(): PlanView {
    if (this.pending && this.pending.expiresAt <= this.now()) this.cancel();
    const row = this.snapshot;
    const who = row ? { ...(row.email ? { email: row.email } : {}), ...(row.plan ? { plan: row.plan } : {}) } : {};
    if (this.pending) return { state: "pending", authorize_url: this.pending.authorizeUrl, expires_at: new Date(this.pending.expiresAt).toISOString(), ...who };
    if (!row) return { state: "signed_out" };
    return { state: row.state, ...who, ...(row.state === "signed_in" ? { models: [...row.models] } : {}) };
  }

  /** This server's id at OpenAI (its agent host id): a UUID made once and kept in the store's settings. Not a credential. */
  private async hostId(): Promise<string> {
    if (!this.deps.store.settings) throw new Error("a ChatGPT sign-in starts on the server, which keeps its host id");
    const kept = await this.deps.store.settings.putIfAbsent(HOST_ID_SETTING, randomUUID());
    if (typeof kept !== "string") throw new Error("this server's ChatGPT host id is not a UUID in its settings");
    return kept;
  }

  private cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.abort.abort();
  }

  /** Starts a sign-in (one at a time: a new start cancels the one waiting) and gives the address to open. It lasts 10
   *  minutes: the loopback callback finishes it where the browser runs on this machine; elsewhere finishSignIn does. */
  async startSignIn(): Promise<{ authorize_url: string; expires_at: string }> {
    // A sign-in still finishing drops its credential (keep): this one is the person's latest.
    const epoch = ++this.epoch;
    const before = this.pending;
    this.cancel();
    // pi-ai's callback listener on :1455 closes as its login ends: the one cancelled ends before this one listens.
    if (before) await before.result.catch(() => undefined);
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    const oauth = openaiProvider().auth.oauth!;
    const hostId = await this.hostId();
    const abort = new AbortController();
    let paste!: (url: string) => void;
    const pasted = new Promise<string>((resolve) => (paste = resolve));
    let linked!: (url: string) => void;
    const link = new Promise<string>((resolve) => (linked = resolve));
    const login = oauth.login({
      signal: abort.signal,
      notify: (event) => void (event.type === "auth_url" ? linked(event.url) : undefined),
      prompt: (prompt) => (prompt.type === "manual_code" ? Promise.race([pasted, new Promise<string>((_, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true }))]) : Promise.reject(new Error("not asked here"))),
    }, { getDeviceId: () => hostId, agentName: AGENT_NAME });
    const settle = () => {
      if (this.pending?.abort !== abort) return;
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    };
    // Pending until the credential is kept or dropped, so a sign-out meanwhile cancels it (keep's epoch).
    const result = login.then((credential) => this.keep(credential as Credential, epoch)).finally(settle);
    result.catch(() => undefined);
    const authorizeUrl = await Promise.race([link, result.then(() => undefined, (error: unknown) => {
      throw new PlanSignInRefused(/in use/.test(String((error as Error)?.message)) ? "Another sign-in holds this machine's port 1455: finish or cancel it, then start again." : "The sign-in could not start: try again.");
    })]);
    if (!authorizeUrl) throw new PlanSignInRefused("The sign-in could not start: try again.");
    const expiresAt = this.now() + PENDING_MS;
    const timer = setTimeout(() => (this.pending?.abort === abort ? this.cancel() : undefined), PENDING_MS);
    timer.unref();
    this.pending = { abort, state: new URL(authorizeUrl).searchParams.get("state") ?? "", authorizeUrl, expiresAt, paste, result, timer };
    return { authorize_url: authorizeUrl, expires_at: new Date(expiresAt).toISOString() };
  }

  /** Finishes the sign-in waiting with the address its browser tab ended on, pasted. A URL that is not that sign-in's end
   *  is refused in words and the sign-in keeps waiting; one OpenAI refuses ends it. */
  async finishSignIn(redirectUrl: unknown): Promise<PlanView> {
    const pending = this.pending && this.pending.expiresAt > this.now() ? this.pending : undefined;
    if (!pending) throw new PlanSignInRefused("No ChatGPT sign-in is waiting (one lasts 10 minutes): start the sign-in again.");
    const shape = `Paste the whole address the sign-in tab ended on: it starts with ${REDIRECT.href}.`;
    let url: URL;
    try {
      url = new URL(String(redirectUrl ?? "").trim());
    } catch {
      throw new PlanSignInRefused(shape);
    }
    if (url.origin !== REDIRECT.origin || url.pathname !== REDIRECT.pathname) throw new PlanSignInRefused(shape);
    const error = url.searchParams.get("error");
    if (error) throw new PlanSignInRefused(`ChatGPT did not sign you in (${error.replace(/[^a-z_]/gi, "").slice(0, 40)}): start the sign-in again.`);
    if (url.searchParams.get("state") !== pending.state) throw new PlanSignInRefused("That address is from another sign-in: paste the one from the sign-in you started last, or start again.");
    if (!url.searchParams.get("code") || !url.searchParams.get("client_id")) throw new PlanSignInRefused(`That address has no sign-in code in it. ${shape}`);
    pending.paste(url.href);
    try {
      await pending.result;
    } catch (error) {
      const words = String((error as Error)?.message ?? "");
      if (words.includes(DIRECT_SCOPE)) throw new PlanSignInRefused("This ChatGPT account did not allow its plan to be used by apps: sign in with an account whose plan allows it.");
      throw new PlanSignInRefused("OpenAI refused the sign-in: start it again.");
    }
    return this.view();
  }

  /** A credential from the sign-in started at `epoch`, checked and sealed with what a view shows. A sign-out or a newer
   *  sign-in since then wins: the credential is dropped, never written, and revoked at OpenAI. */
  private async keep(credential: Credential, epoch: number): Promise<void> {
    if (credential.scopes && !credential.scopes.includes(DIRECT_SCOPE)) throw new Error(`the grant did not include ${DIRECT_SCOPE}`);
    this.hold(credential);
    const models = await this.listModels(credential.access);
    if (epoch !== this.epoch) {
      await this.revoke(credential);
      return;
    }
    await this.write({ v: 1, state: "signed_in", credential, ...whoOf(credential.access), models });
    this.deps.log?.({ chatgpt: "signed_in" });
    await this.deps.changed?.();
  }

  /** The plan's models from OpenAI's list (GET /v1/models with the token), those of the current families; the fallback
   *  list when it can't be read. */
  private async listModels(token: string): Promise<string[]> {
    try {
      const response = await fetch(`${PLAN_ORIGIN}/v1/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return [...PLAN_FALLBACK_MODELS];
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string" && /^gpt-6(?:[.-]|$)/.test(id));
      return ids.length ? [...new Set(ids)] : [...PLAN_FALLBACK_MODELS];
    } catch {
      return [...PLAN_FALLBACK_MODELS];
    }
  }

  /** The access token to send now: the sealed one, renewed first when it ends within 5 minutes. Throws PlanUnavailable,
   *  in words, when there is none. */
  async token(): Promise<string> {
    const row = await this.read();
    this.snapshot = row;
    if (!row) throw new PlanUnavailable(SIGNED_OUT);
    if (row.state === "expired") throw new PlanUnavailable(EXPIRED);
    if (this.fresh(row)) return row.credential.access;
    // One renewal per refresh token in this process; across processes, the row's lease (renew).
    const key = row.credential.refresh;
    let flight = flights.get(key);
    if (!flight) {
      flight = this.renew(key).finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    return flight;
  }

  /** Whether `row`'s access token may be sent as it is: OpenAI has not refused it here, and it has more than 5 minutes left. */
  private fresh(row: Row): boolean {
    return row.credential.access !== this.refusedAccess && row.credential.expires - this.now() > REFRESH_MARGIN_MS;
  }

  /** OpenAI answered 401 to `sent`: the row read again, and the next token() renews it only when the row still holds
   *  `sent` (another holder that renewed already has put a new one there, which is sent instead). */
  async refused(sent: string): Promise<void> {
    const row = await this.read();
    if (row?.state === "signed_in" && row.credential.access === sent) this.refusedAccess = sent;
  }

  /** Renews the sign-in whose refresh token is `seen`, for any process that holds the store and the seal key (the server,
   *  each runner). A refresh token is spent at its use, and one used twice makes OpenAI revoke the whole sign-in, so one
   *  holder at a time takes a lease on the row (a compare-and-set on its sealed bytes) before it spends the token. The
   *  others adopt the pair it writes back: meanwhile they send the current token while it has not ended, and wait for the
   *  new pair once it has. A lease whose holder died lapses after REFRESH_LEASE_MS, and the next reader takes it. */
  private async renew(seen: string): Promise<string> {
    const holder = randomUUID();
    const giveUp = this.now() + REFRESH_LEASE_MS + REFRESH_CALL_MS;
    for (;;) {
      const read = await this.readSealed();
      if (!read) throw new PlanUnavailable(SIGNED_OUT);
      const { row, bytes } = read;
      this.snapshot = row;
      if (row.state === "expired") throw new PlanUnavailable(EXPIRED);
      // A peer renewed it since: its pair is the row's now.
      if (row.credential.refresh !== seen && this.fresh(row)) return row.credential.access;
      if (row.lease && row.lease.until > this.now()) {
        if (row.credential.access !== this.refusedAccess && row.credential.expires > this.now()) return row.credential.access;
        if (this.now() > giveUp) throw new PlanUnavailable(RENEW_LATER);
        await sleep(LEASE_WAIT_MS);
        continue;
      }
      const leased: Row = { ...row, lease: { holder, until: this.now() + REFRESH_LEASE_MS } };
      // Changed since it was read (a peer leased or renewed it, or the owner signed in again): read it again.
      const mine = await this.swap(bytes, leased);
      if (!mine) continue;
      return this.renewUnder(leased, mine);
    }
  }

  /** The renewal itself, under this holder's lease on `row` (sealed as `bytes`). Every write back is a compare-and-set
   *  against the leased row, so a sign-out or a new sign-in meanwhile is never overwritten: ours is dropped. */
  private async renewUnder(row: Row, bytes: Uint8Array): Promise<string> {
    const { lease: _, ...bare } = row;
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    let next: Credential;
    try {
      next = (await openaiProvider().auth.oauth!.refresh(bare.credential, AbortSignal.timeout(REFRESH_CALL_MS))) as Credential;
    } catch (error) {
      if (!refusedForGood(error)) {
        // A fault at OpenAI, or none reached: the token is unspent, so the lease is given back for the next try. Sent
        // with no answer read (a timeout, a lost connection): it may be spent, so the lease is held to its end, and no
        // one sends it again sooner.
        if (unspent(error)) await this.swap(bytes, bare).catch(() => undefined);
        throw new PlanUnavailable(RENEW_LATER);
      }
      const expired: Row = { ...bare, state: "expired" };
      if (await this.swap(bytes, expired)) {
        this.snapshot = expired;
        this.deps.log?.({ chatgpt: "expired" });
        await this.deps.changed?.();
        throw new PlanUnavailable(EXPIRED);
      }
      return this.adopt();
    }
    const renewed: Row = { ...bare, credential: { ...bare.credential, ...next } };
    this.hold(renewed.credential);
    if (await this.swap(bytes, renewed)) {
      this.snapshot = renewed;
      return renewed.credential.access;
    }
    return this.adopt();
  }

  /** After a renewal whose write back lost its compare-and-set (the owner signed out or in again meanwhile): its result
   *  is dropped, and the row's state wins. */
  private async adopt(): Promise<string> {
    const now = await this.read();
    this.snapshot = now;
    if (!now) throw new PlanUnavailable(SIGNED_OUT);
    if (now.state === "expired") throw new PlanUnavailable(EXPIRED);
    if (this.fresh(now)) return now.credential.access;
    throw new PlanUnavailable(RENEW_LATER);
  }

  /** Signs out: any sign-in waiting cancelled, the session revoked at OpenAI (its documented revocation endpoint, with the
   *  refresh token), then the row removed whatever the revocation said. `revoked`: whether OpenAI confirmed it. */
  async signOut(): Promise<{ revoked: boolean }> {
    // A sign-in finishing now drops its credential (keep).
    this.epoch += 1;
    this.cancel();
    const row = await this.read();
    const revoked = row ? await this.revoke(row.credential) : false;
    await removeSealedKey(this.deps.store, CHATGPT_PLAN_ROW);
    this.snapshot = undefined;
    this.deps.log?.({ chatgpt: "signed_out", revoked: String(revoked) });
    await this.deps.changed?.();
    return { revoked };
  }

  /** `credential`'s session revoked at OpenAI (its documented revocation endpoint, with the refresh token): whether OpenAI
   *  confirmed it. Never throws. */
  private async revoke(credential: Credential): Promise<boolean> {
    try {
      const config = (await (await fetch(OPENID_CONFIGURATION, { signal: AbortSignal.timeout(5_000) })).json()) as { revocation_endpoint?: unknown };
      const endpoint = typeof config.revocation_endpoint === "string" ? new URL(config.revocation_endpoint) : undefined;
      if (endpoint?.protocol !== "https:") return false;
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId }), signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Stops the sign-in waiting, at the server's close. */
  close(): void {
    this.cancel();
  }
}

/** For a run on a plan model (`model`, the one its claim chose): the plan's token read once before anything starts, so a
 *  sign-in that is gone, or that OpenAI refuses to renew, fails the run at once, in words (PlanUnavailable). */
export async function planBeforeRun(env: NodeJS.ProcessEnv, model: { provider: string } | undefined): Promise<void> {
  if (model?.provider !== PLAN_PROVIDER) return;
  const plan = planOf(env);
  if (!plan) throw new PlanUnavailable(SIGNED_OUT);
  await plan.token();
}

/** A runner's reader of the plan over its store, loaded now: none when the server holds no sign-in. */
export async function planReaderOf(store: ChatGPTPlanDeps["store"], sealKey: Buffer | undefined): Promise<PlanReader | undefined> {
  if (!sealKey) return undefined;
  const plan = await new ChatGPTPlan({ store, sealKey }).load();
  return plan.state === "signed_out" ? undefined : plan;
}
