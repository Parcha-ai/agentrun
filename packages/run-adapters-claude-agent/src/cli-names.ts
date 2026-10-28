// The names the pinned Claude Agent CLI keeps for itself. Written for AgentRun.

/**
 * The names the pinned CLI (2.1.286) answers `Skill("<name>")` with itself, whatever the session's skills: its commands
 * and bundled skills. A host skill by one of these names is reachable only as `agentrun:<name>`, never by the bare name a
 * prompt writes: the Skill hook never maps a bare one of these to the session's skill. Measured: each name's call is
 * answered by the CLI's own check, before any hook (test/skills.test.mjs pins the list against the CLI's own).
 */
export const CLAUDE_AGENT_CLI_SKILL_NAMES: ReadonlySet<string> = new Set([
  "__remote-workflow", "add-dir", "agents", "auto-mode-setup", "autocompact", "batch", "btw", "bug", "claude-api",
  "clear", "code-review", "color", "compact", "config", "context", "copy", "cost", "dataviz", "debug", "doctor",
  "effort", "exit", "export", "fast", "feedback", "fewer-permission-prompts", "focus", "goal", "heapdump", "help",
  "hooks", "ide", "init", "insights", "keybindings-help", "list-agents", "login", "logout", "mcp", "memory", "model",
  "output-style", "permissions", "plugin", "plugin-authoring", "plugin-types", "plugins", "quit", "recap",
  "release-notes", "reload-plugins", "reload-skills", "rename", "resume", "review", "rewind", "run",
  "run-skill-generator", "sandbox", "security-review", "simplify", "skills", "stats", "status", "statusline",
  "tasks", "team-onboarding", "terminal-setup", "theme", "update-config", "usage", "verify", "workflow-launch-exec",
]);
