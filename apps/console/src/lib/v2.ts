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
export type ToolSetting = { provider?: NonNullable<Body<"putToolSettings">["web_search" | "web_fetch" | "browser"]>["provider"]; permission?: Permission; pin?: ToolPin; pin_broken?: true };
/** A tool setting that can carry a pin (an MCP tool's): the server's read gives `pin_broken` for one that doesn't read. */
type PinnedSetting = Extract<NonNullable<Body<"putToolSettings">[string]>, { pin?: unknown }>;
/** A tool's pin: each argument fixed to one value, or one of a list (null: left out). A call outside it is refused. */
export type ToolPin = NonNullable<PinnedSetting["pin"]>;
/** Tool settings by settings key: the server's (PUT /v2/settings/tools, which replaces the whole map) and an agent's own
 *  (`definition.tool_settings`), over the server's. */
export type ToolSettings = Record<string, ToolSetting>;
/** The private-network hosts an MCP server's authorization server may be on (none by default): GET and PUT
 *  /v2/settings/mcp-servers/oauth/private-hosts. Only the owner's password session writes it. */
export type McpPrivateHosts = Answer<"getMcpPrivateHosts">;
/** GET /v2/agents/{id}'s `tools`: each tool the agent grants, with its permission and provider in force. */
export type AgentTool = NonNullable<components["Agent"]["tools"]>[number];
/** The computer an agent's runs are given (definition.computer): its kind and the provider that serves it, absent for
 *  none. The server keeps `place` as its v2 view and writes both from either; the console writes this one. */
export type Computer = NonNullable<components["DefinitionInput"]["computer"]>;

/** An agent's approvals (definition.approvals): "ask", the default, parks a call its tool gate says ask for the owner's
 *  answer; "never" runs it unattended (every tool it has granted; deny and pins still apply). */
export type Approvals = NonNullable<components["DefinitionInput"]["approvals"]>;
/** What Never ask grants, in the words every place that offers it says. */
export const NEVER_ASK_LINE = "Never ask: every tool this agent has runs without waiting for you. A tool set to deny, and a template's pins, still hold.";

/** One issue in a refusal or a warning, at its field (`parameters.repo`, `secrets.KEY`), with the server's `fix` when it
 *  names one. */
export type InputIssue = components["InputIssue"];

/** A template the server offers (GET /v2/templates): what it makes, and what it needs to make it. */
export type TemplateView = Answer<"listTemplates">["templates"][number];
/** Applying a template (POST /v2/templates/{name}/apply): its parameters, and the gate names of the tools the owner grants. */
export type TemplateApply = Body<"applyTemplate">;
/** What an apply made: the agent, its triggers, and its warnings. */
export type TemplateApplied = Answer<"applyTemplate">;

/** `so_far_usd` and `unpriced` (serve's costsofar/1), present only while `usd` is null. */
export type Cost = components["Cost"];

export type Run = components["Run"];

/** A trigger of any kind (GET /v2/triggers/{id}): a schedule or a webhook. */
export type Trigger = Answer<"getTrigger">;
/** What fires a trigger (serve's trigger/1): a schedule's times, or a webhook's signed requests. */
export type TriggerSource = Trigger["source"];
/** What a firing does: start a run of `agent_id` with `input`, capped at `max_cost_usd`. */
export type TriggerTarget = Extract<Trigger["target"], { kind: "start_run" }>;
/** One firing: by the schedule or by hand (Run now), for `nominal_at`, and what came of it. */
export type Firing = NonNullable<Trigger["last_firing"]>;
export type FiringStatus = Firing["status"];
/** An edit's body. */
export type TriggerInput = Body<"updateTrigger">;
/** A create's body (POST /v2/triggers). */
export type TriggerCreate = Body<"createTrigger">;
/** A create's answer: the trigger, and a webhook's `secret` that once, or `note` in its place on a retry under the same key. */
export type TriggerMade = Answer<"createTrigger">;
/** A webhook trigger's new signing secret (POST /v2/triggers/{id}/secret), shown that once. */
export type TriggerSecret = Answer<"rotateTriggerSecret">;
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
/** GET /v2/runs/{id}/computer, every kind with a screen (owner session only, no-store): `off`, the run has no screen here
 *  (`why`); `none`, it has one (`kind`) with no session up (yet, or any more); `live`, a session is open, watched through
 *  `viewer`, a same-origin path whose token is in its fragment (never sent to a server). `hold`: who drives now. */
