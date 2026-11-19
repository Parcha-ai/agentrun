// `agentrun harness install goose|cursor`: the harnesses their owner installs, never a run (Goose; Cursor, on the owner's
// own Cursor API key). The server installed with this command does it (agentrun-serve install-harness), as it runs
// validate-template: the pinned archive downloaded, its sha256 checked, unpacked into DATA/harnesses/<harness>, the
// binary's sha256 checked (and, for Cursor, every file's), then put in place read-only. DATA is this command's
// (~/.agentrun unless --data names one), the store `npx @parcha/agentrun` starts the server on. Run again with the pinned
// release in place, it downloads nothing. No provider key goes near it, CURSOR_API_KEY included.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The harnesses this command installs. */
const INSTALLABLE = ["goose", "cursor"];

/** A variable named like a credential (a KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL(S) segment). */
const KEY_NAMED = /(?:^|_)(?:KEY|TOKEN|TOKENS|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

export const HARNESS_INSTALL = {
  command: ["harness", "install"],
  pathParams: ["harness"],
  summary: "Install a harness AgentRun runs only once its owner installs it (goose, cursor), then restart AgentRun",
  help: [
    ["HARNESS", `the harness: ${INSTALLABLE.join(", ")}. Its pinned release is downloaded and checked by sha256 into DATA/harnesses/HARNESS; run again, it downloads nothing`],
    ["--data DIR", "the data directory of the AgentRun it is for (default ~/.agentrun, where npx @parcha/agentrun keeps it)"],
  ],
  options: {},
  async run({ values, args, env, cli }) {
    const [name] = args;
    if (!INSTALLABLE.includes(name)) throw cli.fail(2, `agentrun harness install installs ${INSTALLABLE.join(", ")}, not ${name}: claude-agent and codex install on first use, and pi and opencode come with AgentRun.`);
    // Loaded here: start.mjs loads cli.mjs, which loads this module.
    const { installedServer } = await import("./start.mjs");
    const launcher = installedServer();
    if (launcher === undefined) throw cli.fail(2, "AgentRun's server is not installed beside this command, and it is the server that installs a harness.");
    const data = resolve(values.data ?? join(env.HOME || homedir(), ".agentrun"));
    // No key reaches the install: every variable named like one is left out of its environment.
    const keyless = Object.fromEntries(Object.entries(env).filter(([key]) => !KEY_NAMED.test(key)));
    return spawnSync(launcher, ["install-harness", name, "--data", data], { stdio: "inherit", env: keyless }).status ?? 1;
  },
};
