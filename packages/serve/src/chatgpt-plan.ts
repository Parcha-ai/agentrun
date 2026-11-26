// A person's ChatGPT plan as this server's model source for codex and pi: OpenAI's Sign in with ChatGPT, through pi-ai's
// own flow (its `openai` provider's OAuth: a loopback callback on 127.0.0.1:1455, or the final redirect URL pasted back),
// never one of ours. One sign-in per server: its credential is sealed whole in one row (CHATGPT_PLAN_ROW), and its access
// token goes to api.openai.com/v1/responses as a bearer, billed to the plan. Whoever holds the store and the seal key reads
// it per request (the server, its runners, in their own processes or containers); a token within REFRESH_MARGIN_MS of its
// end is renewed once across all of them: one renewal per refresh token in a process, and one holder at a time across
// processes, by a lease on the row taken with a compare-and-set on its sealed bytes and judged on the store's clock
// (ChatGPTPlan.renew). A refusal of the renewal (a refresh token spent or revoked) marks the sign-in expired: nothing
// retries it. No token outlives the sign-in it belongs to: a sign-out, a new sign-in, or a renewal that loses its write
// back revokes the pair it leaves behind at OpenAI (ChatGPTPlan.revoke). No token value is logged, journaled, put in a
// view or an error, or printed with the reader: each one read joins the redaction list (secrets.ts holdSecret).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";
import { CredentialUnavailable } from "@parcha/agentrun-kernel/host";
import { holdSecret } from "./secrets.js";
import { registerSecretPage, registerSecretWrite } from "./secret-writes.js";
import { putSealedKey } from "./server-keys.js";
import { logLine } from "./print.js";
import { held } from "./runner/held.js";
import { type SealedKeys, sealColumn, sealedAt, type Settings, StoreBusy, StoreClosed, StoreDeadline, STORE_WRITE_DEADLINE_MS, unsealColumn } from "./store/index.js";

// Every operation of the sign-in is the owner's session's alone (secret-writes.ts), the token in none of them: its view
// holds no token, but a pending sign-in's link is the owner's to open.
for (const operation of ["getChatGPTSignIn", "startChatGPTSignIn", "finishChatGPTSignIn", "signOutChatGPT"]) registerSecretWrite(operation, () => true);
registerSecretPage(["getChatGPTSignIn", "startChatGPTSignIn", "finishChatGPTSignIn", "signOutChatGPT"], "/#/settings/keys");

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
/** How long a sign-in waits before its view says why it may be stuck (STILL_WAITING): long before PENDING_MS ends it. */
const HINT_AFTER_MS = 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
/** The longest one refresh call at OpenAI may take: its holder gives it up by then. */
const REFRESH_CALL_MS = 15_000;
/** A refresh lease's length (60 s): the call, the write back (STORE_WRITE_DEADLINE_MS) and 35 s spare, so a lease never lapses
 *  while its holder may still spend the token. Its end is stamped and judged on the store's clock (SealedKeys.clock: the
 *  database's on Postgres), never a process's own, so a reader whose clock runs ahead of the holder's never takes a lease
 *  still live and sends a refresh token the holder may be spending (which OpenAI answers by revoking the sign-in). A
 *  holder that dies holds the others up for the lease's length at most. A write-back that faults uses most of the spare:
 *  its read back, a write again and a read once more, each up to STORE_WRITE_DEADLINE_MS (57 s in all at worst, more
 *  only when a stall holds the event loop past those deadlines). */
const REFRESH_LEASE_MS = REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS + 35_000;
/** How often a reader waiting on a peer's renewal reads the row again. */
const LEASE_WAIT_MS = 200;
const RENEW_LATER = "OpenAI could not renew the ChatGPT sign-in just now: try again in a moment.";
/** Where pi-ai's flow sends the browser at its end: the address a person pastes back from a remote server. */
/** OpenAI's fixed callback for this flow, built from its parts: a packed package carries no loopback URL as one string. */
const REDIRECT = Object.assign(new URL("http://callback.invalid/auth/callback"), { hostname: "127.0.0.1", port: "1455" });

export type PlanState = "signed_out" | "pending" | "signed_in" | "expired";
/** GET /settings/chatgpt: never a token. `problem`: why the last sign-in ended without signing in, in words. `hint`: on a
 *  sign-in waiting past its first minute, why it may be stuck (STILL_WAITING). */
export type PlanView = { state: PlanState; email?: string; plan?: string; authorize_url?: string; expires_at?: string; models?: string[]; problem?: string; hint?: string };

type Credential = { type: "oauth"; access: string; refresh: string; expires: number; clientId: string; scopes?: string[] };
/** The sealed row. `lease`: a renewal in flight, its holder and its end (ms, on the store's clock). A sign-in is saved
 *  before anything slow (keep), and what it leaves is in the row until done (settle): `unlisted`, its models are the
 *  fallback list until OpenAI's list is read; `retired`, the pairs of the sign-ins it replaced, until OpenAI confirms
 *  their revocation. */
type Row = { v: 1; state: "signed_in" | "expired"; credential: Credential; email?: string; plan?: string; models: string[]; unlisted?: true; retired?: Credential[]; lease?: { holder: string; until: number } };
/** What a settle did (settle): `revoked`, whether OpenAI confirmed every carried pair (none when the row carried none);
 *  `listed`, whether it wrote the models OpenAI listed. */
type Settled = { revoked?: boolean; listed?: boolean };

/** The words a run or a request gets when there is no plan token to send. */
export const SIGNED_OUT = "This server is not signed in to ChatGPT: sign in under Settings → Model keys, or name a model on a key.";
export const EXPIRED = "This server's ChatGPT sign-in expired: sign in again under Settings → Model keys.";
/** What a sign-out answers beside `revoked: false`: the sign-in is gone here, and the person ends it at OpenAI. */
export const SIGN_OUT_UNCONFIRMED = "Signed out here. OpenAI didn't confirm the revocation: remove AgentRun in your ChatGPT settings.";

/** A sign-in step refused, in words a person acts on (the routes' 400). */
export class PlanSignInRefused extends Error {}
/** No plan token can be had now (signed out, expired, or OpenAI could not renew it), in plain words: a model proxy
 *  refuses the request in these words (CredentialUnavailable). */
export class PlanUnavailable extends CredentialUnavailable {}
/** No renewal is started because the reader's store is stopping its renewals (stopRenewals: a server's stop, or a
 *  runner's RUNNER_RENEWALS_SERVED_MS into its close), and the token in hand would not outlive the stop (asItIs): no
 *  refresh token was sent, and the sign-in stays saved. A runner
 *  hands the run that asked back to resume on its next start instead of failing it (LoopDeps.handBack). */
export class PlanStopping extends PlanUnavailable {}

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
/** A runner's close tail: `work` (its runs' close, then what it lets go of), then, whatever `work` threw, its renewals'
 *  drain and its store's close, in that order, so a renewal OpenAI is answering still saves its pair; `work`'s error is
 *  thrown after them. */
