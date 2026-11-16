// `agentrun template validate DIR`: a template package folder checked on this machine by the server's own validator,
// the one a server runs on the packages it ships at its start. The server installed with this command checks it
// (agentrun-serve validate-template), as it runs import and reset-password: this command reaches the server through its
// launcher and its API alone. Nothing in the package runs.
import { spawn, spawnSync } from "node:child_process";
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

// `agentrun template install SOURCE`: a package on GitHub imported into the server (POST /v2/templates/import), which
// resolves the ref to a commit, reads the package at it and checks it as it checks its own; nothing in it runs. With
// --dry-run the package is shown whole (its instructions and every skill file) and stored nowhere. The first package from
// a publisher needs --trust, said once, after reading it. Prints what was imported and the console page that applies it.
export const TEMPLATE_INSTALL = {
  command: ["template", "install"],
  pathParams: ["source"],
  summary: "Import a template package from GitHub (github:OWNER/REPO[/PATH][@REF]) and print the console page that applies it",
  help: [
    ["SOURCE", "github:OWNER/REPO[/PATH][@REF], or https://github.com/OWNER/REPO/tree/REF/PATH. The ref is resolved to a commit first"],
    ["--dry-run", "check the package and print it whole (instructions, skill files); store nothing"],
    ["--trust", "trust the package's publisher (the GitHub owner): the first package from one needs it"],
  ],
  options: { "dry-run": { type: "boolean" }, trust: { type: "boolean" } },
  async run({ values, args, env, io, cli }) {
    const client = cli.clientOf(cli.targetOf(values, env), io);
    let refusal = "";
    const refused = client.refused;
    client.refused = (response, bytes) => ((refusal = bytes.toString("utf8")), refused(response, bytes));
    const body = JSON.stringify({ source: args[0], ...(values["dry-run"] ? { dry_run: true } : {}), ...(values.trust ? { trust_publisher: true } : {}) });
    const { response, bytes, code } = await cli.request(client, { method: "POST", path: "/templates/import", body, type: "application/json" });
    if (code !== undefined) {
      // The one refusal this command has a flag for: say it, after the server's error.
      if (!values.trust && /"field"\s*:\s*"trust_publisher"/.test(refusal)) io.stderr.write(`Read it first (--dry-run), then run this again with --trust.\n`);
      return code;
    }
    let answer;
    try {
      answer = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw cli.fail(1, `The server's answer (${response.status}) is not JSON.`);
    }
    const { template = {}, stored, replaced, publisher_trusted, console_url } = answer;
    const summary = { id: template.id, source: template.source, sha: template.sha, publisher: template.publisher, publisher_trusted, stored, replaced, console_url };
    client.print(values["dry-run"] ? { ...summary, instructions: answer.instructions, skill_files: answer.skill_files, template } : summary);
    if (!io.stdout.isTTY) return 0;
    // The install it suggests is pinned to the commit just shown: a branch that moves since is not what was read.
    io.stderr.write(stored ? `Apply it: ${console_url}\n` : `Nothing stored. Install what you read: agentrun template install ${template.id}@${template.sha}${publisher_trusted ? "" : " --trust"}\n`);
    return 0;
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
    // A stop sent to this command alone (a job runner's SIGTERM, a SIGHUP) is passed on to the eval, which cancels its
    // run and cleans up before it exits, as it does on the Ctrl-C a terminal sends both: this command waits for that.
    const child = spawn(launcher, argv, { stdio: "inherit", env: childEnv });
    const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    // The eval stops on SIGINT and SIGTERM; a hangup is passed on as a SIGTERM, which it cleans up after.
    const pass = Object.fromEntries(Object.keys(signals).map((signal) => [signal, () => child.kill(signal === "SIGHUP" ? "SIGTERM" : signal)]));
    for (const [signal, on] of Object.entries(pass)) process.on(signal, on);
    try {
      return await new Promise((done) => {
        child.on("error", () => done(1));
        child.on("exit", (code, signal) => done(code ?? signals[signal] ?? 1));
      });
    } finally {
      for (const [signal, on] of Object.entries(pass)) process.off(signal, on);
    }
  },
};
