// Deploy parity, the I/O half: one agent read from an install (readAgent), and the command that reads it on a source and
// a target and prints the pure check's answer (deploy-parity.mjs).
//
//   node scripts/deploy-parity-read.mjs --source URL --source-agent ID (--target URL --target-agent ID | --lock FILE)
//       [--accept-unread FIELD,...]
//
// URL is an install's API base (…/v2). Tokens come from the environment alone, never an argument:
// AGENTRUN_PARITY_SOURCE_TOKEN and AGENTRUN_PARITY_TARGET_TOKEN. --lock reads the target and its agent from the lock a
// deploy wrote (DIR/.agentrun/deploy.json). It prints `{pass, differences, unread, warnings}` as JSON and exits 0 when
// the agent is the same on both (no difference, and every field read on both sides or named in --accept-unread), 1 when
// it is not, 2 when it could not check (bad input, an agent not read).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describeAgent, parityDiff, readinessOf, unreadFields } from "./deploy-parity.mjs";
import { isMain } from "./is-main.mjs";

const enc = encodeURIComponent;
const bodyOf = (answer) => (answer.status === 200 && answer.body !== null && typeof answer.body === "object" ? answer.body : null);

/** The agent `agentId` as the install `api` answers for it: `api(method, path, body?)` resolves `{status, body}` for a
 *  path under /v2. The agent's own read is required; each other read is null when the install does not serve it. The
 *  plan is a dry run, which writes nothing. */
export async function readAgent(api, agentId) {
  const agent = await api("GET", `/agents/${enc(agentId)}`);
  if (!bodyOf(agent)) throw new Error(`The agent ${agentId}: ${agent.status} ${agent.body?.error?.message ?? ""}`.trim());
  const triggers = bodyOf(await api("GET", "/triggers"))?.triggers ?? null;
  const servers = bodyOf(await api("GET", "/settings/mcp-servers"))?.servers ?? null;
  const ref = agent.body.template;
  const template = ref?.id ? bodyOf(await api("GET", `/templates/${enc(ref.id)}`)) : null;
  const plan = ref?.id ? (bodyOf(await api("POST", `/templates/${enc(ref.id)}/apply`, { dry_run: true, agent_id: agentId }))?.plan ?? null) : null;
  return { agent: agent.body, triggers, servers, template, plan };
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

async function main(argv, env) {
  const { values } = parseArgs({ args: argv, options: { source: { type: "string" }, "source-agent": { type: "string" }, target: { type: "string" }, "target-agent": { type: "string" }, lock: { type: "string" }, "accept-unread": { type: "string" } } });
  let { target, "target-agent": targetAgent } = values;
  if (values.lock) {
    const lock = JSON.parse(readFileSync(values.lock, "utf8"));
    target ??= lock.target;
    targetAgent ??= lock.agent_id;
  }
  if (!values.source || !values["source-agent"] || !target || !targetAgent) {
    process.stderr.write("deploy-parity: --source URL --source-agent ID, and --target URL --target-agent ID or --lock FILE\n");
    return 2;
  }
  const accepted = (values["accept-unread"] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  let source;
  let there;
  try {
    source = await readAgent(httpApi(values.source, env.AGENTRUN_PARITY_SOURCE_TOKEN), values["source-agent"]);
    there = await readAgent(httpApi(target, env.AGENTRUN_PARITY_TARGET_TOKEN), targetAgent);
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
