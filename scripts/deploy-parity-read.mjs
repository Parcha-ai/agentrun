// Deploy parity, the I/O half: one agent read from an install (readAgent), and the command that reads it on a source and
// a target and prints the pure check's answer (deploy-parity.mjs).
//
//   node scripts/deploy-parity-read.mjs --source URL --source-agent ID --target URL (--target-agent ID | --lock FILE)
//       [--accept-unread FIELD,...]
//
// URL is an install's address or API base (…/v2). Tokens come from the environment alone, never an argument:
// AGENTRUN_PARITY_SOURCE_TOKEN and AGENTRUN_PARITY_TARGET_TOKEN. --lock reads the target's agent from the lock a deploy
// wrote (DIR/.agentrun/deploy.json), and never its address: the target token goes to --target alone, and a lock that
// names another target is refused with nothing sent. It prints `{pass, differences, unread, warnings}` as JSON and exits
// 0 when the agent is the same on both (no difference, and every field read on both sides or named in --accept-unread),
// 1 when it is not, 2 when it could not check (bad input, an agent not read), with one line on stderr.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { apiBase } from "../packages/agentrun/lib/target.mjs";
import { describeAgent, parityDiff, readinessOf, unreadFields } from "./deploy-parity.mjs";
import { isMain } from "./is-main.mjs";

const enc = encodeURIComponent;
const bodyOf = (answer) => (answer.status === 200 && answer.body !== null && typeof answer.body === "object" ? answer.body : null);

/** A package file's (`{path, encoding, content}`) path and the sha256 of its bytes; none for a file with no content. */
const hashed = (file) => ({ path: file?.path, sha256: typeof file?.content === "string" ? createHash("sha256").update(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")).digest("hex") : undefined });

/** The agent `agentId` as the install `api` answers for it: `api(method, path, body?)` resolves `{status, body}` for a
 *  path under /v2. The agent's own read is required; each other read is null when the install does not serve it. The
 *  package's files are kept by their content hashes alone (`packageFiles`). The plan is a dry run, which writes
 *  nothing. */
export async function readAgent(api, agentId) {
  const agent = await api("GET", `/agents/${enc(agentId)}`);
  if (!bodyOf(agent)) throw new Error(`The agent ${agentId}: ${agent.status} ${agent.body?.error?.message ?? ""}`.trim());
  const triggers = bodyOf(await api("GET", "/triggers"))?.triggers ?? null;
  const servers = bodyOf(await api("GET", "/settings/mcp-servers"))?.servers ?? null;
  const files = bodyOf(await api("GET", `/agents/${enc(agentId)}/package`))?.files;
  const packageFiles = Array.isArray(files) ? files.map(hashed) : null;
  const ref = agent.body.template;
  const template = ref?.id ? bodyOf(await api("GET", `/templates/${enc(ref.id)}`)) : null;
  const plan = ref?.id ? (bodyOf(await api("POST", `/templates/${enc(ref.id)}/apply`, { dry_run: true, agent_id: agentId }))?.plan ?? null) : null;
  return { agent: agent.body, triggers, servers, template, plan, packageFiles };
}

/** An install's API at `base` (…/v2) over HTTP, with `token` when given. */
export function httpApi(base, token) {
  return async (method, path, body) => {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    return { status: response.status, body: value };
  };
}

/** The check's answer for the source's and the target's reads: pass when there is no difference and nothing unread but
 *  the fields `accepted` names. */
export function parityOf(source, target, accepted = []) {
  const a = describeAgent(source);
  const b = describeAgent(target);
  const differences = parityDiff(a, b);
  const unread = unreadFields(a, b).map((one) => ({ ...one, accepted: accepted.includes(one.field) }));
  const warnings = readinessOf({ agent: target.agent, plan: target.plan });
  return { pass: differences.length === 0 && unread.every((one) => one.accepted), differences, unread, warnings };
}

const USAGE = "--source URL --source-agent ID --target URL, and --target-agent ID or --lock FILE";

/** The command's arguments read: `{source, sourceAgent, target, targetAgent, accepted}`, or `{refused}` in one line. The
 *  lock gives the target's agent id alone, and only for the target --target names. */
function argsOf(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { source: { type: "string" }, "source-agent": { type: "string" }, target: { type: "string" }, "target-agent": { type: "string" }, lock: { type: "string" }, "accept-unread": { type: "string" } } }));
  } catch (error) {
    return { refused: `${error.message} (${USAGE})` };
  }
  const { source, "source-agent": sourceAgent, target } = values;
  if (!source || !sourceAgent || !target || (!values["target-agent"] && !values.lock)) return { refused: USAGE };
  let targetAgent = values["target-agent"];
  if (values.lock) {
    let lock;
    try {
      lock = JSON.parse(readFileSync(values.lock, "utf8"));
    } catch (error) {
      return { refused: `the lock ${values.lock} can't be read: ${error.code ?? error.message}` };
    }
    if (typeof lock?.target !== "string" || apiBase(lock.target) !== apiBase(target)) return { refused: `the lock ${values.lock} names the target ${lock?.target}, not --target ${target}: nothing was sent` };
    targetAgent ??= lock.agent_id;
    if (typeof targetAgent !== "string" || !targetAgent) return { refused: `the lock ${values.lock} names no agent_id` };
  }
  const accepted = (values["accept-unread"] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  return { source: apiBase(source), sourceAgent, target: apiBase(target), targetAgent, accepted };
}

async function main(argv, env) {
  const args = argsOf(argv);
  if (args.refused) {
    process.stderr.write(`deploy-parity: ${args.refused.replace(/\s+/g, " ")}\n`);
    return 2;
  }
  const { accepted } = args;
  let source;
  let there;
  try {
    source = await readAgent(httpApi(args.source, env.AGENTRUN_PARITY_SOURCE_TOKEN), args.sourceAgent);
    there = await readAgent(httpApi(args.target, env.AGENTRUN_PARITY_TARGET_TOKEN), args.targetAgent);
  } catch (error) {
    // Only the message and the cause's code: a fetch error can quote a header.
    process.stderr.write(`deploy-parity: ${error?.cause?.code ?? error?.message}\n`);
    return 2;
  }
  const answer = parityOf(source, there, accepted);
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  for (const one of answer.differences) process.stderr.write(`  ${one.kind.padEnd(7)} ${one.field}\n`);
  for (const one of answer.unread) process.stderr.write(`  unread  ${one.field} (${one.side}${one.accepted ? ", accepted" : ""}): ${one.why}\n`);
  for (const one of answer.warnings) process.stderr.write(`  warning ${one.kind} ${one.field}\n`);
  process.stderr.write(answer.pass ? "PASS: the same agent on both installs.\n" : "FAIL: the agent differs, or a field was not read on both.\n");
  return answer.pass ? 0 : 1;
}

if (isMain(import.meta)) process.exitCode = await main(process.argv.slice(2), process.env);
