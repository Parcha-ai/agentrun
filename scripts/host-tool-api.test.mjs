// A host tool (serve/src/host-tools.ts) runs one of pi's tools, or one of serve's own, for another harness, outside any
// pi tool task, with an api serve builds by hand: the members HOST_API_MEMBERS lists. pi 1.5's read began reading two
// members that api lacked (api.agent and api.models, for an image's limits), and every image a claude-agent or codex
// run read failed. This reads every `api.<member>` in pi's tool sources and in serve's host tools, and fails on one the
// host api does not give, until the api gives it or the member is shown unreachable from a host tool and listed below.
// It runs in CI with the root suites (test:release, scripts/*.test.mjs).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST_TOOLS = join(repo, "packages/serve/src/host-tools.ts");
/** pi's tools a host tool runs (CodingTools, pi-durable dist/tools), and serve's own host tools. */
const PI_TOOLS = join(repo, "node_modules/@earendil-works/pi-durable/dist/tools");
const SERVE_TOOLS = ["background.ts", "learned-workflow.ts", "monid.ts", "paid-calls.ts", "web-fetch.ts", "web-search.ts"].map((file) => join(repo, "packages/serve/src", file));
/** Members a tool reads that a host tool never reaches, each with why. None today. */
const UNREACHABLE = {};

/** The members host-tools.ts gives, read from its HOST_API_MEMBERS literal. */
function given() {
  const literal = /export const HOST_API_MEMBERS = \[([^\]]*)\]/.exec(readFileSync(HOST_TOOLS, "utf8"))?.[1];
  assert.ok(literal, "host-tools.ts exports HOST_API_MEMBERS as one array literal");
  return new Set([...literal.matchAll(/"([a-zA-Z_]+)"/g)].map((match) => match[1]));
}

/** Each `api.<member>` a file reads, with where; a URL's host (`https://api.example`) is no read. */
function reads(file) {
  return readFileSync(file, "utf8").split("\n").flatMap((line, at) => [...line.matchAll(/(?<![\w./])api\.([a-zA-Z_]+)/g)].map((match) => ({ member: match[1], at: `${file.slice(repo.length + 1)}:${at + 1}` })));
}

test("every api member pi's tools and serve's host tools read is one a host tool's api gives", () => {
  const files = [...readdirSync(PI_TOOLS).filter((name) => name.endsWith(".js")).map((name) => join(PI_TOOLS, name)), ...SERVE_TOOLS];
  const all = files.flatMap(reads);
  assert.ok(all.some((read) => read.member === "env"), "the scan finds pi's tools' api reads");
  const members = given();
  const missing = all.filter((read) => !members.has(read.member) && !Object.hasOwn(UNREACHABLE, read.member));
  assert.deepEqual(missing, [], "each read here is a member HOST_API_MEMBERS gives, or one listed in UNREACHABLE with why");
});

test("the scan reads pi 1.5's image path: read asks the agent and the models", () => {
  const read = reads(join(PI_TOOLS, "read.js")).map((each) => each.member);
  for (const member of ["agent", "models"]) assert.ok(read.includes(member), `read.js reads api.${member}`);
});
