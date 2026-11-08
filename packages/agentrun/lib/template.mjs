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
