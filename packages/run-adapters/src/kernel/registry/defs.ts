// Every model-visible host tool's definition: its name, words, schema and replay, as main shows them today. read, write,
// edit and bash are pi's (pi 1.5.0's coding tools, MIT), with serve's additions: bash's timeout words and read's image
// sentence on a computer. The five background tools are serve's (background.ts). A test holds every one of them, in
// order, to serve's own on main.
import { BACKGROUND_INPUT_BYTES, BACKGROUND_LIST_MAX, BACKGROUND_LOG_BYTES, BACKGROUND_MAX, BACKGROUND_PAGE_BYTES, BACKGROUND_SIGNALS, BASH_DEFAULT_TIMEOUT_S } from "./limits.js";

/** Where the run's shell is: on a computer (bash and the background tools run there), on this machine in the run's
 *  folder (bash only, asked first), or nowhere (no shell tool at all). */
export type ShellPlace = "computer" | "local" | "none";

/** A tool the model sees. */
export type ToolDef = {
  readonly name: string;
  readonly source: "host";
  /** Its name in the kernel's grammar, `source:toolkit/action`. */
  readonly gateName: string;
  /** The settings key the tool gate reads for it: bash's for the whole shell family. */
  readonly settingsKey: string;
  readonly description: string;
  readonly parameters: object;
  /** A call the kernel may run again after a crash (it changes nothing). */
  readonly replaySafe: boolean;
  /** A shell tool: held to bash's setting; a watcher runs unasked under ask. */
  readonly shell?: { readonly family: "bash"; readonly watcher: boolean };
};

const READ_WORDS = "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.";
/** read's sentence on a computer: it opens an image anywhere in the computer. */
const READ_IMAGE_SENTENCE = " It also opens an image (png, jpg, gif, webp) at any path in the run's box, such as one rendered to /tmp, and returns it as an image; any other file only inside work/.";
const READ_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
};
const WRITE_WORDS = "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";
const WRITE_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to write (relative or absolute)" },
    content: { type: "string", description: "Content to write to the file" },
  },
  required: ["path", "content"],
};
const EDIT_WORDS = "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.";
const EDIT_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
          newText: { type: "string", description: "Replacement text for this targeted edit." },
        },
        required: ["oldText", "newText"],
      },
      description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  },
  required: ["path", "edits"],
};
const BASH_WORDS = "Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";

/** bash's timeout, said: the default and this run's ceiling, and, where background processes run, where longer work goes. */
export function bashTimeoutWords(maxExecS: number, background: boolean): { sentence: string; parameter: string } {
  const longer = background ? "; for longer work use bash_background" : "";
  return {
    sentence: ` Each command is stopped after ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${maxExecS} s${longer}.`,
    parameter: `Timeout in seconds: ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${maxExecS} s${longer}.`,
  };
}

