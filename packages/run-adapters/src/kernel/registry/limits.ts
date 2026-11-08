// The host tools' limits, moved from serve (coding-tools.ts, background.ts) unchanged: the kernel's registry holds every
// model-visible host tool's words and limits, and serve reads them from here once the cutover wires it.

/** bash's timeout, in seconds: the default when a call names none, and the most a call gets where the hands allow it
 *  (Claude Code's own 120 s and 600 s). A command that needs longer is a background process (bash_background). The
 *  ceiling a run gets is its hands' `maxExecS`: 600 s locally and on a computer, less where the hands' exec is bounded. */
export const BASH_DEFAULT_TIMEOUT_S = 120;
export const BASH_MAX_TIMEOUT_S = 600;

/** The largest image read hands the model, in bytes: 3.75 MiB, whose base64 is the 5 MiB the strictest platform a
 *  harness sends images to takes (the claude-agent adapter's CLAUDE_AGENT_MAX_IMAGE_BYTES, Amazon Bedrock's). */
export const READ_IMAGE_MAX_BYTES = 3_932_160;

/** The most background processes that run at once in one run's computer. */
export const BACKGROUND_MAX = 8;
/** The most bytes of output one background process's log keeps: later output is dropped, and the process runs on. */
export const BACKGROUND_LOG_BYTES = 16 * 1024 * 1024;
/** The most bytes of output one `bash_output` call answers, and its default. */
export const BACKGROUND_PAGE_BYTES = 48 * 1024;
/** The most bytes one `bash_input` call writes. */
export const BACKGROUND_INPUT_BYTES = 64 * 1024;
/** The most processes `bash_list` names: every running one, then the newest that ended. */
export const BACKGROUND_LIST_MAX = 40;
/** Where a background process's log and state live, under the run's work/. */
export const BACKGROUND_DIR = "background";
/** The signals `bash_signal` sends. */
export const BACKGROUND_SIGNALS = ["TERM", "INT", "KILL"] as const;
/** The background tools, by name. */
export const BACKGROUND_TOOLS = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"] as const;
/** The tools that run a command on the run's computer: bash, and the background tools. The tool gate holds each to
 *  bash's setting (SHELL_FAMILY). */
export const SHELL_TOOLS: readonly string[] = ["bash", ...BACKGROUND_TOOLS];
