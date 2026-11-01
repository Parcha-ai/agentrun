#!/usr/bin/env node
// agentrun-learn check: validates a run's branch of an agent's learning repository against SPEC.md, before any merge.
// Exit 0 passes, 1 reports problems, 2 is a bad command line or a ref that names no commit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkBranch, insideRepo, RefError } from "./git.js";
import { MIN_SECRET, redactSecrets } from "./secrets.js";

const USAGE = `usage: agentrun-learn check --base <ref> [--head <ref>] [--branch runs/<run id>] [--run-base <ref>] [--tools <file.json>] [--refuse-values-from-env NAME,...] [--json]

  --base       the ref the run's branch merges into, such as main or origin/main
  --head       the run's commit (default HEAD)
  --branch     the branch the run pushes (default: the branch --head names)
  --run-base   the commit the host started the run from; the memo's base must be it (default: the branch's fork point)
  --tools      the host's tool list, a JSON array of tool names or {"tools": [...]}; without it a draft that names a
               tool is refused
  --refuse-values-from-env  environment variables whose values no file may hold; a value is never printed
  --json       print {ok, run, branch, forkPoint, problems} as JSON`;

class UsageError extends Error {}

function toolsFrom(file: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`--tools ${file} is not a readable JSON file`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list) || !list.every((name) => typeof name === "string")) throw new UsageError(`--tools ${file} holds a list of tool names, or {"tools": [...]}`);
  return list;
}

function refuseValues(spec: string | undefined): string[] {
  const values: string[] = [];
  for (const name of (spec ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
    const value = process.env[name];
    if (!value) console.error(`${name} is not set; skipped`);
    else if ([...value].length < MIN_SECRET) console.error(`${name} is shorter than ${MIN_SECRET} characters; skipped`);
    else values.push(value);
  }
  return values;
}

/** The secrets an error line is redacted with, once they are read. */
let printed: readonly string[] = [];

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] !== "check") throw new UsageError("the only command is check");
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      base: { type: "string" }, head: { type: "string" }, branch: { type: "string" }, "run-base": { type: "string" }, tools: { type: "string" },
      "refuse-values-from-env": { type: "string" }, json: { type: "boolean" },
    },
  });
  if (!values.base) throw new UsageError("--base is required");
  const cwd = process.cwd();
  const secrets = refuseValues(values["refuse-values-from-env"]);
  printed = secrets;
  // A tool list kept in the repository is the checker's config: the run may not change it.
  const toolsInRepo = values.tools ? await insideRepo(cwd, resolve(values.tools)) : undefined;
  const report = await checkBranch({
    cwd,
    base: values.base,
    ...(values.head ? { head: values.head } : {}),
    ...(values.branch ? { branch: values.branch } : {}),
    ...(values["run-base"] ? { runBase: values["run-base"] } : {}),
    ...(values.tools ? { tools: toolsFrom(values.tools) } : {}),
    ...(toolsInRepo ? { lockedPaths: [toolsInRepo] } : {}),
    refuseValues: secrets,
  });
  const { ok } = report;
  // Everything printed is redacted: a secret can be a file's name or in the branch's name, not only in a file. Each
  // field on its own, so one that must be redacted whole leaves the rest of the report, and the JSON, readable.
  const hide = (text: string) => redactSecrets(text, secrets);
  const shown = {
    ...report,
    ...(report.run === undefined ? {} : { run: hide(report.run) }),
    ...(report.branch === undefined ? {} : { branch: hide(report.branch) }),
    ...(report.forkPoint === undefined ? {} : { forkPoint: hide(report.forkPoint) }),
    problems: report.problems.map((p) => ({ ...p, ...(p.path === undefined ? {} : { path: hide(p.path) }), detail: hide(p.detail) })),
  };
  if (values.json) console.log(JSON.stringify(shown, null, 2));
  else {
    const name = shown.branch ?? "(no branch)";
    console.log(ok ? `${name}: ok` : `${name}: ${shown.problems.length} problem${shown.problems.length === 1 ? "" : "s"}`);
    for (const problem of shown.problems) console.log(`  ${problem.rule}  ${problem.path ?? "-"}  ${problem.detail}`);
  }
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof RefError) console.error(redactSecrets(error.message, printed));
    else if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error(`${(error as Error).message}\n${USAGE}`);
    else console.error(error);
    process.exit(2);
  },
);
