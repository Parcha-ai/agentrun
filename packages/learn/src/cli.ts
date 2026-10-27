#!/usr/bin/env node
// agentrun-learn check: validates a run's branch of an agent's learning repository against SPEC.md, before any merge.
// Exit 0 passes, 1 reports problems, 2 is a bad command line or a ref that names no commit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MergePolicy, PathClass } from "./check.js";
import { checkBranch, insideRepo, RefError } from "./git.js";
import { MIN_SECRET } from "./secrets.js";

const USAGE = `usage: agentrun-learn check --base <ref> [--head <ref>] [--branch runs/<run id>] [--run-base <ref>] [--tools <file.json>] [--auto-merge skill,workflow] [--refuse-values-from-env NAME,...] [--json]

  --base       the ref the run's branch merges into, such as main or origin/main
  --head       the run's commit (default HEAD)
  --branch     the branch the run pushes (default: the branch --head names)
  --run-base   the commit the host started the run from; the memo's base must be it (default: the branch's fork point)
  --tools      the host's tool list, a JSON array of tool names or {"tools": [...]}; without it a draft that names a
               tool is refused
  --auto-merge path classes that merge without a person, beyond notes, the index and the memo
  --refuse-values-from-env  environment variables whose values no file may hold; a value is never printed
  --json       print {ok, merge, run, branch, forkPoint, problems, paths} as JSON`;

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

function autoMerge(spec: string | undefined): Partial<MergePolicy> {
  const classes = (spec ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  for (const name of classes) if (!["note", "index", "memo", "skill", "workflow"].includes(name)) throw new UsageError(`--auto-merge takes note, index, memo, skill or workflow, not ${name}`);
  return Object.fromEntries(classes.map((name) => [name as PathClass, "auto"]));
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
      "auto-merge": { type: "string" }, "refuse-values-from-env": { type: "string" }, json: { type: "boolean" },
    },
  });
  if (!values.base) throw new UsageError("--base is required");
  const cwd = process.cwd();
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
    policy: autoMerge(values["auto-merge"]),
    refuseValues: refuseValues(values["refuse-values-from-env"]),
  });
  const ok = report.problems.length === 0;
  if (values.json) console.log(JSON.stringify({ ok, ...report }, null, 2));
  else {
    const name = report.branch ?? "(no branch)";
    if (ok) console.log(`${name}: ok, ${report.merge === "auto" ? "merges once the injection screen passes" : "a person approves the merge"}`);
    else console.log(`${name}: ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}`);
    for (const problem of report.problems) console.log(`  ${problem.rule}  ${problem.path ?? "-"}  ${problem.detail}`);
    if (ok) for (const path of report.paths) console.log(`  ${path.class}  ${path.path}  ${path.merge}`);
  }
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof RefError) console.error(error.message);
    else if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error(`${(error as Error).message}\n${USAGE}`);
    else console.error(error);
    process.exit(2);
  },
);
