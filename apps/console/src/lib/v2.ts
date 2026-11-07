// The slice of agentrun.v2/0 the console reads, by the names the console uses: each an alias over api.generated.ts,
// which scripts/generate-clients.mjs writes from the server's OpenAPI document, so a type here is what the server says it
// sends. Edit the server's document, then run node scripts/generate-clients.mjs; never a wire type here.

import type { components, operations } from "./api.generated";

type Answer<Id extends keyof operations> = operations[Id]["answer"];
type Body<Id extends keyof operations> = operations[Id]["body"];

/** `paused`: a workflow run paused by POST /v2/runs/{id}/pause; its calls in flight finish and no node starts. */
export type RunStatus = components["RunStatus"];
export type RunState = components["RunState"];

/** An error's body (`{error: ApiError}`), and a failed run's `error`. Its `code` is any string: the console also says
 *  its own failures (a request that never reached the server, `network`) in this shape. */
export type ApiError = Omit<components["ErrorBody"], "code"> & { code: components["ErrorBody"]["code"] | components["RunErrorCode"] | (string & {}) };

/** What the server's tool gate does with a tool's calls: allow runs it, ask waits for the owner's approval, deny refuses
 *  it (approvals/1). */
export type Permission = AgentTool["permission"];
/** One tool's setting, read by any settings key: a provider where the tool has a choice (web_search, web_fetch, browser),
 *  and a permission. */
export type ToolSetting = { provider?: NonNullable<Body<"putToolSettings">["web_search" | "web_fetch" | "browser"]>["provider"]; permission?: Permission };
/** Tool settings by settings key: the server's (PUT /v2/settings/tools, which replaces the whole map) and an agent's own
 *  (`definition.tool_settings`), over the server's. */
export type ToolSettings = Record<string, ToolSetting>;
/** GET /v2/agents/{id}'s `tools`: each tool the agent grants, with its permission and provider in force. */
export type AgentTool = NonNullable<components["Agent"]["tools"]>[number];

/** `so_far_usd` and `unpriced` (serve's costsofar/1), present only while `usd` is null. */
export type Cost = components["Cost"];

export type Run = components["Run"];

/** A schedule (GET /v2/triggers/{id}). */
export type Trigger = Answer<"getTrigger">;
/** When a schedule fires (serve's trigger/1). */
export type TriggerSource = Trigger["source"];
/** What a firing does: start a run of `agent_id` with `input`, capped at `max_cost_usd`. */
export type TriggerTarget = Extract<Trigger["target"], { kind: "start_run" }>;
/** One firing: by the schedule or by hand (Run now), for `nominal_at`, and what came of it. */
export type Firing = NonNullable<Trigger["last_firing"]>;
export type FiringStatus = Firing["status"];
/** A create's or an edit's body. */
export type TriggerInput = Body<"updateTrigger">;
/** A question the run asked a person (ask_person): a message answers it. */
export type PendingQuestion = Extract<NonNullable<Run["pending"]>, { kind: "question" }>;
/** A tool call set to ask, waiting for the owner's approval (approvals/1): POST /v2/runs/{id}/approvals/{id} answers it. */
export type PendingApproval = Extract<NonNullable<Run["pending"]>, { kind: "approval" }>;
/** A run paused at its spend cap: what is left of its cap cannot buy its next request's least, which was not sent. */
export type BudgetPending = Extract<NonNullable<Run["pending"]>, { kind: "budget" }>;

export type RunReview = NonNullable<Run["review"]>;

export type TimelineKind = components["TimelineKind"];
export type TimelineRow = components["TimelineRow"];
export type TimelinePage = components["TimelinePage"];

export type RunFile = components["RunFile"];
export type RunFiles = components["RunFileList"];

/** Tool keys (GET /v2/settings/tool-keys, a serve extension). The server never sends a value. */
export type ToolKeys = Answer<"listToolKeys">;
export type ToolKey = ToolKeys["keys"][number];
export type ToolKeyField = ToolKey["fields"][number];
/** A saved key's check with its provider. Null, or absent from a server that does not check, says nothing. */
export type ToolKeyCheck = NonNullable<ToolKey["check"]>;
/** Saved values that do not open on this server, and why. `fields` is empty when the whole file does not read. */
export type ToolKeysReenter = NonNullable<ToolKeys["reenter"]>;
/** `capabilities.features.tool_keys`. */
export type ToolKeysFeature = NonNullable<components["Features"]["tool_keys"]>;

/** The webhook (GET /v2/settings/webhook, a serve extension). Never the secret. */
export type Webhook = Answer<"getWebhook">;
/** A PUT's answer: the webhook, and its secret the first time (201), shown this once. */
export type WebhookSaved = Answer<"saveWebhook"> & { secret?: string };
/** One try of a message (GET .../deliveries, newest first). */
export type WebhookAttempt = Answer<"listWebhookDeliveries">["attempts"][number];
/** `capabilities.features.webhooks`. */
export type WebhooksFeature = NonNullable<components["Features"]["webhooks"]>;

/** PATCH /v2/runs/{id} {max_cost_usd}'s answer: the cap now. */
export type RaiseAnswer = Answer<"raiseRunCap">;

/** A recorded response (src/fixtures): what the server answered, exactly. The console's own, not a wire type. */
export type Recorded<T> = { request: { method: string; path: string }; status: number; headers?: Record<string, string>; body: T };
