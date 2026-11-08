// A run's desktop or phone, as its owner watches and takes it: GET /v2/runs/{id}/computer, POST .../computer/take-over and
// POST .../computer/hand-back. Owner-only, as a run's browser is (its viewer is a full-control credential for the
// computer): the owner's password session in the console, never a token.
//
// The view is the provider's own live stream of the screen (the computer module's provider.stream()), view-only while
// the agent works; a take-over gives the owner a stream that drives, and parks the run's screen, input and phone tools
// (workspace/computer-hold.ts) until the hand-back, which gives the computer back to the agent. The browser keeps its own
// routes (GET /v2/runs/{id}/browser, its loopback viewer); a run whose computer is a browser, a sandbox or none has no
// computer here.
//
// Where a run's computer is: the process that holds the run's claim registers it (registerRunComputer) once its computer
// is up, and lets it go at the run's end; these routes answer from that register.
import { ApiError, invalid } from "./errors.js";
import { unknownFields } from "./validate.js";
import { type ComputerHold, HOLD_MAX_MS } from "./workspace/computer-hold.js";

/** The kinds of computer these routes show: a screen a person can watch and take. */
export type ViewedKind = "desktop" | "phone";

/** A run's desktop or phone, as the routes reach it. */
export type RunComputer = {
  readonly kind: ViewedKind;
  /** The provider's live stream of the screen: view-only, or one that drives. Undefined when the provider has none. */
  readonly stream?: (options: { readonly viewOnly: boolean }) => Promise<{ readonly url: string; readonly expiresAt?: Date } | undefined>;
  /** The person's hold on it. */
  readonly hold: ComputerHold;
  /** Whether the computer is up now (false once it ended or failed). */
  live(): boolean;
};

/** What GET /v2/runs/{id}/computer answers. */
export type ComputerView = {
  readonly kind: ViewedKind | null;
  /** live: up, and watchable (or taken); none: the run has a desktop or phone that is not up now; off: it has none. */
  readonly state: "live" | "none" | "off";
  /** Whether the owner holds it now, and until when it goes back to the agent on its own. */
  readonly taken_over: boolean;
  readonly taken_until?: string;
  readonly viewer: { readonly url: string } | null;
};

const computers = new Map<string, RunComputer>();

/** Run `runId`'s computer is up (from the process that holds the run's claim): the routes show it until it is let go. */
export function registerRunComputer(runId: string, computer: RunComputer): () => void {
  computers.set(runId, computer);
  return () => {
    if (computers.get(runId) !== computer) return;
    computer.hold.give("ended");
    computers.delete(runId);
  };
}

/** Run `runId`'s registered computer, when there is one. */
export const runComputerOf = (runId: string): RunComputer | undefined => computers.get(runId);

/** The run read's computer state, with the owner's hold: "taken_over" while they hold it, else the state given. */
export function computerStateOf<S extends string>(runId: string, state: S): S | "taken_over" {
  return computers.get(runId)?.hold.state().held ? "taken_over" : state;
}

/** The routes' names in serve's route table: each takes the owner's password session, never a token. */
export const COMPUTER_ROUTES: ReadonlySet<string> = new Set(["getRunComputer", "takeOverRunComputer", "handBackRunComputer"]);

/** Why a computer route refused, as an ApiError's code and words. */
export type ViewRefusal = { readonly code: "not_found" | "computer_not_live"; readonly message: string };

const viewerOf = async (computer: RunComputer, viewOnly: boolean): Promise<{ url: string } | null> => {
  const stream = await computer.stream?.({ viewOnly });
  return stream ? { url: stream.url } : null;
};

/** GET /v2/runs/{id}/computer. `hasComputer`: whether the run's setting asks for a desktop or a phone (off when not). */
export async function readComputer(runId: string, hasComputer: { readonly kind: ViewedKind } | undefined): Promise<ComputerView> {
  const computer = computers.get(runId);
  if (!computer || !computer.live()) {
    return { kind: computer?.kind ?? hasComputer?.kind ?? null, state: computer || hasComputer ? "none" : "off", taken_over: false, viewer: null };
  }
  const held = computer.hold.state();
  return {
    kind: computer.kind, state: "live", taken_over: held.held,
    ...(held.held ? { taken_until: new Date(held.until).toISOString() } : {}),
    viewer: await viewerOf(computer, !held.held),
  };
}

/** POST .../computer/take-over: the owner holds the computer, the run's screen and input tools park, and the answer's
 *  viewer drives. Taking one already held is the same answer. */
export async function takeOver(runId: string): Promise<ComputerView | ViewRefusal> {
  const computer = computers.get(runId);
  if (!computer) return { code: "not_found", message: "this run has no desktop or phone up to take over (a browser is taken over from GET /v2/runs/{id}/browser)" };
  if (!computer.live()) return { code: "computer_not_live", message: `this run's ${computer.kind} is not up now, so there is nothing to take over` };
  computer.hold.take();
  return readComputer(runId, undefined);
}

/** POST .../computer/hand-back: the computer goes back to the agent; its parked calls go on. Handing back one nobody
 *  holds is the same answer. */
export async function handBack(runId: string): Promise<ComputerView | ViewRefusal> {
  const computer = computers.get(runId);
  if (!computer) return { code: "not_found", message: "this run has no desktop or phone up to hand back" };
  computer.hold.give("given");
  return readComputer(runId, undefined);
}

/** The longest a take-over lasts with no hand-back, in minutes, for the API's words. */
export const TAKE_OVER_MINUTES = HOLD_MAX_MS / 60_000;

/** How a request to one of the routes came: by the owner's signed-in page, or with a token; whether this server has
 *  accounts (for the refusal's words); its body, for a POST. */
export type ComputerRequest = { readonly ownerSession: boolean; readonly token: boolean; readonly accounts: boolean; readonly body?: unknown };

/**
 * One of the routes (COMPUTER_ROUTES, by its name in serve's route table) for run `runId`: the answer, or an ApiError.
 * A token is refused (forbidden): the view drives the computer once taken over, so it takes the owner's signed-in page,
 * as a run's browser does. A POST takes an empty body. Serve's dispatch sends what this answers.
 */
export async function computerRoute(name: string, runId: string, request: ComputerRequest): Promise<ComputerView> {
  if (!request.ownerSession && request.token) {
    throw new ApiError("forbidden", request.accounts ? "A run's computer view takes the owner's password sign-in in the console, never a token." : "A run's computer view takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
  }
  if (name !== "getRunComputer") {
    const body = request.body ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object, empty");
    const issues = unknownFields(body, []);
    if (issues.length) throw invalid(issues);
  }
  const answer = name === "getRunComputer" ? await readComputer(runId, undefined) : name === "takeOverRunComputer" ? await takeOver(runId) : name === "handBackRunComputer" ? await handBack(runId) : undefined;
  if (answer === undefined) throw new ApiError("not_found", `no computer route ${name}`);
  if ("code" in answer) throw new ApiError(answer.code, answer.message);
  return answer;
}
