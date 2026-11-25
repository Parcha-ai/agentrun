// The OpenTelemetry SDK writes to the api's `diag` logger, and one of its writes quotes a header value as sent
// (otlp-exporter-base: `Header "${key}" has invalid value (${value}) and will be ignored`). No source sets a diag
// logger, so those writes go nowhere. A logger set later would print them past the tracer's saidOf, which is where an
// OTLP header value is cut at any length. This guard reads every source under packages/*/src and apps/*/src (not dist,
// node_modules or tests) and fails on a `setLogger(` call or on any `OTEL_LOG_LEVEL` in code. It reads files with fs
// and shells out to nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[^.]+$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__"]);
const WHY = "the OTel diag logger can quote an OTLP header value; route it through the tracer's saidOf before setting one";

const RULES = [
  { said: "sets a diag logger (setLogger)", match: /(^|[^\w$])setLogger\s*\(/ },
  { said: "sets OTEL_LOG_LEVEL, which turns on a diag logger", match: /\bOTEL_LOG_LEVEL\b/ },
];

function sourcesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...sourcesUnder(path));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function sourceRoots() {
  const roots = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(ROOT, group, entry.name, "src");
      try {
        readdirSync(src);
      } catch {
        continue;
      }
      roots.push(src);
    }
  }
  return roots;
}

// Block comments become spaces (their newlines kept, so line numbers hold), and a line that is only a `//` comment is
// skipped. A comment after code on the same line is still read: the guard errs toward firing.
function codeLines(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return blanked.split("\n").map((line) => (/^\s*\/\//.test(line) ? "" : line));
}

test("no source sets an OpenTelemetry diag logger: its writes could quote an OTLP header value past the tracer's saidOf", () => {
  const files = sourceRoots().flatMap(sourcesUnder);
  const read = new Set(files.map((path) => relative(ROOT, path)));
  assert.ok(
    read.has(join("packages", "serve", "src", "otel", "tracer.ts")),
    `the guard read serve's tracer (it read ${read.size} files under packages/*/src and apps/*/src)`,
  );

  const hits = [];
  for (const path of files) {
    codeLines(readFileSync(path, "utf8")).forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.match.test(line)) hits.push(`${relative(ROOT, path)}:${i + 1} ${rule.said}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `${WHY}.\n${hits.join("\n")}`);
});