const MIB = BACKGROUND_LOG_BYTES / (1024 * 1024);
const ID_SCHEMA = { type: "string", pattern: "^[1-9][0-9]*$", description: "The process's id, as bash_background answered it (\"1\")." };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const BACKGROUND_DEFS = [
  {
    name: "bash_background",
    description: `Start a shell command in the background in the run's box, from its work/, and answer at once with its id. Each call is a fresh shell (bash, else sh). The command runs until it and every child it left in its process group (a server started with &) have exited, bash_signal ends it, or the run ends, which ends it. Its stdout and stderr go together to work/background/<id>/output.log, which the run's files keep: the first ${MIB} MiB of them, later output dropped while it runs on. Its stdin is a pipe that bash_input writes; tty: true gives it a terminal instead. At most ${BACKGROUND_MAX} run at once in a run's box. Read its output with bash_output, list them with bash_list.`,
    parameters: schema({
      command: { type: "string", minLength: 1, description: "The command, as you would give bash." },
      tty: { type: "boolean", description: "Run it on a terminal (a pty, through script in the box), for a program that needs one: a prompt, a REPL, a progress display. Its log then holds what the terminal shows (your input echoed, lines ending in \\r\\n); bash_input types into the terminal, and bash_signal INT is Ctrl-C to its foreground job." },
    }, ["command"]),
    replaySafe: false,
  },
  {
    name: "bash_output",
    description: `Read a background process's output (stdout and stderr together) from a byte offset: at most max_bytes (default and most ${BACKGROUND_PAGE_BYTES / 1024} KiB), with whether it still runs, its exit code once it has ended, the log's size, and the offset to read from next. Start at 0; pass the next offset to read on, also to see what a running process wrote since.`,
    parameters: schema({
      id: ID_SCHEMA,
      offset: { type: "integer", minimum: 0, description: "The byte to read from; 0, the start, when absent." },
      max_bytes: { type: "integer", minimum: 1, maximum: BACKGROUND_PAGE_BYTES, description: `The most bytes to read; ${BACKGROUND_PAGE_BYTES.toLocaleString("en-US")} when absent.` },
    }, ["id"]),
    replaySafe: true,
  },
  {
    name: "bash_input",
    description: `Write text to a running background process's stdin, as given (end a line with \\n), at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call. close: true closes its stdin after the text, so the process reads the end of its input. To interrupt it, send bash_signal INT; a control character written here is only a byte.`,
    parameters: schema({
      id: ID_SCHEMA,
      text: { type: "string", description: "The bytes to write, as UTF-8; empty with close: true closes stdin alone." },
      close: { type: "boolean", description: "Close the process's stdin after the text." },
    }, ["id", "text"]),
    replaySafe: false,
  },
  {
    name: "bash_signal",
    description: "Send a signal to a background process's process group: TERM asks it to stop, INT is Ctrl-C, KILL ends it at once. Answers its state after up to 2 s: a process that handles the signal may run on.",
    parameters: schema({ id: ID_SCHEMA, signal: { type: "string", enum: [...BACKGROUND_SIGNALS], description: "TERM, INT or KILL." } }, ["id", "signal"]),
    replaySafe: false,
  },
  {
    name: "bash_list",
    description: `List this run's background processes: each one's id, whether it runs or how it ended, its output's size and its command's start, every running one first, then the newest that ended (${BACKGROUND_LIST_MAX} at most).`,
    parameters: schema({}, []),
    replaySafe: true,
  },
] as const;

const host = (name: string, toolkit: "fs" | "shell", description: string, parameters: object, replaySafe: boolean, watcher?: boolean): ToolDef => ({
  name,
  source: "host",
  gateName: `host:${toolkit}/${name}`,
  settingsKey: toolkit === "shell" ? "bash" : name,
  description,
  parameters,
  replaySafe,
  ...(toolkit === "shell" ? { shell: { family: "bash" as const, watcher: watcher === true } } : {}),
});

/** The model-visible host tools of a run, in the order the model sees them: read, write and edit always; bash where
 *  the run has a shell, its words bounded by `maxExecS`; and the five background tools on a computer. */
export function hostToolDefs(options: { maxExecS: number; shell: ShellPlace }): readonly ToolDef[] {
  const { maxExecS, shell } = options;
  const defs: ToolDef[] = [
    host("read", "fs", shell === "computer" ? `${READ_WORDS}${READ_IMAGE_SENTENCE}` : READ_WORDS, READ_PARAMETERS, true),
    host("write", "fs", WRITE_WORDS, WRITE_PARAMETERS, false),
    host("edit", "fs", EDIT_WORDS, EDIT_PARAMETERS, false),
  ];
  if (shell === "none") return defs;
  const words = bashTimeoutWords(maxExecS, shell === "computer");
  const bashParameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: { type: "number", description: words.parameter },
    },
    required: ["command"],
  };
  defs.push(host("bash", "shell", `${BASH_WORDS}${words.sentence}`, bashParameters, false));
  if (shell === "local") return defs;
  for (const tool of BACKGROUND_DEFS) defs.push(host(tool.name, "shell", tool.description, tool.parameters, tool.replaySafe, tool.name === "bash_output" || tool.name === "bash_list" || tool.name === "bash_signal"));
  return defs;
}