export async function closeStoreAfter(work: () => Promise<void>, drainRenewals: () => Promise<void>, store: { close(): Promise<void> }): Promise<void> {
  try {
    await work();
  } finally {
    await drainRenewals();
    await store.close();
  }
}

/** `plan` for one claimed run on a runner: a renewal refused because the runner is closing (PlanStopping) tells
 *  `handBack` (LoopDeps.handBack), which stops the run's loop for a shutdown and aborts `signal`, and the ask is answered
 *  with that abort, so the run is handed back to resume, never failed for it. Any other answer is the plan's own. */
export function handingBack(plan: PlanReader, handBack: () => void, signal: AbortSignal): PlanReader {
  return {
    get state() {
      return plan.state;
    },
    get models() {
      return plan.models;
    },
    token: async () => {
      try {
        return await plan.token();
      } catch (error) {
        if (!(error instanceof PlanStopping)) throw error;
        handBack();
        throw signal.aborted ? signal.reason : error;
      }
    },
    refused: (sent) => plan.refused(sent),
    watch: (listener) => plan.watch(listener),
  };
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

/** A sign-in OpenAI finished whose credential this server could not keep (keep threw). */
class NotKept extends Error {}

/** `value` as a log field or a code in words: letters, digits and `_` alone, 40 at most. */
const tag = (value: unknown): string => String(value ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
/** OpenAI's error code for a workspace whose admin has turned off open-source apps' use of its ChatGPT plans. */
const WORKSPACE_DENIED = "3p_delegated_access_policy_denied";
const ADMIN_OFF = "Your ChatGPT workspace's admin has turned off open-source apps (External access → OSS → Use ChatGPT plan): ask them to turn it on, or sign in with another account.";
/** A grant without DIRECT_SCOPE: OpenAI signed the account in but gave no use of its plan by apps. */
const PLAN_NOT_USABLE = "This ChatGPT plan can't be used here: OpenAI's sign-in gave AgentRun no use of it. Free plans usually can't; sign in with a paid one.";
/** What a refusal whose reason OpenAI doesn't name ends with: a Free plan's sign-in has ended in one, and nothing tells it
 *  apart. It never says Free can't be used: OpenAI changes which plans can. */
const FREE_OR_AGAIN = "a Free ChatGPT plan may be the reason; with a paid plan, start it again.";
/** The likely cause of a sign-in OpenAI never sends back: a workspace whose admin has turned off open-source apps gets
 *  OpenAI's refusal on OpenAI's own page, with no way back to this server, so nothing here can tell it from a tab left
 *  open. Named first in a sign-in still waiting (STILL_WAITING) and in its timeout. */
const ADMIN_LIKELY = "If OpenAI's page showed an error instead of signing you in, your ChatGPT workspace's admin has likely turned off open-source apps (External access → OSS → Use ChatGPT plan): ask them to turn it on, or sign in with another account.";
const TIMED_OUT = `The sign-in timed out: OpenAI never sent the code back. ${ADMIN_LIKELY} Otherwise, start it again.`;
/** A pending view's `hint` from HINT_AFTER_MS into its wait on, while no code is in: a sign-in that goes through is back
 *  well within it. */
const STILL_WAITING = `OpenAI hasn't sent the code back yet. ${ADMIN_LIKELY}`;
/** The timeout of a sign-in whose code came back (the browser's return or a paste) while OpenAI was still answering it:
 *  no admin guess, since OpenAI's page did send the browser back. */
const CUT_OFF = "The sign-in timed out while OpenAI was still answering its code: start it again.";
/** The words for OpenAI's refusal `code` at its sign-in page: fixed words, never the code. Anything on this machine can
 *  send the loopback callback an `error` while a sign-in waits, so the code goes to the log alone. */
const deniedWords = (code: string): string => (code === WORKSPACE_DENIED ? ADMIN_OFF : `ChatGPT did not sign you in: ${FREE_OR_AGAIN}`);

/** Why a sign-in past its browser step ended without signing in, from what pi-ai's flow or keep threw: `reason` for the
 *  log (OpenAI's status and error code, a missing field's name, a network error's code; never a token or a code) and
 *  `words` a person reads. pi-ai's page says the sign-in completed before it exchanges the code, so these are the only
 *  word of a failure after it. */
export function signInFailure(error: unknown): { reason: string; words: string } {
  const notKept = error instanceof NotKept;
  const cause = notKept ? error.cause : error;
  const message = String((cause as Error)?.message ?? "");
  // OpenAI's refusal at its sign-in page, sent back to the loopback in place of a code (pi-ai's words for it), or of the
  // code's exchange. Its code goes to the log; the words are fixed.
  const denied = notKept ? null : /ChatGPT authorization failed: (\S+)/.exec(message);
  const refused = notKept ? null : /token request failed \((\d{3})\)/.exec(message);
  const code = denied ? tag(denied[1]) : refused ? tag(/"error"\s*:\s*"([^"]*)"/.exec(message)?.[1]) : "";
  const reason = denied ? `authorize_${code || "error"}` : refused ? `token_${refused[1]}${code ? `_${code}` : ""}` : "";
  // The workspace's refusal first: OpenAI's description of it may name the plan's scope.
  if (code === WORKSPACE_DENIED) return { reason, words: ADMIN_OFF };
  if (message.includes(DIRECT_SCOPE)) return { reason: "no_direct_scope", words: PLAN_NOT_USABLE };
  const unsaved = notKept ? tag((cause as { code?: unknown })?.code) : "";
  if (notKept) return { reason: `not_saved${unsaved ? `_${unsaved}` : ""}`, words: "OpenAI signed you in, but this server could not save the sign-in: start it again. The server's log says why." };
  if (denied) return { reason, words: deniedWords(code) };
  if (refused) return { reason, words: `OpenAI refused the sign-in: ${FREE_OR_AGAIN}` };
  const unread = /token response (?:has invalid (\w+)|did not contain an (ID token)|must be an object)/.exec(message);
  if (unread) return { reason: `token_answer_${tag((unread[1] ?? unread[2] ?? "shape").replace(" ", "_"))}`, words: "OpenAI's answer to the sign-in was not one AgentRun can read: start it again. The server's log says what was missing." };
  const network = tag((cause as { cause?: { code?: unknown } })?.cause?.code);
  if (/fetch failed/.test(message) || network) return { reason: `network${network ? `_${network}` : ""}`, words: "This server could not reach OpenAI to finish the sign-in: check its connection, then start again." };
  return { reason: `other_${tag((cause as Error)?.name) || "error"}`, words: "The sign-in did not finish: start it again. The server's log says why." };
}

/** Whether a renewal that failed surely left its refresh token unspent: OpenAI answered with a fault (a 5xx, a 429), or
 *  the request never reached it (no address, no connection). A timeout, or a fault once it was sent, may have spent it. */
function unspent(error: unknown): boolean {
  if (/token request failed \((?!400|401)\d{3}\)/.test(String((error as Error)?.message ?? ""))) return true;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

/** The renewals in flight in this process, by the refresh token they spend: two readers of one sign-in share one. */
const flights = new Map<string, Promise<string>>();
/** Each store's renewals in this process (by its sealed keys): those in flight, for its stop to drain, whether its stop
 *  has begun (stopRenewals), from which no reader on it starts one, and when that stop's drain ends (epoch ms). */
type StoreRenewals = { flights: Set<Promise<string>>; stopping: boolean; drainEnds?: number };
const storeRenewals = new WeakMap<object, StoreRenewals>();
const renewalsOf = (store: ChatGPTPlanDeps["store"]): StoreRenewals => {
  let of = storeRenewals.get(store.sealedKeys);
  if (!of) storeRenewals.set(store.sealedKeys, (of = { flights: new Set(), stopping: false }));
  return of;
};
/** How long a stop waits for a renewal in flight (stopRenewals): OpenAI's answer and the write back, for a refresh sent
 *  before the stop began (none is sent after it: renewUnder). */
export const RENEWAL_DRAIN_MS = REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS;

/** A plan's log with no log of its own (a runner's reader): this process's stderr, one line, never a token. */
const stderrLog = (fields: Record<string, string>): void => void process.stderr.write(`agentrun-serve: ${logLine("chatgpt", fields)}\n`);

/** How long a runner's close drains renewals from when it says its loops are stopping (runner.ts close): the rest of its
 *  window, `by` (epoch ms), up to RENEWAL_DRAIN_MS; RENEWAL_DRAIN_MS when no window was given (a close already made). */
export const renewalDrainFor = (by: number | undefined): number => (by === undefined ? RENEWAL_DRAIN_MS : Math.max(0, Math.min(RENEWAL_DRAIN_MS, by - Date.now())));

/** A store's stop in this process (the server's, a runner's beside it or of its own), awaited before `store.close()`:
 *  from now no reader on the store starts a renewal, and this resolves once those out have ended, saved or not, or `ms`
 *  has gone, said in `log` (`renewal_drain_cut`, with how many were still out). So a refresh token OpenAI spent leaves
 *  its new pair saved, never lost to the close. A runner calls it once its loops are told to stop (Runner.close's
 *  `loopsStopping`), never before: a run its drain lets finish may need a renewal. */
export function stopRenewals(store: ChatGPTPlanDeps["store"], ms = RENEWAL_DRAIN_MS, log: (fields: Record<string, string>) => void = stderrLog): Promise<void> {
  const of = renewalsOf(store);
  of.stopping = true;
  of.drainEnds = Math.max(of.drainEnds ?? 0, Date.now() + ms);
  if (of.flights.size === 0) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const ended = Promise.allSettled([...of.flights]).then(() => true);
  return Promise.race([ended, new Promise<false>((done) => (timer = setTimeout(() => done(false), ms)))])
    .then((drained) => {
      if (!drained && of.flights.size > 0) log({ chatgpt: "renewal_drain_cut", out: String(of.flights.size) });
    })
    .finally(() => clearTimeout(timer));
}

/** A store fault's class for the log (one of the store's own, or Postgres's Unanswered, else "other"), never its words. */
const faultClass = (error: unknown): string => {
  const name = (error as Error | undefined)?.name;
  return typeof name === "string" && (/^Store[A-Za-z]+$/.test(name) || name === "Unanswered") ? name : "other";
};

/** A write that faulted with `error` and surely wrote nothing: the store refused it (busy) or rolled it back (past its
 *  deadline). Any other fault, Postgres's commit Unanswered first, may still land after it was told. */
const rolledBack = (error: unknown): boolean => error instanceof StoreBusy || error instanceof StoreDeadline;

/** `startedAt`: when it started (the clock's ms), which its hint counts from. `codeIn`: a code came back (the browser's
 *  return or a paste) and OpenAI is answering it: no hint, and a timeout says the exchange was cut off. `answered`: OpenAI
 *  answered the code with a credential, which is being kept: past the wait, so its end is no timeout. */
type Pending = { abort: AbortController; state: string; authorizeUrl: string; startedAt: number; expiresAt: number; paste: (url: string) => void; result: Promise<void>; timer: NodeJS.Timeout; codeIn?: boolean; answered?: boolean };

export interface ChatGPTPlanDeps {
  /** `settings`: where a server keeps its host id, for a sign-in. A runner's reader may be given a store with settings
   *  too (its whole store): it never signs in, and never settles (settleLeft). */
  readonly store: { readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "replaceIf" | "removeIf" | "clock">; readonly settings?: Pick<Settings, "putIfAbsent"> };
  readonly sealKey: Buffer;
  readonly now?: () => number;
  /** Told after a sign-in, a sign-out or an expiry changed the state. */
  readonly changed?: () => void | Promise<void>;
  readonly log?: (fields: Record<string, string>) => void;
}

/** The plan over one store: a server's (sign-in, sign-out, its reading) or a runner's (the token, per request). Its
 *  fields are #private and it prints as its state alone (util.inspect, JSON), so an environment that carries it (withPlan)
 *  never shows a token when logged. */
export class ChatGPTPlan implements PlanReader {
  #snapshot: Row | undefined;
  /** Moved on by each write of the snapshot (wrote: a sign-in kept, a renewal, an expiry, a sign-out): a read of the row
   *  that was out across one never takes its row over it (readTaken). */
  #writes = 0;
  /** Moved on by each read of the row as it starts (readTaken). */
  #reads = 0;
  /** The read whose row is the snapshot (its #reads at its start): an older read that answers after it never takes its
   *  row over it. */
  #takenRead = 0;
  #pending: Pending | undefined;
  /** An access token OpenAI refused (refused): token() renews rather than send it again. */
  #refusedAccess: string | undefined;
  /** Moved on by each sign-in started and each sign-out: a sign-in keeps its credential only while it is unmoved since it
   *  started, so a sign-out (or a newer sign-in) while it finishes wins. */
  #epoch = 0;
  /** Set when a sign-in dropped by a sign-out (keep) could not have its revocation confirmed by OpenAI: that sign-out
   *  answers revoked false. Cleared at each sign-out's start. */
  #droppedUnconfirmed = false;
  /** Why the last sign-in ended without signing in (signInFailure's words past its browser step, or its timeout), until a
   *  sign-in starts, finishes or a sign-out. A cancelled one leaves none. */
  #problem: string | undefined;
  /** Set when the server's change callback failed (tellChanged); cleared once one that started after it takes. */
  #changeOwed = false;
  /** Moved on by each change callback that fails: one that takes clears what is owed only if none failed since it began,
   *  so a change that read an earlier sign-in never clears a later one's. */
  #failedChanges = 0;
  /** The server's read in flight (refresh), which a read while it is out waits for. */
  #refreshing: Promise<void> | undefined;
  /** The last settle queued (settle): each waits for the one before it. */
  #settling: Promise<Settled> | undefined;
  /** The ends of the sign-ins cancelled and not yet ended, and the start's settle with the change it tells (settleLeft):
   *  close waits for them. */
  readonly #ending = new Set<Promise<void>>();
  /** Set by close(): no read queues a settle after it, so none outlives the server's stop. */
  #closed = false;
  /** When a read last queued a settle (refresh): a list OpenAI keeps failing is asked again at most once a minute,
   *  however often the console reads. */
  #readSettledAt = -Infinity;
  readonly #watchers = new Set<(tokens: string[]) => void>();
  readonly #deps: ChatGPTPlanDeps;
  constructor(deps: ChatGPTPlanDeps) {
    this.#deps = deps;
  }

  [inspect.custom](): string {
    return `ChatGPTPlan { state: '${this.state}' }`;
  }

  toJSON(): { state: PlanState } {
    return { state: this.state };
  }

  watch(listener: (tokens: string[]) => void): void {
    this.#watchers.add(listener);
    if (this.#snapshot) listener([this.#snapshot.credential.access, this.#snapshot.credential.refresh]);
  }

  /** Each token of `credential` joins this process's redaction, and every watcher's. */
  private hold(credential: Credential): void {
    holdSecret(credential.access, credential.refresh);
    for (const listener of this.#watchers) listener([credential.access, credential.refresh]);
  }

  /** This process's clock: what a token's own end (OpenAI's `expires_in`, counted here) is judged by. */
  private now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The store's clock: what a renewal lease is stamped and judged by, the same for every process on the store. */
  private storeNow(): Promise<number> {
    return this.#deps.store.sealedKeys.clock();
  }

  get state(): "signed_out" | "signed_in" | "expired" {
    return this.#snapshot?.state ?? "signed_out";
  }

  get models(): readonly string[] {
    return this.#snapshot?.models ?? [];
  }

  /** The row as sealed now, opened; none with none saved or one that does not open. */
  private async read(): Promise<Row | undefined> {
    return (await this.readSealed())?.row;
  }

  /** The row as sealed now, opened, with the bytes it was read as (what a compare-and-set on it compares). */
  private async readSealed(): Promise<{ row: Row; bytes: Uint8Array } | undefined> {
    const bytes = await this.#deps.store.sealedKeys.get(CHATGPT_PLAN_ROW);
    if (bytes === undefined) return undefined;
    const row = this.open(bytes);
    return row ? { row, bytes } : undefined;
  }

  /** The row as sealed now (readSealed), taken as the snapshot unless a write moved the snapshot while the read was out
   *  (a load or token() that read the row before a sign-in was kept, or before a sign-out removed it, leaves their state),
   *  or a read that started after it was taken first (reads that overlap can answer oldest last: the newest one's row,
   *  an expiry another process wrote, stays). */
  private async readTaken(): Promise<{ row: Row; bytes: Uint8Array } | undefined> {
    const writes = this.#writes;
    const started = ++this.#reads;
    const read = await this.readSealed();
    if (this.#writes === writes && started > this.#takenRead) {
      this.#snapshot = read?.row;
      this.#takenRead = started;
    }
    return read;
  }

  /** `row` as the snapshot, by a write that knows it is the row's latest (a sign-in kept, a renewal, a sign-out). */
  private wrote(row: Row | undefined): void {
    this.#snapshot = row;
    this.#writes += 1;
  }

  /** The row sealed as `bytes`, opened (its tokens held for redaction, and those of each pair it carries); none when they
   *  do not open. */
  private open(bytes: Uint8Array): Row | undefined {
    try {
      const row = JSON.parse(unsealColumn(this.#deps.sealKey, sealedAt.sealedKey(CHATGPT_PLAN_ROW), bytes).toString("utf8")) as Row;
      if (row?.v !== 1 || !row.credential?.access || !row.credential.refresh) return undefined;
      this.hold(row.credential);
      for (const old of row.retired ?? []) this.hold(old);
      return row;
    } catch {
      return undefined;
    }
  }

  /** `row` sealed as the store keeps it: fresh bytes at each seal. */
  private seal(row: Row): Uint8Array {
    return sealColumn(this.#deps.sealKey, sealedAt.sealedKey(CHATGPT_PLAN_ROW), JSON.stringify(row));
  }

  /** `row` saved only while the store still holds `was` (SealedKeys.replaceIf): the bytes it was saved as, or none when
   *  the row had changed. */
  private async swap(was: Uint8Array, row: Row): Promise<Uint8Array | undefined> {
    const bytes = this.seal(row);
    return (await this.#deps.store.sealedKeys.replaceIf(CHATGPT_PLAN_ROW, was, bytes)) ? bytes : undefined;
  }

  /** Reads the sealed row into the state a reader sees. Returns this. A read never settles (settleLeft). */
  async load(): Promise<this> {
    await this.readTaken();
    return this;
  }

  /** What a stop left in the row (a sign-in it cut off after its save: keep) settled, out of the caller's way: the
   *  server's, at its start once its first offers are made, and at a read of a row a reader renewed while it was still
   *  unlisted (refresh). Models it lists are told to the server (its change
   *  callback, as a sign-in's are), so the offers made from the fallback list are made again. A runner's reader
   *  (planReaderOf, at each claim) never calls it, so no runner lists the plan's models or sends a refresh token to
   *  OpenAI's revocation endpoint. */
  settleLeft(): void {
    // Its change callback is waited for by close(), as the settle is: the server never closes under a change it owes.
    const told = this.settle().then(({ listed }) => (listed ? this.tellChanged() : undefined));
    this.#ending.add(told);
    void told.then(() => this.#ending.delete(told));
  }

  view(): PlanView {
    if (this.#pending && this.#pending.expiresAt <= this.now()) this.expire();
    const row = this.#snapshot;
    const who = row ? { ...(row.email ? { email: row.email } : {}), ...(row.plan ? { plan: row.plan } : {}) } : {};
    if (this.#pending) {
      // Past its first minute with no code back, it says why it may be stuck. Once a code is in (the browser's return or a
      // paste), OpenAI is answering it, and one it answered is being kept: neither is stuck at OpenAI's page.
      const stuck = !this.#pending.codeIn && !this.#pending.answered && this.now() >= this.#pending.startedAt + HINT_AFTER_MS;
      return { state: "pending", authorize_url: this.#pending.authorizeUrl, expires_at: new Date(this.#pending.expiresAt).toISOString(), ...who, ...(stuck ? { hint: STILL_WAITING } : {}) };
    }
    const problem = this.#problem ? { problem: this.#problem } : {};
    if (!row) return { state: "signed_out", ...problem };
    return { state: row.state, ...who, ...(row.state === "signed_in" ? { models: [...row.models] } : {}), ...problem };
  }

  /** This server's id at OpenAI (its agent host id): a UUID made once and kept in the store's settings. Not a credential. */
  private async hostId(): Promise<string> {
    if (!this.#deps.store.settings) throw new Error("a ChatGPT sign-in starts on the server, which keeps its host id");
    const kept = await this.#deps.store.settings.putIfAbsent(HOST_ID_SETTING, randomUUID());
    if (typeof kept !== "string") throw new Error("this server's ChatGPT host id is not a UUID in its settings");
    return kept;
  }

  private cancel(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.abort.abort();
    const ended = pending.result.then(() => undefined, () => undefined);
    this.#ending.add(ended);
    void ended.then(() => this.#ending.delete(ended));
  }

  /** Ends the sign-in waiting past its 10 minutes: a cancel, which says nothing by itself, that says it timed out (with
   *  no admin guess when a code came back and its exchange was cut off). One whose code OpenAI answered is past waiting
   *  (it is being kept) and never times out. */
  private expire(): void {
    if (!this.#pending || this.#pending.answered) return;
    const codeIn = this.#pending.codeIn;
    this.cancel();
    this.#problem = codeIn ? CUT_OFF : TIMED_OUT;
    this.#deps.log?.({ chatgpt: "sign_in_failed", reason: "timed_out" });
  }

  /** Starts a sign-in (one at a time: a new start cancels the one waiting) and gives the address to open. It lasts 10
   *  minutes: the loopback callback finishes it where the browser runs on this machine; elsewhere finishSignIn does. */
  async startSignIn(): Promise<{ authorize_url: string; expires_at: string }> {
    // A sign-in still finishing drops its credential (keep): this one is the person's latest.
    const epoch = ++this.#epoch;
    const before = this.#pending;
    this.#problem = undefined;
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
      // pi-ai's progress note comes as a code is in, from the browser's return or a paste, before it asks OpenAI for tokens.
      notify: (event) => {
        if (event.type === "auth_url") linked(event.url);
        else if (event.type === "progress" && this.#pending?.abort === abort) this.#pending.codeIn = true;
      },
      prompt: (prompt) => (prompt.type === "manual_code" ? Promise.race([pasted, new Promise<string>((_, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true }))]) : Promise.reject(new Error("not asked here"))),
    }, { getDeviceId: () => hostId, agentName: AGENT_NAME });
    const settle = () => {
      if (this.#pending?.abort !== abort) return;
      clearTimeout(this.#pending.timer);
      this.#pending = undefined;
    };
    // Pending until the credential is kept or dropped, so a sign-out meanwhile cancels it (keep's epoch).
    const result = login.then((credential) => {
      if (this.#pending?.abort === abort) this.#pending.answered = true;
      return this.keep(credential as Credential, epoch, settle).catch((error: unknown) => {
        throw new NotKept("not kept", { cause: error });
      });
    }).finally(settle);
    // Past the browser step, the tab already says it completed: an end that is not a cancel (a newer start, a sign-out,
    // the wait's end, the server's close) says why in the view and the log, whichever way the address came back.
    let waiting = false;
    result.catch((error: unknown) => {
      if (!waiting || abort.signal.aborted || epoch !== this.#epoch) return;
      const { reason, words } = signInFailure(error);
      this.#problem = words;
      this.#deps.log?.({ chatgpt: "sign_in_failed", reason });
    });
    const authorizeUrl = await Promise.race([link, result.then(() => undefined, (error: unknown) => {
      throw new PlanSignInRefused(/in use/.test(String((error as Error)?.message)) ? "Another sign-in holds this machine's port 1455: finish or cancel it, then start again." : "The sign-in could not start: try again.");
    })]);
    if (!authorizeUrl) throw new PlanSignInRefused("The sign-in could not start: try again.");
    const startedAt = this.now();
    const expiresAt = startedAt + PENDING_MS;
    const timer = setTimeout(() => (this.#pending?.abort === abort ? this.expire() : undefined), PENDING_MS);
    timer.unref();
    this.#pending = { abort, state: new URL(authorizeUrl).searchParams.get("state") ?? "", authorizeUrl, startedAt, expiresAt, paste, result, timer };
    waiting = true;
    return { authorize_url: authorizeUrl, expires_at: new Date(expiresAt).toISOString() };
  }

  /** Finishes the sign-in waiting with the address its browser tab ended on, pasted. A URL that is not that sign-in's end
   *  is refused in words and the sign-in keeps waiting; one OpenAI refuses ends it. */
  async finishSignIn(redirectUrl: unknown): Promise<PlanView> {
    const pending = this.#pending && this.#pending.expiresAt > this.now() ? this.#pending : undefined;
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
    if (error) throw new PlanSignInRefused(deniedWords(tag(error)));
    if (url.searchParams.get("state") !== pending.state) throw new PlanSignInRefused("That address is from another sign-in: paste the one from the sign-in you started last, or start again.");
    if (!url.searchParams.get("code") || !url.searchParams.get("client_id")) throw new PlanSignInRefused(`That address has no sign-in code in it. ${shape}`);
    // A code is in from here (pi-ai's progress note says the same a moment later): a view meanwhile shows no hint.
    pending.codeIn = true;
    pending.paste(url.href);
    try {
      await pending.result;
    } catch (error) {
      // Cancelled while its code's exchange was out (a newer start, a sign-out, the 10 minutes): the log has no line of
      // it, so the words say what the view says, or that it was cancelled.
      if (pending.abort.signal.aborted) throw new PlanSignInRefused(this.#problem ?? "That sign-in was replaced or signed out: start it again.");
      throw new PlanSignInRefused(signInFailure(error).words);
    }
    return this.view();
  }

  /** A credential from the sign-in started at `epoch`, checked and sealed with what a view shows. A sign-out or a newer
   *  sign-in since then wins: the credential is dropped, never written, and revoked at OpenAI. It is saved before anything
   *  slow, so a stop that cuts it off never leaves its pair live at OpenAI and saved nowhere: a sign-in it takes the place
   *  of rides in the row (`retired`, with any it carried) until it is revoked, and its models are listed after (settle).
   *  The row is replaced only while it still holds what was read (a renewal that wrote back meanwhile is read and carried
   *  in turn), so no earlier pair is left alive and unsaved. */
  private async keep(credential: Credential, epoch: number, saved?: () => void): Promise<void> {
    if (credential.scopes && !credential.scopes.includes(DIRECT_SCOPE)) throw new Error(`the grant did not include ${DIRECT_SCOPE}`);
    this.hold(credential);
    let row: Row;
    for (;;) {
      if (epoch !== this.#epoch) {
        if (!(await this.revoke(credential))) this.#droppedUnconfirmed = true;
        return;
      }
      const was = await this.#deps.store.sealedKeys.get(CHATGPT_PLAN_ROW);
      const previous = was === undefined ? undefined : this.open(was);
      const retired = [...(previous?.retired ?? []), ...(previous && previous.credential.refresh !== credential.refresh ? [previous.credential] : [])];
      row = { v: 1, state: "signed_in", credential, ...whoOf(credential.access), models: [...PLAN_FALLBACK_MODELS], unlisted: true, ...(retired.length ? { retired } : {}) };
      if (epoch !== this.#epoch) continue;
      if (was === undefined) {
        // No row to compare against: only the server signs in, and nothing else makes the row (a runner's renewal
        // replaces one only while it holds its lease), so a plain write.
        await putSealedKey(this.#deps.store, this.#deps.sealKey, CHATGPT_PLAN_ROW, JSON.stringify(row));
        break;
      }
      if (await this.swap(was, row)) break;
    }
    this.wrote(row);
    this.#problem = undefined;
    this.#deps.log?.({ chatgpt: "signed_in" });
    // Saved: no longer waiting, so it reads signed in while it settles and the server takes the change (`saved`, the
    // sign-in's settle).
    saved?.();
    const { revoked: previousRevoked } = await this.settle();
    if (previousRevoked !== undefined) this.#deps.log?.({ chatgpt: "previous_revoked", revoked: String(previousRevoked) });
    await this.tellChanged();
  }

  /** What a saved sign-in leaves (keep), done: its models listed (`unlisted`), and each pair it carries (`retired`)
   *  revoked at OpenAI and dropped from the row once OpenAI confirms it. `revoked`: whether every carried pair was
   *  confirmed, none when the row carried none; `listed`: whether it wrote the models OpenAI listed. The server's alone,
   *  one at a time: only a sign-in (keep) and the server's start (settleLeft) settle, and a runner does neither. The row
   *  is written only while it holds what was read and no renewal's lease is live (a renewal writes back over the row it
   *  leased, and carries these fields); what is left stays for the server's next start. Never throws. */
  private settle(): Promise<Settled> {
    const run = (this.#settling ?? Promise.resolve({})).then(() => this.settleOnce()).catch((): Settled => ({}));
    this.#settling = run;
    void run.then(() => (this.#settling === run ? (this.#settling = undefined) : undefined));
    return run;
  }

  private async settleOnce(): Promise<Settled> {
    const read = await this.readSealed();
    if (!read || (!read.row.unlisted && !read.row.retired?.length)) return {};
    const signedIn = read.row.credential.refresh;
    // The list is asked only with a token OpenAI takes (fresh). One that has ended is never renewed here: a renewal can
    // outlast the server's stop, which would spend the refresh token and lose the new pair with the store closed. The row
    // stays unlisted, and the first settle after a reader renewed it (a run's token()) lists.
    const models = read.row.unlisted && read.row.state === "signed_in" && this.fresh(read.row) ? await this.listModels(read.row.credential.access) : undefined;
    const confirmed = new Set<string>();
    for (const old of read.row.retired ?? []) if (await this.revoke(old)) confirmed.add(old.refresh);
    const revoked = read.row.retired?.length ? confirmed.size === read.row.retired.length : undefined;
    const done: Settled = revoked === undefined ? {} : { revoked };
    for (;;) {
      const now = await this.readSealed();
      // Signed out meanwhile: the sign-out revoked what the row held.
      if (!now) return done;
      if (now.row.lease && now.row.lease.until > (await this.storeNow())) return done;
      const { unlisted, retired: carried, ...rest } = now.row;
      const retired = (carried ?? []).filter((old) => !confirmed.has(old.refresh));
      // The models listed are this sign-in's: a newer sign-in's row lists its own.
      const listed = Boolean(unlisted && models && now.row.credential.refresh === signedIn);
      const next: Row = { ...rest, ...(listed && models ? { models } : unlisted ? { unlisted } : {}), ...(retired.length ? { retired } : {}) };
      if (!listed && retired.length === (carried ?? []).length) return done;
      const bytes = await this.swap(now.bytes, next);
      if (bytes) {
        this.wrote(next);
        return { ...done, listed };
      }
    }
  }

  /** Tells the server the sign-in changed (its change callback: env read again, the listings relisted, the offers
   *  probed). What the server does with it is not the change's to fail: a failure is owed, said in the log (once: not
   *  again for `again`, a retry of one owed), and taken again at the server's next read (refresh). */
  private async tellChanged(again = false): Promise<void> {
    const failed = this.#failedChanges;
    try {
      await this.#deps.changed?.();
      if (this.#failedChanges === failed) this.#changeOwed = false;
    } catch (error) {
      this.#failedChanges += 1;
      this.#changeOwed = true;
      if (again) return;
      const code = (error as { code?: unknown })?.code;
      this.#deps.log?.({ chatgpt: "changed_failed", reason: tag(typeof code === "string" ? code : (error as Error)?.name) || "error" });
    }
  }

  /** The sign-in as the store holds it now, read at the server's read of it: a runner may have renewed it, found it
   *  expired, or another server signed in or out. A change is told to the server, and so is one it failed to take, so
   *  what it offers does not wait for a restart. One at a time: a read while one is out waits for that one (the console
   *  polls, and each change relists and probes). */
  refresh(): Promise<void> {
    // Cleared in a reaction, never inside the function: a read that throws at once would run a `finally` there before
    // the assignment, and leave a settled promise in flight for good.
    return (this.#refreshing ??= (async () => {
      const was = this.state;
      if ((await this.load()).state !== was) await this.tellChanged();
      else if (this.#changeOwed) await this.tellChanged(true);
      // A row still on the fallback list whose token a reader renewed lists now, not at the next start: a settle queued
      // as the start's is (settleLeft), with the token as read and no renewal, one at a time, at most once a minute, none
      // after close().
      const row = this.#snapshot;
      if (row?.unlisted && row.state === "signed_in" && this.fresh(row) && !this.#settling && !this.#closed && this.now() - this.#readSettledAt >= 60_000) {
        this.#readSettledAt = this.now();
        this.settleLeft();
      }
    })().finally(() => (this.#refreshing = undefined)));
  }

  /** The plan's models from OpenAI's list (GET /v1/models with the token), those of the current families (the fallback
   *  list when it names none); none when the list can't be read, so the row stays `unlisted`. */
  private async listModels(token: string): Promise<string[] | undefined> {
    try {
      const response = await fetch(`${PLAN_ORIGIN}/v1/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string" && /^gpt-6(?:[.-]|$)/.test(id));
      return ids.length ? [...new Set(ids)] : [...PLAN_FALLBACK_MODELS];
    } catch {
      return undefined;
    }
  }

  /** The access token to send now: the sealed one, renewed first when it ends within 5 minutes. Throws PlanUnavailable,
   *  in words, when there is none. */
  async token(): Promise<string> {
    const row = (await this.readTaken())?.row;
    if (!row) throw new PlanUnavailable(SIGNED_OUT);
    if (row.state === "expired") throw new PlanUnavailable(EXPIRED);
    if (this.fresh(row)) return row.credential.access;
    // One renewal per refresh token in this process; across processes, the row's lease (renew).
    const key = row.credential.refresh;
    let flight = flights.get(key);
    if (!flight) {
      // Its store stopping: a renewal started now could spend the refresh token and lose the pair with the store closed.
      if (this.stopping()) return this.asItIs(row);
      const ours = renewalsOf(this.#deps.store).flights;
      const started: Promise<string> = this.renew(key).finally(() => {
        flights.delete(key);
        ours.delete(started);
      });
      flight = started;
      flights.set(key, flight);
      ours.add(flight);
    }
    return flight;
  }

  /** Whether this plan starts no renewal: it is closed (the server's, at its stop), or its store's stop began here
   *  (stopRenewals: every reader on it, a runner's included). */
  private stopping(): boolean {
    return this.#closed || renewalsOf(this.#deps.store).stopping;
  }

  /** While its store stops (no renewal starts): `row`'s access token as it is when it outlives the rest of the stop's drain
   *  plus RENEWAL_DRAIN_MS (a run its drain lets go on sends it no later than that) and OpenAI has not refused it here;
   *  else PlanStopping, so a run that needs it renewed is handed back (handingBack) rather than failed. A plan closed with
   *  no stop of its store counts a whole drain. */
  private asItIs(row: Row): string {
    const ends = renewalsOf(this.#deps.store).drainEnds;
    const left = ends === undefined ? RENEWAL_DRAIN_MS : Math.max(0, ends - Date.now());
    if (row.credential.access !== this.#refusedAccess && row.credential.expires - this.now() > left + RENEWAL_DRAIN_MS) return row.credential.access;
    throw new PlanStopping(RENEW_LATER);
  }

  /** Whether `row`'s access token may be sent as it is: OpenAI has not refused it here, and it has more than 5 minutes left. */
  private fresh(row: Row): boolean {
    return row.credential.access !== this.#refusedAccess && row.credential.expires - this.now() > REFRESH_MARGIN_MS;
  }

  /** OpenAI answered 401 to `sent`: the row read again, and the next token() renews it only when the row still holds
   *  `sent` (another holder that renewed already has put a new one there, which is sent instead). */
  async refused(sent: string): Promise<void> {
    const row = await this.read();
    if (row?.state === "signed_in" && row.credential.access === sent) this.#refusedAccess = sent;
  }

  /** Renews the sign-in whose refresh token is `seen`, for any process that holds the store and the seal key (the server,
   *  each runner). A refresh token is spent at its use, and one used twice makes OpenAI revoke the whole sign-in, so one
   *  holder at a time takes a lease on the row (a compare-and-set on its sealed bytes) before it spends the token. The
   *  others adopt the pair it writes back: meanwhile they send the current token while it has not ended, and wait for the
   *  new pair once it has. A lease whose holder died lapses after REFRESH_LEASE_MS, and the next reader takes it. The
   *  lease's end is stamped and judged on the store's clock, so a process whose own clock runs ahead never takes one
   *  still live. */
  private async renew(seen: string): Promise<string> {
    const holder = randomUUID();
    const giveUp = this.now() + REFRESH_LEASE_MS + REFRESH_CALL_MS;
    for (;;) {
      const read = await this.readTaken();
      if (!read) throw new PlanUnavailable(SIGNED_OUT);
      const { row, bytes } = read;
      if (row.state === "expired") throw new PlanUnavailable(EXPIRED);
      // A peer renewed it since: its pair is the row's now.
      if (row.credential.refresh !== seen && this.fresh(row)) return row.credential.access;
      const at = await this.storeNow();
      if (row.lease && row.lease.until > at) {
        if (row.credential.access !== this.#refusedAccess && row.credential.expires > this.now()) return row.credential.access;
        // Past the bound, or its server stopping: a wait on another holder's renewal never holds a stop's drain.
        if (this.stopping()) return this.asItIs(row);
        if (this.now() > giveUp) throw new PlanUnavailable(RENEW_LATER);
        await sleep(LEASE_WAIT_MS);
        continue;
      }
      // Its store's stop began while it read: no lease is taken, so no refresh token is spent past the stop.
      if (this.stopping()) return this.asItIs(row);
      const leased: Row = { ...row, lease: { holder, until: at + REFRESH_LEASE_MS } };
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
    // Its store's stop began while the lease was taken (a write that can take the store's whole deadline): the refresh
    // token is never sent past the stop, so the drain waits only on refreshes sent before it, and the lease goes back.
    if (this.stopping()) {
      await this.swap(bytes, bare).catch(() => undefined);
      return this.asItIs(bare);
    }
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
        this.wrote(expired);
        this.#deps.log?.({ chatgpt: "expired" });
        await this.tellChanged();
        throw new PlanUnavailable(EXPIRED);
      }
      return this.adopt();
    }
    const renewed: Row = { ...bare, credential: { ...bare.credential, ...next } };
    this.hold(renewed.credential);
    let saved: Uint8Array | undefined;
    try {
      saved = await this.swap(bytes, renewed);
    } catch (error) {
      // The write back faulted. Refused unsent (the store closed): no row holds the new pair, so it is revoked, never
      // left live and saved nowhere. Any other fault (busy, a deadline): the row read back says how it ended.
      if (error instanceof StoreClosed) {
        // Said before the revocation, which a process's exit may cut short: never a pair lost with no line.
        this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", write: "refused" });
        await this.revoke(renewed.credential);
        throw new PlanUnavailable(RENEW_LATER);
      }
      saved = await this.readBack(bytes, renewed, error);
    }
    if (saved) {
      this.wrote(renewed);
      return renewed.credential.access;
    }
    // The owner signed out or in again while OpenAI renewed it: the new pair is the sign-in's no longer, and no one
    // holds it but this renewal, so it is revoked here, never handed out. One OpenAI doesn't confirm is carried.
    if (!(await this.revoke(renewed.credential))) await this.carry(renewed.credential);
    return this.adopt();
  }

  /** A write back of `renewed` over this holder's lease (sealed as `leased`) that faulted with `fault`, not StoreClosed:
   *  the row read back says how it ended. It holds the new pair: saved (its bytes). It is still the lease: nothing has
   *  landed yet, so it is written again. Anything else: the lease lost (none), as a compare-and-set that lost. A write
   *  again that loses: the first may have landed late (a Postgres commit unanswered, finishing after the read; the write
   *  again waited on its row lock, so it has ended now), and the row read once more says which. A write again refused
   *  unsent (the store closed): revoked only when the first surely wrote nothing (rolledBack). Only a read back or a write
   *  again that faults otherwise, or a first that may still land, leaves the outcome unknown: the row may hold the pair,
   *  so it is kept, never revoked, and the log says so with the fault's class (never its words). */
  private async readBack(leased: Uint8Array, renewed: Row, fault: unknown): Promise<Uint8Array | undefined> {
    const unknown = (error: unknown): never => {
      this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", write: "unknown", reason: faultClass(error) });
      throw new PlanUnavailable(RENEW_LATER);
    };
    let now: { row: Row; bytes: Uint8Array } | undefined;
    try {
      now = await this.readSealed();
    } catch {
      return unknown(fault);
    }
    if (now?.row.credential.refresh === renewed.credential.refresh) return now.bytes;
    if (!now || !Buffer.from(now.bytes).equals(Buffer.from(leased))) return undefined;
    let again: Uint8Array | undefined;
    try {
      again = await this.swap(leased, renewed);
    } catch (error) {
      if (!(error instanceof StoreClosed)) return unknown(error);
      if (!rolledBack(fault)) return unknown(fault);
      this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", write: "refused" });
      await this.revoke(renewed.credential);
      throw new PlanUnavailable(RENEW_LATER);
    }
    if (again) return again;
    let last: { row: Row; bytes: Uint8Array } | undefined;
    try {
      last = await this.readSealed();
    } catch (error) {
      return unknown(error);
    }
    return last?.row.credential.refresh === renewed.credential.refresh ? last.bytes : undefined;
  }

  /** A pair this holder got and could not save (a renewal whose write back lost: renewUnder), whose revocation OpenAI
   *  didn't confirm: carried in the row (`retired`), for the server's next settle to revoke, as a replaced sign-in's pair
   *  is (keep). Never written over another holder's live lease (its write back would lose in turn): it waits for that
   *  write back, or for the lease to lapse, as a renewal waits on one (renew), and gives up only past that bound, said in
   *  the log. None with no row (a sign-out says OpenAI's word is not the whole answer while a renewal is out). */
  private async carry(credential: Credential): Promise<void> {
    const giveUp = this.now() + REFRESH_LEASE_MS + REFRESH_CALL_MS;
    for (;;) {
      let now: { row: Row; bytes: Uint8Array } | undefined;
      try {
        now = await this.readSealed();
      } catch (error) {
        // The store closed or faulted: the pair is carried nowhere, said by its fault's class.
        this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", carry: "store", fault: faultClass(error) });
        return;
      }
      if (!now) {
        // Signed out meanwhile: no row to carry it in (the sign-out says OpenAI's word is not the whole answer).
        this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", carry: "signed_out" });
        return;
      }
      if (now.row.lease && now.row.lease.until > (await this.storeNow())) {
        // Past the bound, or its store stopping (a wait here would outlast the stop's drain).
        if (this.now() > giveUp || this.stopping()) {
          this.#deps.log?.({ chatgpt: "renewed_pair_unsaved", carry: this.stopping() ? "stopping" : "lease_held" });
          return;
        }
        await sleep(LEASE_WAIT_MS);
        continue;
      }
      const next: Row = { ...now.row, retired: [...(now.row.retired ?? []), credential] };
      if (await this.swap(now.bytes, next)) {
        this.wrote(next);
        return;
      }
    }
  }

  /** After a renewal whose write back lost its compare-and-set (the owner signed out or in again meanwhile): its result
   *  is dropped, and the row's state wins. */
  private async adopt(): Promise<string> {
    const now = (await this.readTaken())?.row;
    if (!now) throw new PlanUnavailable(SIGNED_OUT);
    if (now.state === "expired") throw new PlanUnavailable(EXPIRED);
    if (this.fresh(now)) return now.credential.access;
    throw new PlanUnavailable(RENEW_LATER);
  }

  /** Signs out: any sign-in waiting cancelled (one past its browser step waited for: it drops and revokes its credential),
   *  then the row removed only while it still holds the bytes read (SealedKeys.removeIf; a renewal that wrote back
   *  meanwhile is read and removed in turn), and the pair it held revoked at OpenAI (its documented revocation endpoint,
   *  with the refresh token). The row goes whatever the revocation says. `revoked`: nothing of the sign-in is left alive
   *  at OpenAI as far as it can tell: none was signed in, or OpenAI confirmed the revocation and no renewal was out under
   *  a live lease (that renewal revokes the pair it gets when its write back finds the row gone, but OpenAI's word on it
   *  is not this answer's to give). */
  async signOut(): Promise<{ revoked: boolean }> {
    this.#droppedUnconfirmed = false;
    this.#problem = undefined;
    this.#epoch += 1;
    const finishing = this.#pending;
    this.cancel();
    await finishing?.result.catch(() => undefined);
    // A sign-in past its browser step, dropped by this sign-out (keep), whose revocation OpenAI didn't confirm.
    let revoked = !this.#droppedUnconfirmed;
    for (;;) {
      const bytes = await this.#deps.store.sealedKeys.get(CHATGPT_PLAN_ROW);
      if (bytes === undefined) break;
      const row = this.open(bytes);
      const renewing = row?.lease !== undefined && row.lease.until > (await this.storeNow());
      if (!(await this.#deps.store.sealedKeys.removeIf(CHATGPT_PLAN_ROW, bytes))) continue;
      // A row that does not open (sealed under another key) is removed, its tokens beyond reach to revoke.
      const removed = row ? (await this.revoke(row.credential)) && !renewing : false;
      // The pairs of the sign-ins it replaced that it still carries (keep, settle) go with it.
      let carried = true;
      for (const old of row?.retired ?? []) carried = (await this.revoke(old)) && carried;
      revoked = revoked && removed && carried;
      break;
    }
    this.wrote(undefined);
    this.#deps.log?.({ chatgpt: "signed_out", revoked: String(revoked) });
    await this.tellChanged();
    return { revoked };
  }

  /** `credential`'s session revoked at OpenAI (its documented revocation endpoint, with the refresh token): whether OpenAI
   *  confirmed it. The endpoint is taken from OpenAI's discovery document only when it is https on auth.openai.com, so a
   *  refresh token goes nowhere else. Never throws. */
  private async revoke(credential: Credential): Promise<boolean> {
    try {
      const config = (await (await fetch(OPENID_CONFIGURATION, { signal: AbortSignal.timeout(5_000) })).json()) as { revocation_endpoint?: unknown };
      const endpoint = typeof config.revocation_endpoint === "string" ? new URL(config.revocation_endpoint) : undefined;
      if (endpoint?.protocol !== "https:" || endpoint.host !== new URL(OPENID_CONFIGURATION).host) return false;
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId }), signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Stops the sign-in waiting, at the server's close. Resolves once every sign-in cancelled (by this, a newer start, a
   *  sign-out or its 10 minutes) has ended, whatever its end said in the log. From here this plan (the server's) starts
   *  no renewal; one already out is waited for by its store's stop (stopRenewals). */
  close(): Promise<void> {
    this.#closed = true;
    this.cancel();
    // A settle out (the start's, a kept sign-in's) is waited for too: the server's stop bounds the wait (planClosed), and
    // what it cuts off stays in the row for the next start.
    return Promise.all([...this.#ending, this.#settling]).then(() => undefined);
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
  // A run's own process holds no seal key: its runner's reader, for a claim whose models reach the plan (held.ts).
  if (!sealKey) return held()?.plan();
  const plan = await new ChatGPTPlan({ store, sealKey, log: stderrLog }).load();
  return plan.state === "signed_out" ? undefined : plan;
}
