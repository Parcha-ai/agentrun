#!/usr/bin/env node
// The known answer for a home: one JSONL line per session, sorted by key, numbers only (no content, title, directory or
// path), so two readers of the same home can be compared line for line.
//   node dist/cli.js <home> [--sources claude-code,codex,pi,opencode] --known-answer
// A line: {key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h}, cost, turns, calls}. key is the
// sha256 of the session file's path relative to <home>, with "#<session id>" after it for a file of many sessions (an
// OpenCode database); turns, the person's user messages; calls, model requests (its subagents' with them); cost, USD,
// null when unknown. --help (-h) prints the usage and exits 0; a usage error exits 2.
//
// pi-ai is imported here, statically: the prices are part of the answer, so a bundle (bun build --compile) carries it,
// and a run without it fails at startup instead of printing lines that price nothing. The library keeps it optional.
import { parseArgs } from "node:util";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { parseHome } from "./home.js";
import { type CalculateCost, catalogOf } from "./price.js";
import { SOURCES, type Source } from "./readers/index.js";

const USAGE = `usage: agentrun-import <home> [--sources ${SOURCES.join(",")}] --known-answer`;

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { sources: { type: "string" }, "known-answer": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    usage((error as Error).message);
  }
  const { positionals, values } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (positionals.length !== 1) usage("one home directory, please");
  if (!values["known-answer"]) usage("--known-answer is the one output there is");
  const sources = values.sources === undefined ? SOURCES : values.sources.split(",").map((name) => name.trim());
  const unknown = sources.filter((name) => !(SOURCES as readonly string[]).includes(name));
  if (unknown.length || !sources.length) usage(`unknown source: ${unknown.join(", ") || "(none)"}`);
  const sessions = await parseHome(positionals[0]!, { sources: sources as Source[], catalog: catalogOf(builtinModels().getModels()), calculateCost: calculateCost as unknown as CalculateCost });
  for (const { key, source, tokens, cost, turns, calls } of sessions) {
    const { input, output, cacheRead, cacheWrite, cacheWrite1h } = tokens;
    process.stdout.write(`${JSON.stringify({ key, source, tokens: { input, output, cacheRead, cacheWrite, cacheWrite1h }, cost, turns, calls })}\n`);
  }
}

await main();
