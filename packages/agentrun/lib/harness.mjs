// `agentrun harness install goose` and `agentrun harness install --recipe FILE`: the harness its owner installs, never a
// run (Goose, or an ACP agent a recipe file names: docs/harness-recipe.md). The server installed with this command does
// it (agentrun-serve install-harness), as it runs validate-template: the pinned archive downloaded, its sha256 checked,
// unpacked into DATA/harnesses/<id>, the binary's sha256 checked (or, for a recipe that pins none, the first one
// recorded), then put in place read-only. DATA is this command's (~/.agentrun unless --data names one), the store
// `npx @parcha/agentrun` starts the server on. Run again with the pinned binary in place, it downloads nothing. No
// provider key goes near it.
//
// `agentrun harness-check --recipe FILE`: the recipe's installed agent run for real on --model and judged
// (agentrun-serve check-harness, named as install-harness is, so this command's own word stays the CLI's): a JSON
// report, and the three facts printed. It spends, on the model's key.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The harnesses this command installs by name. */
const INSTALLABLE = ["goose"];

/** A variable named like a credential (a KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL(S) segment). */
const KEY_NAMED = /(?:^|_)(?:KEY|TOKEN|TOKENS|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

/** The data directory: --data, else this command's own. */
const dataOf = (values, env) => resolve(values.data ?? join(env.HOME || homedir(), ".agentrun"));

/** The installed server's launcher, or a usage failure saying it is not there. */
async function launcherOf(cli, what) {
  // Loaded here: start.mjs loads cli.mjs, which loads this module.
  const { installedServer } = await import("./start.mjs");
  const launcher = installedServer();
  if (launcher === undefined) throw cli.fail(2, `AgentRun's server is not installed beside this command, and it is the server that ${what}.`);
  return launcher;
}

export const HARNESS_INSTALL = {
  command: ["harness", "install"],
  pathParams: ["harness"],
  argsOptional: true,
  summary: "Install a harness AgentRun runs only once its owner installs it (goose, or a recipe file's), then restart AgentRun",
  help: [
    ["HARNESS", `the harness: ${INSTALLABLE.join(", ")}. Its pinned release is downloaded and checked by sha256 into DATA/harnesses/HARNESS; run again, it downloads nothing`],
    ["--recipe FILE", "in place of HARNESS: a recipe file (docs/harness-recipe.md), checked against its five rules before anything is downloaded"],
    ["--data DIR", "the data directory of the AgentRun it is for (default ~/.agentrun, where npx @parcha/agentrun keeps it)"],
  ],
  options: { recipe: { type: "string" } },
  async run({ values, args, env, cli }) {
    const [name] = args;
    if (values.recipe !== undefined && name !== undefined) throw cli.fail(2, "agentrun harness install takes a harness's name or --recipe FILE, not both.");
    if (values.recipe === undefined && !INSTALLABLE.includes(name)) throw cli.fail(2, `agentrun harness install installs ${INSTALLABLE.join(", ")} or a recipe file (--recipe FILE), not ${name ?? "nothing"}: claude-agent and codex install on first use, and pi and opencode come with AgentRun.`);
    const launcher = await launcherOf(cli, "installs a harness");
    // No key reaches the install: every variable named like one is left out of its environment.
    const keyless = Object.fromEntries(Object.entries(env).filter(([key]) => !KEY_NAMED.test(key)));
    const which = values.recipe === undefined ? [name] : ["--recipe", resolve(values.recipe)];
    return spawnSync(launcher, ["install-harness", ...which, "--data", dataOf(values, env)], { stdio: "inherit", env: keyless }).status ?? 1;
  },
};

export const HARNESS_CHECK = {
  command: ["harness-check"],
  pathParams: [],
  summary: "Run a recipe's installed agent for real and check it (tools off, env allowlist, pins, limits, no side requests, resume, a denied call, an MCP tool): a JSON report and three facts. Real models cost money",
  help: [
    ["--recipe FILE", "the recipe file (docs/harness-recipe.md); its agent installed first with agentrun harness install --recipe FILE"],
    ["--model PROVIDER/MODEL", "the run's model, for a recipe billed through the proxy (openrouter/anthropic/claude-haiku-4.5, anthropic/claude-haiku-4-5)"],
    ["--report FILE", "where the JSON report goes (default ./harness-check-ID.json)"],
    ["--cap USD", "the most the check may spend (default 0.25)"],
    ["--data DIR", "the data directory the recipe's agent was installed into (default ~/.agentrun)"],
  ],
  options: { recipe: { type: "string" }, model: { type: "string" }, report: { type: "string" }, cap: { type: "string" } },
  async run({ values, env, cli }) {
    if (values.recipe === undefined) throw cli.fail(2, "agentrun harness-check needs --recipe FILE.");
    const launcher = await launcherOf(cli, "checks a harness");
    const flags = ["--recipe", resolve(values.recipe), "--data", dataOf(values, env)];
    if (values.model !== undefined) flags.push("--model", values.model);
    if (values.report !== undefined) flags.push("--report", resolve(values.report));
    if (values.cap !== undefined) flags.push("--cap", values.cap);
    // The model's key goes to the server's launcher, which holds it in memory (its SECRETS) and hands it to no agent.
    return spawnSync(launcher, ["check-harness", ...flags], { stdio: "inherit", env }).status ?? 1;
  },
};
