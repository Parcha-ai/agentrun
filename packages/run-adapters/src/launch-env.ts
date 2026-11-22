// The one list of variables that change what a process loads or runs before its own code does: a dynamic loader's
// (LD_*, DYLD_*), an interpreter's (NODE_OPTIONS, NODE_PATH, PYTHON*), a shell's (BASH_ENV, ENV and bash's other
// start-up variables), git's (GIT_*: its config, its ssh and pager commands), and PATH, which picks every program a
// name runs. Whoever hands an agent's process a value under a name of its choosing (a recipe's key, handed under the
// name the agent reads; the variable an agent reads its sign-in folder from; a recipe's env) refuses these names: a
// value there would run code the pinned binary never named. The ACP adapter and serve's recipe loader both read it.

/** An environment variable's name, as a recipe may write one (`GEMINI_HOME`, `agent_home`): the recipe loader and the
 *  ACP adapter read the same rule, so the adapter never refuses a name the loader took. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names refused whole. */
export const LAUNCH_ENV: readonly string[] = Object.freeze([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ENV",
  "IFS",
  "PS4",
  "SHELLOPTS",
  "PROMPT_COMMAND",
  "ZDOTDIR",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
]);

/** Prefixes refused with every name they start: BASH_ holds BASH_ENV and exported functions (BASH_FUNC_*). */
export const LAUNCH_ENV_PREFIXES: readonly string[] = Object.freeze(["LD_", "DYLD_", "PYTHON", "BASH_", "GIT_"]);

/** Whether `name` changes what a process loads or runs before its own code (LAUNCH_ENV, LAUNCH_ENV_PREFIXES). */
export const launchEnv = (name: string): boolean => LAUNCH_ENV.includes(name) || LAUNCH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
