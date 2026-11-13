/** Handing an agent to the person's own coding agent (Claude Code or Codex): a prompt they review, edit and copy. Nothing
 *  opens, nothing is sent, and the prompt carries no credential: the coding agent signs in to the server on its own. */

/** What the prompt is for: make an agent, revise one (at the revision on the page), or run one (pinned to its revision,
 *  with the input and effort typed so far, when there are any). */
export type CodingAgentContext =
  | { kind: "create" }
  | { kind: "edit"; agentId: string; revision: string }
  | { kind: "run"; agentId: string; revision: string; input?: unknown; effort?: string };

/** The applications a prompt goes to, each with where to paste it. */
export const CODING_AGENTS = [
  { id: "claude", label: "Claude Code app", instruction: "Open your project in Claude Code and paste the prompt into a new or existing conversation." },
  { id: "claude-cli", label: "Claude Code CLI", instruction: "Open your project in a terminal, start Claude Code with claude, and paste the prompt." },
  { id: "codex", label: "Codex app", instruction: "Open your project in the Codex app and paste the prompt into a new or existing chat." },
  { id: "codex-cli", label: "Codex CLI", instruction: "Open your project in a terminal, start Codex with codex, and paste the prompt." },
] as const;
export type CodingAgentChoice = (typeof CODING_AGENTS)[number]["id"];

/** Where this browser keeps the application last picked: the choice only, never a prompt, an input or a credential. */
export const CODING_AGENT_KEY = "agentrun.coding-agent";
/** The public skill a coding agent installs to drive AgentRun Server. */
export const SERVE_SKILL_URL = "https://github.com/Parcha-ai/agentrun/tree/main/packages/serve/skills/agentrun-serve";

type Store = Pick<Storage, "getItem" | "setItem">;
const local = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The application this browser kept, else Claude Code's app. A storage that refuses (a private window) keeps none. */
export function savedCodingAgent(store: Store | null = local()): CodingAgentChoice {
  try {
    const saved = store?.getItem(CODING_AGENT_KEY);
    return CODING_AGENTS.find((a) => a.id === saved)?.id ?? "claude";
  } catch { return "claude"; }
}

/** Keeps the choice in this browser. A storage that refuses keeps nothing, and the choice still holds in the open dialog. */
export function saveCodingAgent(choice: CodingAgentChoice, store: Store | null = local()) {
  try { store?.setItem(CODING_AGENT_KEY, choice); } catch { /* the handoff works without storage */ }
}

export const codingAgentOf = (choice: CodingAgentChoice) => CODING_AGENTS.find((a) => a.id === choice) ?? CODING_AGENTS[0];

/** The server's API as a coding agent reaches it: the console's endpoint (`/v2`, or another one) resolved against this
 *  page, keeping only its origin and path, so a user name, password, query or fragment in it never reaches the prompt. */
export function apiOf(serverUrl: string, page: string | undefined = globalThis.location?.href): { origin: string; path: string; api: string } {
  const url = new URL(serverUrl || "/", page);
  const path = url.pathname.replace(/\/+$/, "");
  return { origin: url.origin, path, api: `${url.origin}${path}` };
}

const TASK = {
  create: "Create an AgentRun agent on this server.",
  edit: "Review and revise this AgentRun agent.",
  run: "Run this AgentRun agent on its pinned revision.",
} as const;

/** The prompt for `context` on the server at `serverUrl` (the console's API endpoint). `consoleUrl`: where the person
 *  follows the result. It names the server's public documents and the routes the task uses, and never a credential. */
export function codingAgentPrompt(context: CodingAgentContext, serverUrl: string, consoleUrl?: string): string {
  const { origin, path, api } = apiOf(serverUrl);
  // The server's own pages (llms.txt at its root, MCP beside the API) are where its API is the usual /v2.
  const v2 = path.endsWith("/v2");
  const agent = context.kind === "create" ? "" : encodeURIComponent(context.agentId);
  const operation = context.kind === "create" ? `POST ${path}/agents`
    : context.kind === "edit" ? `PUT ${path}/agents/${agent}/definition` : `POST ${path}/agents/${agent}/runs`;
  const request = context.kind === "run"
    ? { ...(context.input !== undefined ? { input: context.input } : {}), ...(context.effort ? { effort: context.effort } : {}), revision: context.revision }
    : undefined;
  const data = {
    server: api,
    operation,
    ...(context.kind === "create" ? {} : { agent_id: context.agentId, revision: context.revision }),
    ...(request ? { request } : {}),
  };
  const consoleLink = consoleUrl ? `${apiOf(consoleUrl).api}/` : undefined;
  const steps = context.kind === "create"
    ? [`Create it with POST ${path}/agents and one Idempotency-Key for the request and any unchanged retry.`,
       "Write a native definition: instructions with the tools the agent needs, or a workflow this server supports. Include every skill file the person supplies in the same request.",
       "Do not submit missing requirements or configuration this server's capabilities do not offer."]
    : context.kind === "edit"
    ? [`Read the agent first with GET ${path}/agents/${agent} and keep its ETag.`,
       `Send the full definition with PUT ${path}/agents/${agent}/definition, a higher version and If-Match set to that ETag. Keep the agent's identity and every field you were not asked to change; skill files do not change through this route.`,
       "A 412 precondition_failed means another revision was saved first: report it, and do not overwrite that revision."]
    : [`Read the pinned revision's input contract. Start the run with POST ${path}/agents/${agent}/runs, the revision pinned, and one stable Idempotency-Key for this run and any unchanged retry.`,
       "Do not add a spending cap unless the person asks for one.",
       "Follow the run's actual status, its questions (input_required), its result and its files until it ends."];
  return [
    TASK[context.kind],
    "",
    "Install or update the public AgentRun Server skill with your own skill installation workflow:",
    SERVE_SKILL_URL,
    `Read its SKILL.md, then ${v2 ? `${origin}/llms.txt and ` : ""}${api}/openapi.json. Check ${api}/capabilities before you choose models, tools or workflow features.`,
    "",
    `Use this existing server. Authentication is separate from the skill: use the AgentRun API token the owner configured in your environment, as the skill describes. Never print a credential or ask for one in the conversation. The console's browser session does not sign you in.${v2 ? ` You can work over the server's MCP endpoint (${api}/mcp), as the skill connects it, or over the HTTP API.` : ""}`,
    "",
    "Task context:",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
    "Ask about missing task inputs, required outputs and scope before you submit anything. Keep the answers and any approval already given. Explain the change or the run first when it still needs approval.",
    ...steps,
    `Report the server's actual answer and the ${context.kind === "run" ? "run" : "revision"} it names${consoleLink ? `, with its link in the console (${consoleLink})` : ""}. Keep an unknown cost unknown. Copying this prompt submitted nothing, so do not claim that anything ran before the server says so.`,
  ].join("\n");
}
