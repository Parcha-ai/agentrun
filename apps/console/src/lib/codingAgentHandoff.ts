export type CodingAgentContext =
  | { kind: "create"; request?: unknown }
  | { kind: "edit"; agentId: string; revision: string; request?: unknown }
  | { kind: "run"; agentId: string; revision: string; input?: unknown };

export const CODING_AGENT_PREFERENCE = "agentrun.coding-agent.v1";
export const CODING_AGENTS = [
  { id: "claude", label: "Claude Code app", instruction: "Open Claude Code in your project and paste the prompt into a new or existing conversation." },
  { id: "claude-cli", label: "Claude Code CLI", instruction: "Open your project in a terminal, start Claude Code CLI with claude, and paste the prompt." },
  { id: "codex", label: "Codex app", instruction: "Open your project in the Codex app and paste the prompt into a new or existing chat." },
  { id: "codex-cli", label: "Codex CLI", instruction: "Open your project in a terminal, start Codex CLI with codex, and paste the prompt." },
] as const;
export type CodingAgentChoice = typeof CODING_AGENTS[number]["id"];

export function readCodingAgent(): CodingAgentChoice {
  try {
    const saved = localStorage.getItem(CODING_AGENT_PREFERENCE);
    return CODING_AGENTS.find((agent) => agent.id === saved)?.id ?? "claude";
  } catch { return "claude"; }
}

/** Only the application choice is stored; prompts, task input and authentication stay out of browser storage. */
export function rememberCodingAgent(choice: CodingAgentChoice) {
  try { localStorage.setItem(CODING_AGENT_PREFERENCE, choice); } catch { /* The handoff works when storage is disabled. */ }
  window.dispatchEvent(new Event("agentrun-coding-agent-change"));
}

/** The complete configured API endpoint and non-secret task context. */
export function codingAgentPrompt(context: CodingAgentContext, serverUrl: string): string {
  const url = new URL(serverUrl || "/", globalThis.location?.href);
  const origin = url.origin;
  const path = url.pathname.replace(/\/$/, "");
  const api = `${origin}${path}`;
  const overview = path.endsWith("/v2") ? `${api.slice(0, -"/v2".length)}/llms.txt and ` : "";
  const agent = context.kind === "create" ? undefined : encodeURIComponent(context.agentId);
  const operation = context.kind === "create" ? `POST ${path}/agents`
    : context.kind === "edit" ? `PUT ${path}/agents/${agent}/definition` : `POST ${path}/agents/${agent}/runs`;
  const task = context.kind === "create" ? "Create a native AgentRun agent."
    : context.kind === "edit" ? "Review and revise this AgentRun agent." : "Run this AgentRun agent on the pinned revision.";
  const data = {
    server: api, operation,
    ...(context.kind === "create" ? {} : { agent_id: context.agentId, revision: context.revision }),
    ...(context.kind === "run" ? { request: { ...(context.input !== undefined ? { input: context.input } : {}), revision: context.revision } }
      : context.request !== undefined ? { request: context.request } : {}),
  };
  return `${task}

Install or update the public AgentRun Server skill with your coding agent's skill installation workflow:
https://github.com/Parcha-ai/agentrun/tree/main/packages/serve/skills/agentrun-serve
Read its SKILL.md, then ${overview}${api}/openapi.json. Check this server's capabilities before choosing models, tools or workflow features.

Use this existing server. Authentication is separate from skill installation: use the owner's locally configured AgentRun API credential from the environment. Never print credential values or ask for them in the conversation. A browser session does not authenticate your coding agent.

Task context:
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

Clarify missing task inputs, required outputs and material scope before submitting. Preserve answers and any explicit authorization already given. Explain the proposed changes or run when approval is still needed.
${context.kind === "edit" ? "Read the agent and its ETag first. Keep its identity and all unchanged skill files and configuration. Submit with If-Match; report a stale-edit conflict without overwriting another revision."
    : context.kind === "run" ? "Read the selected revision's input contract, keep the revision pinned, and use one stable Idempotency-Key for this run and any unchanged retry. Do not add a spending cap unless the person requests one. Follow actual status, input requests, results and files to completion."
      : "Create a native definition with agentic instructions or a supported workflow. Include every supplied skill file in the revision request. Do not submit incomplete requirements or unsupported configuration."}
Report the actual server response, revision or run identifier, and console link. Keep unknown usage unknown; do not claim execution from a copied prompt.`;
}
