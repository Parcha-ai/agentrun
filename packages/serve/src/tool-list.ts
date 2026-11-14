// The tool list: one row per tool this server registers, each fact about it a field of its row, in a leaf module every
// other imports (it imports nothing, so tools.ts, tool-plane.ts, tool-gate.ts and host-tools.ts share it without a cycle).
//   table    the tool is one of serve's closed table (tools.ts TOOLS) and a settings key of its own; the background tools
//            (held to bash's key) are not.
//   askable  the approved call is one the kernel runs itself, outside the model's turn, so ask is offered for it (any
//            other tool, a catalog tool apart, is allow or deny). The run's learned_workflow is one.
//   replay   a host tool a harness other than pi runs, and whether a call a crash cut off may run again (`safe`) or never
//            (`never`: answered interrupted). Also the list of tools another harness may be granted (runnable.ts).
//   host     a web tool every harness binds as a host tool (web_fetch, web_search), by its name.
//   blurb    one short line for people (the agent editor's Tools grid), served beside the model-facing summary in
//            capabilities.tools and an agent's `tools`; the model never sees it. At most 48 characters, sentence case, no
//            full stop. An MCP server's tool has none: its own description is what there is.
// A name with no row is no tool of this server's table: its permission, key and view are the ones every unregistered name
// gets (tool-gate.ts, tool-plane.ts), unchanged. The rows' order is the order the table's names are listed in.
export type ToolRow = { readonly table?: true; readonly askable?: true; readonly replay?: "safe" | "never"; readonly blurb?: string; readonly host?: true };

export const TOOL_LIST: Readonly<Record<string, ToolRow>> = Object.freeze({
  read: { table: true, askable: true, replay: "safe", blurb: "Read files in the run's folder" },
  write: { table: true, askable: true, replay: "never", blurb: "Write files in the run's folder" },
  edit: { table: true, askable: true, replay: "never", blurb: "Edit files in the run's folder" },
  bash: { table: true, askable: true, replay: "never", blurb: "Run shell commands in the sandbox" },
  ask_person: { table: true, replay: "safe", blurb: "Ask you a question mid-run" },
  web_fetch: { table: true, askable: true, replay: "safe", host: true, blurb: "Read a public web page" },
  web_search: { table: true, askable: true, replay: "safe", host: true, blurb: "Search the web" },
  browser: { table: true, blurb: "Browse websites in a hosted browser" },
  subagent: { table: true, blurb: "Run a task in a fresh helper conversation" },
  pdf_pages: { table: true, blurb: "Turn a PDF's pages into images" },
  llm: { table: true, blurb: "Ask the model once, with no tools" },
  bash_background: { replay: "never", blurb: "Start a long-running command in the sandbox" },
  bash_output: { replay: "safe", blurb: "Read a background command's output" },
  bash_input: { replay: "never", blurb: "Send input to a background command" },
  bash_signal: { replay: "never", blurb: "Stop a background command" },
  bash_list: { replay: "safe", blurb: "List the background commands" },
  learned_workflow: { askable: true, replay: "never", blurb: "Run a workflow this agent learned" },
});

const rowOf = (name: string): ToolRow | undefined => (Object.hasOwn(TOOL_LIST, name) ? TOOL_LIST[name] : undefined);
const namesWith = (field: keyof ToolRow): string[] => Object.keys(TOOL_LIST).filter((name) => TOOL_LIST[name]![field] !== undefined);

/** Every tool of serve's table (tools.ts), by name: a test holds this and the table as one. */
export const tableTools = (): string[] => namesWith("table");
/** Whether `name` has a row: a built-in this server registers (table tool, background tool, learned workflow). */
export const isToolRow = (name: string): boolean => rowOf(name) !== undefined;
/** Whether `name` is a tool of the table. */
export const isTableTool = (name: string): boolean => rowOf(name)?.table === true;
/** Whether ask is offered for `name`: the kernel runs its approved call itself. */
export const isAskable = (name: string): boolean => rowOf(name)?.askable === true;
/** Whether a host runs `name` on a harness other than pi: it has a replay class. */
export const isHostTool = (name: string): boolean => rowOf(name)?.replay !== undefined;
/** `name`'s replay class as a host runs it, or none. */
export const replayOf = (name: string): "safe" | "never" | undefined => rowOf(name)?.replay;
/** The tools a host runs on a harness other than pi, by name. */
export const hostToolNames = (): string[] => namesWith("replay");
/** Whether `name` is a web tool every harness binds as a host tool (web_fetch, web_search). */
export const isWebHostTool = (name: string): boolean => rowOf(name)?.host === true;
/** `name`'s blurb, or none (an MCP server's tool, a name this server does not register). */
export const blurbOf = (name: string): string | undefined => rowOf(name)?.blurb;
