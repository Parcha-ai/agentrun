// The OpenTelemetry SDK writes to the api's `diag` logger, and one of its writes quotes a header value as sent
// (otlp-exporter-base: `Header "${key}" has invalid value (${value}) and will be ignored`). No source sets a diag
// logger, so those writes go nowhere. A logger set later would print them past the tracer's saidOf, which is where an
// OTLP header value is cut at any length. This guard reads every source under packages/*/src and apps/*/src (not dist,
// node_modules or tests) and fails on any `setLogger` in code (a call, `.call`/`.apply`, or `["setLogger"]`), on any
// `OTEL_LOG_LEVEL` in code, and on `@opentelemetry/sdk-node` in code or in a package's dependencies (its NodeSDK sets a
// diag logger from OTEL_LOG_LEVEL itself). It reads files with fs and shells out to nothing. A dependency's own code is
// not read: the guard covers what this repo writes and what it chooses to depend on.
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
const SDK_NODE = "@opentelemetry/sdk-node";

const RULES = [
  { said: "sets a diag logger (setLogger)", match: /(^|[^\w$])setLogger\b/ },
  { said: "sets OTEL_LOG_LEVEL, which turns on a diag logger", match: /\bOTEL_LOG_LEVEL\b/ },
  { said: `loads ${SDK_NODE}, whose NodeSDK sets a diag logger from OTEL_LOG_LEVEL`, match: /@opentelemetry\/sdk-node\b/ },
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

/** Each package dir under packages/ and apps/. */
function packageDirs() {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(ROOT, group, entry.name)));
}

function sourceRoots() {
  return packageDirs().map((dir) => join(dir, "src")).filter((src) => {
    try {
      readdirSync(src);
      return true;
    } catch {
      return false;
    }
  });
}

// Block comments become spaces (their newlines kept, so line numbers hold), and a line that is only a `//` comment is
// skipped. A comment after code on the same line is still read: the guard errs toward firing.
function codeLines(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return blanked.split("\n").map((line) => (/^\s*\/\//.test(line) ? "" : line));
}

/** `text`'s hits, as `<line> <rule>: <code>`. */
function hitsIn(text) {
  return codeLines(text).flatMap((line, i) => RULES.filter((rule) => rule.match.test(line)).map((rule) => `${i + 1} ${rule.said}: ${line.trim()}`));
}

test("the diag guard's rules fire on each way to set a diag logger, and on none of the code that only looks like one", () => {
  const firing = [
    "diag.setLogger(new DiagConsoleLogger());",
    "diag.setLogger.call(diag, logger, DiagLogLevel.DEBUG);",
    'diag["setLogger"](logger);',
    "const { setLogger } = diag; setLogger(logger);",
    'process.env.OTEL_LOG_LEVEL = "debug";',
    'import { NodeSDK } from "@opentelemetry/sdk-node";',
  ];
  for (const line of firing) assert.equal(hitsIn(line).length > 0, true, `fires on: ${line}`);
  const quiet = ["// diag.setLogger(new DiagConsoleLogger());", "/* diag.setLogger(x) */ const kept = 1;", "resetLogger(x);", "const setLoggers = [];", 'import { diag } from "@opentelemetry/api";'];
  for (const line of quiet) assert.deepEqual(hitsIn(line), [], `quiet on: ${line}`);
});

test("no source sets an OpenTelemetry diag logger: its writes could quote an OTLP header value past the tracer's saidOf", () => {
  const files = sourceRoots().flatMap(sourcesUnder);
  const read = new Set(files.map((path) => relative(ROOT, path)));
  assert.ok(
    read.has(join("packages", "serve", "src", "otel", "tracer.ts")),
    `the guard read serve's tracer (it read ${read.size} files under packages/*/src and apps/*/src)`,
  );

  const hits = files.flatMap((path) => hitsIn(readFileSync(path, "utf8")).map((hit) => `${relative(ROOT, path)}:${hit}`));
  for (const dir of packageDirs()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      if (manifest[field]?.[SDK_NODE] !== undefined) hits.push(`${relative(ROOT, join(dir, "package.json"))} ${field} names ${SDK_NODE}, whose NodeSDK sets a diag logger from OTEL_LOG_LEVEL`);
    }
  }
  assert.deepEqual(hits, [], `${WHY}.\n${hits.join("\n")}`);
});
