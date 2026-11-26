// What a person reads when a computer's provider (or the run's disk's, Archil) fails: serve's words, never the
// provider's. A provider's error text can carry a host path, a vendor's JSON, a request id or a key-shaped string; none of
// it is anything a person can act on, and some of it is this machine's. So every site where a provider's failure reaches
// a person (a run's failure words at its claim, a tool result that reports its computer's failure, the console's read of a
// run's files) says it through this one mapper: the error is sorted into one of five classes, each with one fixed
// sentence that names the provider by its product name and what the person can do, and the provider's own words go to
// one runner log line, with the run's id and the site. The secrets redaction stays as a second layer on that line, and
// the run's own redactor still cuts the words.
//
// The class is read from the error's structure first: the computer package's code (ComputerError.code), Node's code for a
// socket that could not be opened, or an HTTP status the error carries. Text is read only when the structure says
// nothing (no code, or the vendor's own failure, code vendor), through the one table below. Nothing read means "other",
// and "other" is said in its own words, never the provider's.
//
// A tool's own result is not a provider error: a shell's stdout and stderr, a file read's error about the agent's own
// path, a program's exit. Those are the agent's working material and pass as they are.
import type { ComputerErrorCode } from "@parcha/agentrun-computer";
import { redactSecrets } from "../learn/secrets.js";

/** The five things a provider's failure can be, for a person: its key refused; its account out of quota or credit;
 *  the provider down or not reached; the machine refused or gone; anything else. */
export type ProviderErrorClass = "key" | "quota" | "down" | "machine" | "other";

/** Where a provider's failure is said: the provider by its product name (its descriptor's label: "Docker", "E2B",
 *  "Archil"), the kind of thing it failed to give ("sandbox", "desktop", "disk"), and the site (a short tag the runner
 *  log line names: "claim", "lost", "files"). */
export type ProviderAt = { readonly provider: string; readonly kind: string; readonly site: string };

/** A failure sorted and said: its class, and serve's sentence for it. */
export type ProviderSaid = { readonly class: ProviderErrorClass; readonly words: string };

/** The one fixed sentence per class, in serve's voice: what happened, then what the person can do. */
const WORDS: Readonly<Record<ProviderErrorClass, (provider: string, kind: string) => string>> = {
  key: (provider) => `${provider} refused its key. Check the ${provider} key in Settings.`,
  quota: (provider) => `${provider} says the account is out of quota or credit. Check the ${provider} account's plan and billing, then try again.`,
  down: (provider) => `${provider} couldn't be reached. Try again, or pick another place in Settings.`,
  machine: (provider, kind) => `${provider} refused the ${kind}, or no longer has it. Try again, and a new one starts.`,
  other: (provider) => `${provider} answered with an error. The server log has the details.`,
};

/** The class each structured code reads as: the computer package's codes, and Node's for a socket not opened. A code
 *  not here (vendor, invalid, unsupported, aborted, ...) says nothing by itself. */
const CODE_CLASS: Readonly<Record<string, ProviderErrorClass>> = {
  denied: "key",
  unauthorized: "key",
  limit: "quota",
  unreachable: "down",
  timeout: "down",
  ECONNREFUSED: "down",
  ECONNRESET: "down",
  ENOTFOUND: "down",
  ETIMEDOUT: "down",
  EHOSTUNREACH: "down",
  ENETUNREACH: "down",
  EAI_AGAIN: "down",
  gone: "machine",
  not_found: "machine",
  refused: "machine",
  stale: "machine",
};

/** The class an HTTP status reads as, or undefined. */
function statusClass(status: number): ProviderErrorClass | undefined {
  if (status === 401 || status === 403) return "key";
  if (status === 402 || status === 429) return "quota";
  if (status === 404 || status === 410) return "machine";
  if (status >= 500 && status <= 599) return "down";
  return undefined;
}

/** The one table text is read by, in order, where the structure says nothing. */
const TEXT_CLASSES: readonly (readonly [ProviderErrorClass, RegExp])[] = [
  ["key", /\b(?:unauthori[sz]ed|forbidden|not authenticated|authentication failed|invalid (?:api )?(?:key|token)|(?:api )?(?:key|token) (?:is )?(?:invalid|expired|revoked)|expired (?:key|token)|401|403)\b/i],
  ["quota", /\b(?:quota|billing|insufficient|credits?|payment required|rate limit(?:ed)?|too many requests|402|429)\b/i],
  ["down", /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|timed out|unreachable|service unavailable|bad gateway|gateway timeout|cannot connect to the docker daemon|docker daemon is not running|50[0234])\b/i],
  ["machine", /\b(?:does not match|not found|no such (?:container|sandbox|machine|computer)|was deleted|no longer has it|404|410)\b/i],
];

const fieldOf = (error: unknown, name: string): unknown => (typeof error === "object" && error !== null ? (error as Record<string, unknown>)[name] : undefined);

/** The class `error`'s structure says: its code, else an HTTP status it carries (status, statusCode, or its response's
 *  status); undefined where it says nothing. */
function structureClass(error: unknown): ProviderErrorClass | undefined {
  const code = fieldOf(error, "code");
  if (typeof code === "string" && Object.hasOwn(CODE_CLASS, code)) return CODE_CLASS[code];
  for (const status of [fieldOf(error, "status"), fieldOf(error, "statusCode"), fieldOf(fieldOf(error, "response"), "status")]) {
    if (typeof status === "number") {
      const said = statusClass(status);
      if (said) return said;
    }
  }
  return undefined;
}

