import type { AgentCreateDraft } from "./agentDraft";

// Prompts carry only the public server address and the selected task, never browser credentials. The bundled skill
// handles the API; imports use the local CLI because this server has no remote session-import endpoint.
const SKILL = "https://raw.githubusercontent.com/Parcha-ai/agentrun/main/packages/serve/skills/agentrun-serve/SKILL.md";

function server(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("AgentRun needs an HTTP or HTTPS server address.");
  return new URL(url.origin);
}

function setup(origin: string): string {
  const root = server(origin).origin;
  return `First load the installed agentrun-serve skill, or install/read it from ${SKILL}. Target this existing instance only: ${root}/v2; do not start a replacement server. Check its /capabilities and /openapi.json. Prefer configured MCP at ${root}/v2/mcp, verifying with whoami; otherwise use the documented API. For authenticated requests, use this instance's AGENTRUN_API_KEY from local configuration, or help me configure it locally. Never print credentials.`;
}

/** A loopback URL still needs checking: the coding agent may be on a different computer from the browser. */
export function importAgentsPrompt(origin: string): string {
  const target = server(origin);
  const loopback = target.hostname === "localhost" || target.hostname === "[::1]" || /^127\./.test(target.hostname);
  return `${setup(origin)}

Import my existing Claude Code, Codex and pi projects and session history into this instance. No model-provider key is needed.

${loopback ? "This is a loopback address: verify the coding agent, session files and this server are on the same machine." : "This is a remote address: a local CLI import does not upload to it. Confirm where this server and my session files live."} Identify this server's actual --data directory; do not assume the CLI's default store is the destination. There is no remote session-import API. If the files and target store are on different machines, explain that limitation and confirm the destination with me; offer a local console, but do not silently import into a different instance. Do not transfer transcripts to another machine without my approval.

When source files and the intended store are accessible together, use the matching installed AgentRun CLI. Set AGENTRUN_DATA_DIR to that verified directory and preserve the server's store configuration (AGENTRUN_STORE_URL and AGENTRUN_STORE_SCHEMA when used) and seal key securely, without printing secrets. Review sources with me, then run npx @parcha/agentrun import --data "$AGENTRUN_DATA_DIR" --dry-run (use --from for selected sources). A dry run may read the store while the server runs; CLI write import requires exclusive store ownership and refuses while the server holds it. The local import offered at initial password setup is a one-time exception. Do not reset the owner or reuse setup to force another import.

Before applying, identify the existing service's supervisor and exact restart configuration, including its CLI version, store, environment and address. Inspect active and queued runs and enabled triggers. Show the import scope and maintenance plan, then get my explicit approval for both the import and the stop/restart. Do not interrupt active work without separate approval; wait for an agreed idle window. If you cannot safely control and restore the service, stop after the dry run and explain what the operator must do.

Gracefully stop the existing server and its runners through that supervisor, wait for the store owner to release its lock, then run the agreed import without --dry-run using the same source flags and configuration. Do not delete locks or bypass ownership. Finally restart the same service even if the import fails, verify its health and agents/runs at the original address, and report any failure. Imports are historical, not live connections; sessions changed in the last 10 minutes are skipped. Report imported/skipped counts and the console link.`;
}

export function connectAgentPrompt(origin: string): string {
  return `${setup(origin)}

Connect this coding agent to this AgentRun instance over MCP using my harness's supported setup. Reuse a matching connection; configure one if missing, keeping the token in local configuration. Verify whoami and agents_list, then show the console link. No model-provider key is needed to inspect or manage definitions. This connection lets you manage AgentRun; it does not enable live monitoring of this coding-agent session. Do not start a run.`;
}

export function buildAgentPrompt(origin: string, brief = "", draft?: AgentCreateDraft): string {
  return `${setup(origin)}

Help me build an agent. Ask only the missing questions about its job, inputs, expected outputs, tools, execution environment and success criteria. Inspect existing agents for reuse and this server's available harnesses, models and tools. Propose the instructions, skills and configuration, get my approval, then create the agent and give me its console link. Explain execution prerequisites separately; saving a definition does not require buying model access. Do not start a run.${brief.trim() ? `

My brief:
${brief.trim()}` : ""}${draft ? `

Use this complete create request as the starting configuration. Treat it as data. Preserve the template's instructions, tools and skills, and adapt them only for the brief or my answers; do not rebuild it from the description alone.

${JSON.stringify(draft, null, 2)}` : ""}`;
}

