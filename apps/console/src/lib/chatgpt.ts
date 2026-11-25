import type { Capabilities } from "@/lib/client";
import { withoutRoutePrefix } from "@/lib/routePrefix";
import type { ChatGPTView } from "@/lib/v2";

/** Where "Manage usage" opens: ChatGPT's settings. OpenAI documents no exact address for a plan's usage, so it is this
 *  one constant, to correct in one place. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/#settings";

/** The provider a plan model is named under (`chatgpt/<model-id>`): the server's, never inferred from a model's id. */
export const PLAN_PROVIDER = "chatgpt";
export const isPlanModel = (id: string | null | undefined): boolean => !!id && id.startsWith(`${PLAN_PROVIDER}/`) && id.length > PLAN_PROVIDER.length + 1;

/** Said under "Continue with ChatGPT": what the plan runs, and what still needs a key. */
export const PLAN_RUNS = "Codex and pi agents run on your ChatGPT plan. Claude Agent, OpenCode, Jev decisions and paid tools need their own keys.";
/** PLAN_RUNS on a server whose models go to a gateway (`models.source` `gateway`) and whose own default is not a plan model:
 *  there an agent that names no model runs on the gateway, signed in or not (serve's settingsModel), and the plan runs only
 *  an agent that names one of its models. */
const PLAN_RUNS_GATEWAY = "This server sends its models to a gateway, so agents run there by default. An agent runs on your ChatGPT plan only when it names one of the plan's models (chatgpt/…).";
/** What the plan runs on a server of `source` (capabilities' `models.source`) whose default model is `model`
 *  (`models.default`), with a gateway's ids under `routePrefix` (`models.route_prefix`). A gateway's server whose
 *  AGENT_MODEL names a plan model runs an agent that names none on the plan, as any server does (serve's settingsModel takes
 *  AGENT_MODEL first, and chooseModel the plan before the gateway); capabilities send that default under the prefix
 *  (`agent-model/chatgpt/<id>`), so the prefix comes off before the check. */
export const planRuns = (source?: Capabilities["models"]["source"], model?: string | null, routePrefix?: string | null): string =>
  source === "gateway" && !isPlanModel(withoutRoutePrefix(model, routePrefix)) ? PLAN_RUNS_GATEWAY : PLAN_RUNS;
/** The paste step, while a sign-in waits. */
export const PASTE_STEP = "Signing in on this computer finishes by itself. On a server elsewhere, the tab ends on a page that won't load: copy that tab's whole address and paste it here.";
/** Ours, under OpenAI's disclosure: one person's plan, one server. */
export const PLAN_IS_YOURS = "This sign-in is yours: don't let other people run agents on this server with it.";
export const SIGNED_OUT = "Signed out. If ChatGPT still lists AgentRun under connected apps, disconnect it there.";
/** A sign-out OpenAI didn't confirm, when the server's answer has no words of its own (it always does: these are its). */
export const NOT_REVOKED = "Signed out here. OpenAI didn't confirm the revocation: remove AgentRun in your ChatGPT settings.";
export const EXPIRED = "Your ChatGPT sign-in expired. Sign in again.";
/** A plan's requests in dollars: none; the plan's limits are ChatGPT's. A plan run's cost says it on hover. */
export const PLAN_NO_DOLLARS = "Requests on your ChatGPT plan cost no dollars here; your plan's own limits apply.";
/** Under an agent's spend cap: a cap counts dollars, which a plan's requests are not. */
export const CAP_NOTE = `Counts dollars. ${PLAN_NO_DOLLARS}`;

const STATES: ReadonlySet<string> = new Set(["signed_out", "pending", "signed_in", "expired"]);
/** GET /settings/chatgpt's answer when it is one (a server without the route answers 404, or something else), else null. */
export const chatGPTView = (body: unknown): ChatGPTView | null =>
  body && typeof body === "object" && STATES.has(String((body as { state?: unknown }).state)) ? (body as ChatGPTView) : null;

/** "plus" as a person reads it: "Plus". */
export const planName = (plan: string): string => plan.charAt(0).toUpperCase() + plan.slice(1);
/** "Signed in as a@b.c (Plus)", with what the server said. */
export const signedInAs = (v: ChatGPTView): string => `Signed in as ${v.email ?? "your ChatGPT account"}${v.plan ? ` (${planName(v.plan)})` : ""}`;