/** The provider's own words in `error`: its message, or the text it is. */
export const providerText = (error: unknown): string => (error instanceof Error ? error.message : typeof fieldOf(error, "message") === "string" ? (fieldOf(error, "message") as string) : String(error));

/** The class of a provider's failure: from its structure first, its text only where that says nothing; "other" where
 *  neither does. */
export function providerErrorClass(error: unknown): ProviderErrorClass {
  const structured = structureClass(error);
  if (structured) return structured;
  const text = providerText(error);
  return TEXT_CLASSES.find(([, words]) => words.test(text))?.[0] ?? "other";
}

/** A provider's failure in serve's words: its class and that class's one sentence, naming `at.provider`. Never a word of
 *  the provider's own. */
export function providerErrorWords(error: unknown, at: Pick<ProviderAt, "provider" | "kind">): ProviderSaid {
  const sorted = providerErrorClass(error);
  return { class: sorted, words: WORDS[sorted](at.provider, at.kind) };
}

/** The one runner log line a provider's failure leaves: `run <id> <site>: <class>: <provider's words>`, the words cut of
 *  every secret shape and of `secrets` (the provider's keys, where the site holds them). */
export function providerErrorLine(runId: string, site: string, sorted: ProviderErrorClass, error: unknown, secrets: readonly string[] = []): string {
  return `run ${runId} ${site}: ${sorted}: ${redactSecrets(providerText(error), secrets, Number.POSITIVE_INFINITY)}`;
}

/** Where a site says a provider's failure: the run (its id, for the log line), the runner's log, and the keys to cut. */
export type ProviderTell = { readonly runId: string; readonly log: (line: string) => void; readonly secrets?: readonly string[] };

/** A provider's failure at `at` said: its provider's words on one runner log line (providerErrorLine), and its class and
 *  serve's sentence answered (providerErrorWords). */
export function providerFailed(error: unknown, at: ProviderAt, tell: ProviderTell): ProviderSaid {
  const said = providerErrorWords(error, at);
  tell.log(providerErrorLine(tell.runId, at.site, said.class, error, tell.secrets));
  return said;
}

/** Marks an error whose words are serve's own (a refusal that names its fix, a contract's words), so a site that says a
 *  provider's failure passes them as they are. */
const OWN = Symbol.for("agentrun.serve.ownWords");

/** The codes serve's own errors carry: a computer refused in words that name the fix, a cap reached, a claim lost. */
const OWN_CODES: ReadonlySet<unknown> = new Set(["computer_unavailable", "spend_cap_reached", "claim_lost"]);

/** An error in serve's own words. */
export function ownWords(words: string): Error {
  return asOwnWords(new Error(words));
}

/** `error`, marked as in serve's own words: one whose message a site already made of the mapper's sentence, so a later
 *  site passes it as it is, neither sorting nor logging it again. */
export function asOwnWords<E extends Error>(error: E): E {
  Object.defineProperty(error, OWN, { value: true });
  return error;
}

/** The computer package's code that says each class again (a Result a store answers, the class sorted already), so a
 *  later site sorts it the same. */
export const CLASS_CODE: Readonly<Record<ProviderErrorClass, ComputerErrorCode>> ={ key: "denied", quota: "limit", down: "unreachable", machine: "gone", other: "vendor" };

/** Whether `error`'s words are serve's own (ownWords, or one of serve's own codes), not a provider's. */
export const isOwnWords = (error: unknown): error is Error =>
  error instanceof Error && ((error as unknown as Record<symbol, unknown>)[OWN] === true || OWN_CODES.has((error as { code?: unknown }).code));

/** Marks an error a provider answered (a computer package Result's failure, thrown): a step that mixes a provider's
 *  calls with serve's own (its store, its holds) tells the two apart by it. */
const PROVIDER = Symbol.for("agentrun.serve.providerFailure");

/** A provider's failure (a Result's error) as an error: its words and its code, marked as the provider's. */
export function providerError(error: { readonly code: string; readonly message: string }): Error {
  const thrown = Object.assign(new Error(error.message), { code: error.code });
  Object.defineProperty(thrown, PROVIDER, { value: true });
  return thrown;
}

/** Whether `error` is a provider's failure (providerError). */
export const isProviderError = (error: unknown): boolean => error instanceof Error && (error as unknown as Record<symbol, unknown>)[PROVIDER] === true;

/** `error` in new words (`words`): its code kept, and whether its words are serve's own or a provider's, so the new
 *  error is sorted and said as `error` would be. `ownUnlessProvider`: an error neither marks (serve's store, a hold) is
 *  taken as serve's own, where the step that failed holds only serve's calls and the provider's (marked). */
export function reworded(error: unknown, words: string, ownUnlessProvider = false): Error {
  const provider = isProviderError(error);
  const own = !provider && ((error as Record<symbol, unknown> | null)?.[OWN] === true || ownUnlessProvider);
  const again = new Error(words);
  if (own) asOwnWords(again);
  if (provider) Object.defineProperty(again, PROVIDER, { value: true });
  const code = fieldOf(error, "code");
  return code === undefined ? again : Object.assign(again, { code });
}
