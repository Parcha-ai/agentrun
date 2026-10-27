#!/usr/bin/env node
// agentrun-learn check: validates a run's branch of an agent's learning repository against SPEC.md, before any merge.
// Exit 0 passes, 1 reports problems, 2 is a bad command line or a ref that names no commit.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkBranch, RefError } from "./git.js";
import { MIN_SECRET } from "./secrets.js";
import type { ToolPolicy } from "./tools.js";

const USAGE = `usage: agentrun-learn check --base <ref> [--head <ref>] [--branch runs/<run id>] [--tools <file.json>] [--refuse-values-from-env NAME,...] [--json]

  --base     the ref the run's branch merges into, such as main or origin/main
  --head     the run's commit (default HEAD)
  --branch   the branch the run pushes (default: the branch --head names)
  --tools    JSON {"shared": [...], "harnesses": {"<harness>": [...]}}: shared replaces the default tool layer,
             harnesses add built-in names
  --refuse-values-from-env  environment variables whose values no file may hold; a value is never printed
  --json     print {ok, run, branch, forkPoint, problems} as JSON`;

class UsageError extends Error {}

function toolsFrom(file: string): Partial<ToolPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`--tools ${file} is not a readable JSON file`);
  }
  const names = (value: unknown) => Array.isArray(value) && value.every((name) => typeof name === "string");
  const { shared, harnesses, ...rest } = (parsed ?? {}) as { shared?: unknown; harnesses?: unknown };
  const harnessesOk = harnesses === undefined || (typeof harnesses === "object" && harnesses !== null && !Array.isArray(harnesses) && Object.values(harnesses).every(names));
  if (typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(rest).length || (shared !== undefined && !names(shared)) || !harnessesOk) {
    throw new UsageError(`--tools ${file} holds only "shared", a list of names, and "harnesses", lists of names by harness`);
  }
  return { ...(shared ? { shared: shared as string[] } : {}), ...(harnesses ? { harnesses: harnesses as Record<string, string[]> } : {}) };
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
    options: { base: { type: "string" }, head: { type: "string" }, branch: { type: "string" }, tools: { type: "string" }, "refuse-values-from-env": { type: "string" }, json: { type: "boolean" } },
  });
  if (!values.base) throw new UsageError("--base is required");
  const report = await checkBranch({
    cwd: process.cwd(),
    base: values.base,
    ...(values.head ? { head: values.head } : {}),
    ...(values.branch ? { branch: values.branch } : {}),
    ...(values.tools ? { tools: toolsFrom(values.tools) } : {}),
    refuseValues: refuseValues(values["refuse-values-from-env"]),
  });
  const ok = report.problems.length === 0;
  if (values.json) console.log(JSON.stringify({ ok, ...report }, null, 2));
  else {
    const name = report.branch ?? "(no branch)";
    console.log(ok ? `${name}: ok` : `${name}: ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}`);
    for (const problem of report.problems) console.log(`  ${problem.rule}  ${problem.path ?? "-"}  ${problem.detail}`);
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