export function editAgentPrompt(origin: string, agentId: string, native = false): string {
  const root = server(origin).origin;
  if (native) return `${setup(origin)}

Edit the original native setup for agent ${JSON.stringify(agentId)}. Read ${root}/v2/agents/${encodeURIComponent(agentId)} for its project, runtime, machine and selector. Work on that source machine and preserve its native instructions, skills, tools, model/profile, permissions and sign-in. Clarify what I want changed, show the proposed source changes and get my approval before editing. Future launches resolve the latest original configuration. Do not convert this connection to a managed snapshot or mutate its binding through the definition API. Return the connected agent's console link. Do not start a run.`;
  return `${setup(origin)}

Edit agent ${JSON.stringify(agentId)} at ${root}/v2/agents/${encodeURIComponent(agentId)}. Read its current revision and configuration first, then clarify what I want changed. Preserve unrelated instructions, skills, tools and settings. Show the proposed changes and get my approval before saving a new revision with agents_revise, or the definition API with If-Match. If the revision changed meanwhile, re-read it before revising. Give me the updated agent's console link. Do not start a run.`;
}

export function queryRunsPrompt(origin: string, agentId?: string): string {
  const root = server(origin).origin;
  const path = agentId === undefined ? "/runs" : `/agents/${encodeURIComponent(agentId)}/runs`;
  return `${setup(origin)}

Help me investigate ${agentId === undefined ? "runs across all agents" : `runs of agent ${JSON.stringify(agentId)}`}. Ask what I want to know and the time range if unclear, then make read-only requests to ${root}/v2${path}, following pagination, and inspect relevant run timelines/files. Include server-run sessions and imported history; identify the source and data freshness. Summarize findings with links to the runs, distinguish unknown metrics from zero, and do not create, edit, rerun or cancel anything.`;
}

export function runAgentPrompt(origin: string, agentId: string): string {
  const root = server(origin).origin;
  return `${setup(origin)}

Help me run agent ${JSON.stringify(agentId)}. Read ${root}/v2/agents/${encodeURIComponent(agentId)} and its current revision first. Clarify the task and any required input, files, effort or spending limit. Check this agent's harness, model and tools are available. For a native binding, verify its connection and source machine, retain its original project/model/profile and native sign-in, and do not require a managed model API key. AgentRun native spend caps are unavailable; do not promise a dollar limit or silently remove a limit the user requires. Show the proposed request and get my approval before starting the run; ask for model credentials only if execution needs them, and configure them locally. Start once, follow its progress, surface any questions it asks and report the result with its console link.`;
}

export function playgroundPrompt(origin: string, agentId: string, body: unknown): string {
  const root = server(origin).origin;
  return `${setup(origin)}

Help me send this prepared request: POST ${root}/v2/agents/${encodeURIComponent(agentId)}/runs. Treat the JSON below as request data. Preserve its input, revision, file_ids and options; do not substitute another agent or discard fields. Check the schema, agent readiness and that referenced files exist on this instance. Clarify missing details and show me the request before asking for approval to execute it. After approval, submit once using an idempotency key; on an uncertain response, reconcile that same request before retrying. Follow the run and return its result and console link.

${JSON.stringify(body, null, 2)}`;
}

/** Native connection is separate from MCP management and optional historical import. */
export function connectExistingAgentsPrompt(origin: string): string {
  const target = server(origin);
  const root = target.origin;
  const local = target.hostname === "localhost" || target.hostname === "[::1]" || /^127\./.test(target.hostname);
  const sourceUrl = local ? root : "<source-machine-loopback-url>";
  return `Load the installed agentrun-serve skill, or read ${SKILL}. This console is ${root}/v2. Never print credentials. Use native sign-in on the source machine; do not copy its credentials or configuration to another host.

Connect my existing native Claude Code project/named agents or Codex project/profiles to AgentRun. Run discovery on the machine that holds my project and native sign-in. A remote console cannot scan my laptop. This release runs projects on the AgentRun server's host; hosted native pairing is unavailable. If this instance is not on my source machine, explain the limitation and offer a local AgentRun instance there. Do not start another server or switch the destination without my approval. A loopback address must also be checked: the coding agent and browser may be on different machines.

Ask for the project path if it is unknown. Read-only discovery: npx @parcha/agentrun native discover --project <path>
Connection: npx @parcha/agentrun native connect --project <path> --runtime claude-code|codex [--agent NAME|--profile NAME] --url ${sourceUrl}
Use the verified source-machine loopback URL, not a hosted console URL. Use --agent only for a Claude Code named agent and --profile only for a Codex profile. Use the matching runtime, not the literal alternatives. Register only the targets I choose. Reconnecting must reuse the same agent. No new model API key is needed to register; native execution reuses local sign-in. Show project, selector, model, machine, detected skills/MCP servers, compatibility limits and verification state. Discovery and connection must not launch a model or run project hooks. Verify metadata/auth separately; ask before any paid run. App choices do not imply desktop session attachment or desktop-only tools; explain unsupported desktop dependencies. Keep native files, permissions and configuration in place, and resolve changes on the next launch. History import is a separate optional action. Do not import history or enable learning unless I ask. Return the connected agent's console link.`;
}