export type RunComputer = Answer<"getRunComputer">;
/** Who drives the run's computer: the agent; `pending`, the owner's take waits for the agent's step in flight; the person. */
export type ComputerHold = RunComputer["hold"];
/** POST /v2/runs/{id}/computer/take-over's and …/hand-back's answer: who drives now, and an ask's outcome. */
export type ComputerHoldAnswer = Answer<"handBackRunComputer">;
/** A hand-back's answer to the agent's ask: done or cancelled. */
export type HandBackOutcome = NonNullable<Body<"handBackRunComputer">["outcome"]>;
/** The agent's ask for the person at its computer: kind "browser" (its browser) or "computer" (a desktop or phone).
 *  POST …/computer/hand-back answers either. */
export type ComputerAsk = Extract<NonNullable<Run["pending"]>, { kind: "browser" | "computer" }>;
/** The run read's computer: its agent's computer setting (any kind, a sandbox too), its provider and where it stands. */
export type RunMachine = NonNullable<Run["computer"]>;

/** Tool keys (GET /v2/settings/tool-keys, a serve extension). The server never sends a value. */
/** A secret as every read says it (SecretMeta): its "<plane>:<id>" name, set or not, where from, and its own last change. */
export type SecretMeta = components["SecretMeta"];
/** GET /v2/auth/session's answer, on a server with accounts or without (`accounts`): whether this session may write a
 *  secret, and why not. */
export type SessionSecrets = Answer<"getAuthSession">;
type ServedToolKeys = Answer<"listToolKeys">;
/** A key with its secrets (`secrets`, "tool:<KEY>"/"model:<KEY>"); `fields` as served, for the paste form. */
export type ToolKey = ServedToolKeys["keys"][number];
export type ToolKeys = ServedToolKeys;
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
export type WebhookSaved = Answer<"saveWebhook"> & { signing_secret?: string };
/** One try of a message (GET .../deliveries, newest first). */
export type WebhookAttempt = Answer<"listWebhookDeliveries">["attempts"][number];
/** `capabilities.features.webhooks`. */
export type WebhooksFeature = NonNullable<components["Features"]["webhooks"]>;

/** GET /v2/integrations/github's answer, always a 200: `{connected: false}` with no App, else the App. */
export type GitHubStatus = Answer<"getGitHubConnection">;
/** This server's GitHub App, connected (`connected: true`): never a secret. */
export type GitHubConnection = Extract<GitHubStatus, { connected: true }>;
/** POST /v2/integrations/github/connect's answer: where the browser posts the App's manifest (`action` carries ?state=). */
export type GitHubConnectStart = Answer<"connectGitHub">;
/** DELETE /v2/integrations/github's answer: how many GitHub triggers went off, and what to delete on GitHub. */
export type GitHubDisconnected = Answer<"disconnectGitHub">;

/** PATCH /v2/runs/{id} {max_cost_usd}'s answer: the cap now. */
export type RaiseAnswer = Answer<"raiseRunCap">;

/** A recorded response (src/fixtures): what the server answered, exactly. The console's own, not a wire type. */
export type Recorded<T> = { request: { method: string; path: string }; status: number; headers?: Record<string, string>; body: T };

// Computers (Settings → Computers) and Archil (Settings → Workspace).
/** GET /v2/computers: each kind, whether this server offers it, and its providers. */
export type Computers = Answer<"listComputers">;
export type ComputerKindView = Computers["kinds"][number];
/** A kind of computer an agent can be given. */
export type ComputerKind = ComputerKindView["kind"];
/** A provider of computers: its secrets ("computer:<provider>:<KEY>", set or not, where from and when, never a value),
 *  the full names of those it requires, whether it is metered, and whether a run could have it now. */
export type ComputerProvider = Answer<"saveComputerKeys">;
export type ComputerSecret = ComputerProvider["secrets"][number];
/** PUT /v2/computers/{provider}/keys's body: declared names only; null removes one. */
export type ComputerKeysBody = Body<"saveComputerKeys">;
/** POST /v2/computers/{provider}/test's answer. */
export type ComputerTest = Answer<"testComputer">;
/** GET /v2/workspace/archil: Archil (Mode 2) on or off, its disk settings, and its secret ("workspace:archil"), never a
 *  value. */
export type Archil = Answer<"getWorkspaceArchil">;
/** PUT /v2/workspace/archil's body. */
export type ArchilBody = Body<"putWorkspaceArchil">;
/** POST /v2/workspace/archil/test's answer. */
export type ArchilTest = Answer<"testWorkspaceArchil">;
