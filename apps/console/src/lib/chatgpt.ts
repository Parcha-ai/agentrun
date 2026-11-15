import type { ChatGPTView } from "@/lib/v2";

/** Where "Manage usage" opens: ChatGPT's settings. OpenAI documents no exact address for a plan's usage, so it is this
 *  one constant, to correct in one place. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/#settings";

/** The provider a plan model is named under (`chatgpt/<model-id>`): the server's, never inferred from a model's id. */
export const PLAN_PROVIDER = "chatgpt";
export const isPlanModel = (id: string | null | undefined): boolean => !!id && id.startsWith(`${PLAN_PROVIDER}/`) && id.length > PLAN_PROVIDER.length + 1;

/** Said under "Continue with ChatGPT": what the plan runs, and what still needs a key. */
export const PLAN_RUNS = "Codex and pi agents run on your ChatGPT plan. Claude Agent, OpenCode, Jev decisions and paid tools need their own keys.";
/** The paste step, while a sign-in waits. */
export const PASTE_STEP = "Signing in on this computer finishes by itself. On a server elsewhere, the tab ends on a page that won't load: copy that tab's whole address and paste it here.";
/** Ours, under OpenAI's disclosure: one person's plan, one server. */
export const PLAN_IS_YOURS = "This sign-in is yours: don't let other people run agents on this server with it.";
export const SIGNED_OUT = "Signed out. If ChatGPT still lists AgentRun under connected apps, disconnect it there.";
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
