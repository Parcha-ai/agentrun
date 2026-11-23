#!/usr/bin/env node
// The known answer for a home: one JSONL line per session, sorted by key, numbers only (no content, title, directory or
// path), so two readers of the same home can be compared line for line.
//   node dist/cli.js <home> [--sources claude-code,codex,pi] --known-answer
// A line: {key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h}, cost, turns, calls}. key is the
// sha256 of the session file's path relative to <home>; turns, the person's user messages; calls, model requests (its
// subagents' with them); cost, USD, null when unknown. Exit 2 on a usage error.
import { parseArgs } from "node:util";
import { parseHome } from "./home.js";
import { SOURCES, type Source } from "./readers/index.js";

const USAGE = `usage: agentrun-import <home> [--sources ${SOURCES.join(",")}] --known-answer`;

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { sources: { type: "string" }, "known-answer": { type: "boolean" } } });
  } catch (error) {
    usage((error as Error).message);
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) usage("one home directory, please");
  if (!values["known-answer"]) usage("--known-answer is the one output there is");
  const sources = values.sources === undefined ? SOURCES : values.sources.split(",").map((name) => name.trim());
  const unknown = sources.filter((name) => !(SOURCES as readonly string[]).includes(name));
  if (unknown.length || !sources.length) usage(`unknown source: ${unknown.join(", ") || "(none)"}`);
  const sessions = await parseHome(positionals[0]!, { sources: sources as Source[] });
  for (const { key, source, tokens, cost, turns, calls } of sessions) {
    const { input, output, cacheRead, cacheWrite, cacheWrite1h } = tokens;
    process.stdout.write(`${JSON.stringify({ key, source, tokens: { input, output, cacheRead, cacheWrite, cacheWrite1h }, cost, turns, calls })}\n`);
  }
}

await main();
