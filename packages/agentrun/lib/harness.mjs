// `agentrun harness install goose|cursor|antigravity` and `agentrun harness install --recipe FILE`: the harness its owner
// installs, never a run (Goose; Cursor, on the owner's own Cursor API key; Google Antigravity, by the recipe AgentRun
// ships; or an ACP agent a recipe file names: HARNESS.md#a-recipe). The server installed with this command does it (agentrun-serve install-harness), as it runs
// validate-template: the pinned archive downloaded, its sha256 checked, unpacked into DATA/harnesses/<id>, the binary's
// sha256 checked (for Cursor, every file's too; for a recipe that pins none, the first one recorded), then put in place
// read-only. DATA is this command's (~/.agentrun unless --data names one), the store `npx @parcha/agentrun` starts the
// server on. Run again with the pinned release in place, it downloads nothing. No provider key goes near it,
// CURSOR_API_KEY included.
//
// `agentrun harness-check --recipe FILE`: the recipe's installed agent run for real on --model and judged
// (agentrun-serve check-harness, named as install-harness is, so this command's own word stays the CLI's): a JSON
// report, and the three facts printed. It spends, on the model's key.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The harnesses this command installs by name: antigravity by the recipe AgentRun ships (the ACP package's). */
const INSTALLABLE = ["goose", "cursor", "antigravity"];

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
  summary: "Install a harness AgentRun runs only once its owner installs it (goose, cursor, antigravity, or a recipe file's), then restart AgentRun",
  help: [
    ["HARNESS", `the harness: ${INSTALLABLE.join(", ")}. Its pinned release is downloaded and checked by sha256 into DATA/harnesses/HARNESS; run again, it downloads nothing`],
    ["--recipe FILE", "in place of HARNESS: a recipe file (HARNESS.md#a-recipe), checked against its five rules before anything is downloaded; a recipe AgentRun ships by its name (antigravity), unless a file of that name is here (./NAME names it)"],
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
    const which = values.recipe === undefined ? [name] : ["--recipe", values.recipe];
    return spawnSync(launcher, ["install-harness", ...which, "--data", dataOf(values, env)], { stdio: "inherit", env: keyless }).status ?? 1;
  },
};

export const HARNESS_SIGN_IN = {
  command: ["harness", "sign-in"],
  pathParams: [],
  summary: "Sign a recipe's agent in to your own account with the agent's own sign-in, in this terminal (Antigravity's agy acp --login); a server you start with --harness-sign-in on your own machine then runs your own runs on it",
  help: [
    ["--recipe FILE", "the recipe file, whose signIn names the agent's own sign-in flags, or a recipe AgentRun ships by its name (antigravity); its agent installed first with agentrun harness install"],
    ["--data DIR", "the data directory the recipe's agent was installed into (default ~/.agentrun)"],
  ],
  options: { recipe: { type: "string" } },
  async run({ values, env, cli }) {
    if (values.recipe === undefined) throw cli.fail(2, "agentrun harness sign-in needs --recipe FILE.");
    const launcher = await launcherOf(cli, "signs a harness in");
    // The agent prints where to sign in on this terminal itself, and keeps its sign-in in its own folder: no key is
    // needed, so none reaches it.
    const keyless = Object.fromEntries(Object.entries(env).filter(([key]) => !KEY_NAMED.test(key)));
    return spawnSync(launcher, ["sign-in-harness", "--recipe", values.recipe, "--data", dataOf(values, env)], { stdio: "inherit", env: keyless }).status ?? 1;
  },
};

/** The console's page for a plan-billed recipe's keys (serve's harness-keys.ts HARNESS_KEYS_PAGE). */
const HARNESS_KEYS_PAGE = "/#/settings/harness-keys";

export const HARNESS_KEYS = {
  command: ["harness", "keys"],
  pathParams: [],
  summary: "Print the link to Settings → Harness keys, where the owner saves the keys a plan-billed recipe runs on, for that harness alone (exit 1 when no AgentRun has started on DATA)",
  help: [["--data DIR", "the data directory of the AgentRun the keys are for (default ~/.agentrun)"]],
  options: {},
  // Never a key on this terminal: a key is a secret write, the owner's signed-in session's alone, so it is pasted in the
  // console, which keeps it sealed for that harness alone.
  run({ values, env, io }) {
    const data = dataOf(values, env);
    let origin;
    try {
      const record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
      origin = typeof record?.base_url === "string" && URL.canParse(record.base_url) ? new URL(record.base_url).origin : undefined;
    } catch {
      origin = undefined;
    }
    if (origin === undefined) {
      io.stderr.write(`No AgentRun has started on ${data}: start it (agentrun), then save the keys in Settings → Harness keys (${HARNESS_KEYS_PAGE}).\n`);
      return 1;
    }
    io.stdout.write(`${origin}${HARNESS_KEYS_PAGE}\n`);
    return 0;
  },
};

export const HARNESS_CHECK = {
  command: ["harness-check"],
  pathParams: [],
  summary: "Run a recipe's installed agent for real and check it (tools off, env allowlist, pins, limits, no side requests, resume, a denied call, an MCP tool): a JSON report and three facts. Real models cost money",
  help: [
    ["--recipe FILE", "the recipe file (HARNESS.md#a-recipe), or a recipe AgentRun ships by its name (antigravity); its agent installed first with agentrun harness install"],
    ["--model PROVIDER/MODEL", "the run's model, for a recipe billed through the proxy (openrouter/anthropic/claude-haiku-4.5, anthropic/claude-haiku-4-5)"],
    ["--report FILE", "where the JSON report goes (default ./harness-check-ID.json)"],
    ["--cap USD", "the most the check may spend (default 0.25)"],
    ["--data DIR", "the data directory the recipe's agent was installed into (default ~/.agentrun)"],
  ],
  options: { recipe: { type: "string" }, model: { type: "string" }, report: { type: "string" }, cap: { type: "string" } },
  async run({ values, env, cli }) {
    if (values.recipe === undefined) throw cli.fail(2, "agentrun harness-check needs --recipe FILE.");
    const launcher = await launcherOf(cli, "checks a harness");
    const flags = ["--recipe", values.recipe, "--data", dataOf(values, env)];
    if (values.model !== undefined) flags.push("--model", values.model);
    if (values.report !== undefined) flags.push("--report", resolve(values.report));
    if (values.cap !== undefined) flags.push("--cap", values.cap);
    // The model's key goes to the server's launcher, which holds it in memory (its SECRETS) and hands it to no agent.
    return spawnSync(launcher, ["check-harness", ...flags], { stdio: "inherit", env }).status ?? 1;
  },
};
