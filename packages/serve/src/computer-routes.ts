// A run's desktop or phone, as its owner takes it over and hands it back: POST /v2/runs/{id}/computer/take-over and
// POST .../computer/hand-back. Owner-only, as a run's browser is (a taken computer's viewer is a full-control
// credential): the owner's password session in the console, never a token. Watching the computer (GET
// /v2/runs/{id}/computer) is the computer view's route, not these.
//
// TODO(store-backed take-over): the take-over and the hand-back move to the store, written by the server and applied by
// the runner holding the run's claim. Until that lands here, both routes answer 501 unsupported_here in words, after the
// owner check and the body check: no process keeps a register of run computers in memory.
import { ApiError, invalid, unsupported } from "./errors.js";
import { unknownFields } from "./validate.js";

/** The routes' names in serve's route table: each takes the owner's password session, never a token. */
export const COMPUTER_ROUTES: ReadonlySet<string> = new Set(["takeOverRunComputer", "handBackRunComputer"]);

/** How a request to one of the routes came: by the owner's signed-in page, or with a token; whether this server has
 *  accounts (for the refusal's words); its body. */
export type ComputerRequest = { readonly ownerSession: boolean; readonly token: boolean; readonly accounts: boolean; readonly body?: unknown };

/** The words both routes answer until the store-backed take-over lands. */
export const TAKE_OVER_NOT_YET = "Taking over a run's desktop or phone, and handing it back, are not served here yet: they come with the store-backed take-over, where the server writes the take-over and the runner holding the run applies it.";

/**
 * One of the routes (COMPUTER_ROUTES, by its name in serve's route table). A token is refused (forbidden): a taken
 * computer's view drives it, so it takes the owner's signed-in page, as a run's browser does. A body other than an empty
 * JSON object is refused (input_invalid). Then 501 unsupported_here, in TAKE_OVER_NOT_YET's words.
 */
export async function computerRoute(name: string, request: ComputerRequest): Promise<never> {
  if (!COMPUTER_ROUTES.has(name)) throw new ApiError("not_found", `no computer route ${name}`);
  if (!request.ownerSession && request.token) {
    throw new ApiError("forbidden", request.accounts ? "A run's computer take-over takes the owner's password sign-in in the console, never a token." : "A run's computer take-over takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
  }
  const body = request.body ?? {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object, empty");
  const issues = unknownFields(body, []);
  if (issues.length) throw invalid(issues);
  throw unsupported("computer.take_over", TAKE_OVER_NOT_YET);
}
