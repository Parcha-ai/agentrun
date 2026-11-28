#!/usr/bin/env node
// The known answer for a home: one JSONL line per session, sorted by key, numbers only (no content, title, directory or
// path), so two readers of the same home can be compared line for line.
//   node dist/cli.js <home> [--sources claude-code,codex,pi,opencode,copilot,cursor] [--threads N] [--read-ahead BYTES] --known-answer
// A line: {key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h}, cost, turns, calls}. key is the
// sha256 of the session file's path relative to <home>, with "#<session id>" after it for a file of many sessions (an
// OpenCode database); turns, the person's user messages; calls, model requests (its subagents' with them); cost, USD,
// null when unknown. --threads and --read-ahead are parseHome's `threads` and
// `readAhead` (BYTES: a whole number, or with k, m or g after it for KiB, MiB or GiB); fewer threads or a smaller
// read-ahead hold less memory.
//   node dist/cli.js <home> [--sources claude-code,codex,pi] --cache
// (the sources that write a chain, CACHE_SOURCES: another is a usage error).
// The cache analyzer's answer, keyed the same way: a line per session, {key, source, hitRate, breaks: [{turn, at, dropPct,
// rewritten, extraCost, cause}]} (a subagent's break with its subagent's number), then one totals line: {totals:
// {sessions, breaks, extraCost, unpriced}}, the breaks and their extra cost by cause. Numbers and cause names only. It
// reads one file at a time, so --threads and --read-ahead do not apply to it.
// --help (-h) prints the usage and exits 0; a usage error exits 2.
// A file that cannot be read makes the answer incomplete: no line is printed, one stderr line names each such file by
// its source, key and error code (never its path), and the exit is 1.
//
// pi-ai is imported here, statically: the prices are part of the answer, so a bundle (bun build --compile) carries it,
// and a run without it fails at startup instead of printing lines that price nothing. The library loads it only to price.
import { parseArgs } from "node:util";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CACHE_SOURCES, cacheHome, cacheTotals } from "./cache.js";
import { MOST_THREADS, parseHome, type ReadFailure } from "./home.js";
import { type CalculateCost, catalogOf } from "./price.js";
import { SOURCES, type Source } from "./readers/index.js";

const USAGE = `usage: agentrun-import <home> [--sources ${SOURCES.join(",")}] [--threads N] [--read-ahead BYTES[k|m|g]] --known-answer | --cache`;

const UNITS: Record<string, number> = { "": 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30 };

/** A flag's whole number (with a unit when `units`), or a usage error. */
function wholeOf(flag: string, value: string, least: number, units = false, most = Number.MAX_SAFE_INTEGER): number {
  const match = (units ? /^(\d+)([kmg]?)$/i : /^(\d+)()$/).exec(value.trim());
  const n = match ? Number(match[1]) * UNITS[match[2]!.toLowerCase()]! : Number.NaN;
  if (!Number.isSafeInteger(n) || n < least || n > most) usage(`${flag}: a whole number ${most < Number.MAX_SAFE_INTEGER ? `from ${least} to ${most}` : `of at least ${least}`}${units ? " (k, m or g after it for KiB, MiB, GiB)" : ""}, not ${value}`);
  return n;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

/** An error's code (EACCES, EIO), never its message, which names the path. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "error";
};

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { sources: { type: "string" }, threads: { type: "string" }, "read-ahead": { type: "string" }, "known-answer": { type: "boolean" }, cache: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    usage((error as Error).message);
  }
  const { positionals, values } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (positionals.length !== 1) usage("one home directory, please");
  if (!values["known-answer"] === !values.cache) usage("one output, please: --known-answer or --cache");
  const known: readonly string[] = values.cache ? CACHE_SOURCES : SOURCES;
  // A source named twice is read once: a repeat would print its every session twice.
  const sources = values.sources === undefined ? known : [...new Set(values.sources.split(",").map((name) => name.trim()))];
  const unknown = sources.filter((name) => !known.includes(name));
  if (unknown.length || !sources.length) usage(`unknown source: ${unknown.join(", ") || "(none)"}`);
  const threads = values.threads === undefined ? undefined : wholeOf("--threads", values.threads, 1, false, MOST_THREADS);
  const readAhead = values["read-ahead"] === undefined ? undefined : wholeOf("--read-ahead", values["read-ahead"], 0, true);
  const failures: ReadFailure[] = [];
  const options = { sources: sources as Source[], catalog: catalogOf(builtinModels().getModels()), calculateCost: calculateCost as unknown as CalculateCost, failures };
  const failed = (): boolean => {
    for (const { source, key, error } of failures) process.stderr.write(`agentrun-import: cannot read ${source} ${key} (${codeOf(error)})\n`);
    if (failures.length) process.exitCode = 1;
    return failures.length > 0;
  };
  if (values.cache) {
    const caches = await cacheHome(positionals[0]!, options);
    if (failed()) return;
    for (const { key, source, hitRate, breaks } of caches) {
      const listed = breaks.map(({ turn, at, dropPct, rewritten, extraCost, cause, subagent }) => ({ turn, at, dropPct, rewritten, extraCost, cause, ...(subagent !== undefined ? { subagent } : {}) }));
      process.stdout.write(`${JSON.stringify({ key, source, hitRate, breaks: listed })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ totals: cacheTotals(caches) })}\n`);
    return;
  }
  const sessions = await parseHome(positionals[0]!, { ...options, ...(threads === undefined ? {} : { threads }), ...(readAhead === undefined ? {} : { readAhead }) });
  if (failed()) return;
  for (const { key, source, tokens, cost, turns, calls } of sessions) {
    const { input, output, cacheRead, cacheWrite, cacheWrite1h } = tokens;
    process.stdout.write(`${JSON.stringify({ key, source, tokens: { input, output, cacheRead, cacheWrite, cacheWrite1h }, cost, turns, calls })}\n`);
  }
}

await main();
