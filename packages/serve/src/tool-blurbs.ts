// Each tool's blurb: one short line for people (the agent editor's Tools grid), served beside its model-facing summary in
// capabilities.tools and an agent's `tools`. The model never sees it. One source, so both views agree. An MCP server's
// tool has none: its own description is what there is. At most 48 characters, sentence case, no full stop.

/** The blurb of each tool this server registers, by its name (a legacy name reads as its capability's). */
export const TOOL_BLURBS: Readonly<Record<string, string>> = Object.freeze({
  read: "Read files in the run's folder",
  write: "Write files in the run's folder",
  edit: "Edit files in the run's folder",
  bash: "Run shell commands in the sandbox",
  bash_background: "Start a long-running command in the sandbox",
  bash_output: "Read a background command's output",
  bash_input: "Send input to a background command",
  bash_signal: "Stop a background command",
  bash_list: "List the background commands",
  ask_person: "Ask you a question mid-run",
  web_fetch: "Read a public web page",
  web_search: "Search the web",
  browser: "Browse websites in a hosted browser",
  "monid.discover": "Find paid data sources in monid's catalog",
  "monid.inspect": "Check a monid source's input and price",
  "monid.run": "Get paid data from a monid source",
  pdf_pages: "Turn a PDF's pages into images",
  llm: "Ask the model once, with no tools",
  learned_workflow: "Run a workflow this agent learned",
});

/** `name`'s blurb, or none (an MCP server's tool, a name this server does not register). */
export const blurbOf = (name: string): string | undefined => (Object.hasOwn(TOOL_BLURBS, name) ? TOOL_BLURBS[name] : undefined);
