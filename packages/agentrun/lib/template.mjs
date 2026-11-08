// `agentrun template validate DIR`: a template package folder checked on this machine by the server's own validator,
// the one a server runs on the packages it ships at its start. The server installed with this command checks it
// (agentrun-serve validate-template), as it runs import and reset-password: this command reaches the server through its
// launcher and its API alone. Nothing in the package runs.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const TEMPLATE_VALIDATE = {
  command: ["template", "validate"],
  pathParams: ["dir"],
  summary: "Check a template package folder (agent.md, skills/, rules/, evals/) as a server does before it applies one",
  help: [["DIR", "the package's folder: its name is the package's name. Prints what it holds, or each problem (exit 1)"]],
  options: {},
  async run({ args, cli }) {
    // Loaded here: start.mjs loads cli.mjs, which loads this module.
    const { installedServer } = await import("./start.mjs");
    const launcher = installedServer();
    if (launcher === undefined) throw cli.fail(2, "AgentRun's server is not installed beside this command, and it is the server that checks a package.");
    return spawnSync(launcher, ["validate-template", resolve(args[0])], { stdio: "inherit" }).status ?? 1;
  },
};

// `agentrun template eval DIR`: the package's eval cases run as real runs of its agent and graded (agentrun-serve
// eval-template, templates/README.md "Running the evals"), on a server the command starts in its own process over a temp
// data directory, or with --server on that one, its token found as every other command finds it (AGENTRUN_API_KEY, the
// CLI's config, or the data directory's .token for the server on this machine) and handed to the server's launcher in
// AGENTRUN_API_KEY, which moves it to a pipe: never in an argument, never printed. Its exit is the eval's: 0 every case
// passed, 1 one failed, 2 nothing ran (the flags, the package or a case are wrong).
export const TEMPLATE_EVAL = {
  command: ["template", "eval"],
  pathParams: ["dir"],
  summary: "Run a template package's eval cases as real runs of its agent and grade each run (real models cost money)",
  help: [
    ["DIR", "the package's folder"],
    ["--case NAME", "a case to run (repeat it); without one, every case"],
    ["--runs N", "how many runs of each case, in place of each case's own runs"],
    ["--server URL", "run on that server, with its token (AGENTRUN_API_KEY), instead of on a server of its own over a temp data directory"],
    ["--grader-model PROVIDER/MODEL", "the model of the llm graders (default: the server's)"],
    ["--report FILE", "the whole report, as JSON (a summary goes to stdout either way)"],
    ["--faux MODULE", "answer every model request from MODULE's default export: no key, no network"],
  ],
  options: { case: { type: "string", multiple: true }, runs: { type: "string" }, server: { type: "string" }, "grader-model": { type: "string" }, report: { type: "string" }, faux: { type: "string" } },
  async run({ values, args, env, cli }) {
    const { installedServer } = await import("./start.mjs");
    const launcher = installedServer();
    if (launcher === undefined) throw cli.fail(2, "AgentRun's server is not installed beside this command, and it is the server that runs an eval.");
    const argv = ["eval-template", resolve(args[0])];
    for (const name of values.case ?? []) argv.push("--case", name);
    if (values.runs !== undefined) argv.push("--runs", values.runs);
    if (values["grader-model"] !== undefined) argv.push("--grader-model", values["grader-model"]);
    if (values.report !== undefined) argv.push("--report", resolve(values.report));
    if (values.faux !== undefined) argv.push("--faux", resolve(values.faux));
    let childEnv = env;
    if (values.server !== undefined) {
      const { base, token } = cli.targetOf({ ...values, "base-url": values.server }, env);
      argv.push("--server", base);
      childEnv = { ...env, AGENTRUN_API_KEY: token };
    }
    return spawnSync(launcher, argv, { stdio: "inherit", env: childEnv }).status ?? 1;
  },
};
