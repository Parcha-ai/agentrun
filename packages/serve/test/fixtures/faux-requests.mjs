// Each request a gate test's fake model (faux-gate.mjs, faux-mcp.mjs) is asked, as one JSON line in the file
// AGENTRUN_TEST_FAUX_REQUESTS names, when a test sets it: the run (its directory's name, from the run process's --dir, the
// same across a relaunch), the history's roles (s system, u user, a assistant, t tool result), and the length of the last
// message's text, never the text. A test asserts how many requests each run made and prints the roles when it fails.
// A run on an in-process runner has no process of its own: its requests are noted as the runner's process (pid-<pid>),
// and a test tells its runs apart by when each request was noted (notedRequests, read between one run and the next).
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export const REQUESTS_ENV = "AGENTRUN_TEST_FAUX_REQUESTS";
const LETTER = { system: "s", user: "u", assistant: "a", toolResult: "t" };
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
const runOf = () => {
  const at = process.argv.indexOf("--dir");
  return at >= 0 && process.argv[at + 1] ? basename(process.argv[at + 1]) : `pid-${process.pid}`;
};

/** Notes one request of `context`, when the test names a file for them. */
export function noteRequest(context) {
  const file = process.env[REQUESTS_ENV];
  if (!file) return;
  const messages = context?.messages ?? [];
  appendFileSync(file, `${JSON.stringify({ run: runOf(), roles: messages.map((m) => LETTER[m.role] ?? "?").join(""), last: textOf(messages.at(-1)).length })}\n`);
}

/** Every request noted in `file`, in order. */
export const notedRequests = (file) => {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

/** The requests noted in `file` for run `runId`, in order. */
export const requestsOf = (file, runId) => notedRequests(file).filter((request) => request.run === runId);

/** `requests` in a failure message: each one's roles and its last message's text length. */
export const rolesOf = (requests) => requests.map((request) => `${request.roles}(last ${request.last})`).join(" ") || "(none noted)";
