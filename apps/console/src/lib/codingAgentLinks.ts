export const codingAgents = ["codex", "codex-cli", "claude", "claude-cli", "cursor", "other"] as const;
export type CodingAgent = typeof codingAgents[number];
export const CODING_AGENT_PREFERENCE = "agentrun.coding-agent.v1";
export const CODING_AGENT_EVENT = "agentrun:coding-agent";
export const codingAgentLabels: Record<CodingAgent, string> = {
  codex: "Codex app", "codex-cli": "Codex CLI", claude: "Claude Code app", "claude-cli": "Claude Code CLI", cursor: "Cursor", other: "Other / terminal",
};
export function readCodingAgent(): CodingAgent | "" {
  try {
    const value = localStorage.getItem(CODING_AGENT_PREFERENCE);
    return codingAgents.includes(value as CodingAgent) ? value as CodingAgent : "";
  } catch { return ""; }
}
export function rememberCodingAgent(agent: CodingAgent) {
  try { localStorage.setItem(CODING_AGENT_PREFERENCE, agent); } catch { /* A preference also works for this visit. */ }
}
/** App prompt-prefill links, matching the hosted console. CLI sessions receive a clipboard prompt instead.
 * Long prompts stay whole through copy; nothing here submits work or downloads a file. */
export function codingAgentLink(agent: CodingAgent | "", prompt: string): string | null {
  const text = encodeURIComponent(prompt);
  const href = agent === "codex" ? `codex://new?prompt=${text}`
    : agent === "claude" ? `claude://code/new?q=${text}`
    : agent === "cursor" ? `cursor://anysphere.cursor-deeplink/prompt?text=${text}` : null;
  return href && href.length <= 8000 ? href : null;
}
