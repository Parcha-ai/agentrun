// Deploy parity, the pure half: one agent as an install answers for it (deploy-parity-read.mjs reads it), described with
// nothing its host set on its own, and two descriptions diffed into named differences. No I/O and no imports, so the
// check runs anywhere: against two local servers in a test, or a local install and a hosted one before a release.
//
// A description is `{fields, unread}`. `fields` holds what a deploy carries, by a name that means the same on any host:
// an MCP tool by its server's source and toolkit (mcp:<source>:<toolkit>/<tool>), never the name an owner saved the
// server under; a skill by its files' content hashes; a trigger by its name, without its id, times, hook or the agent it
// names. `unread` lists each field the install did not serve, with why: such a field is never compared, and a pass
// needs none (unreadFields). What a deploy legitimately changes (ids, revisions, timestamps, links, the place and
// computer provider a host picks, the pins of a host's listings) is not in a description at all.

/** A granted MCP tool: mcp:<server>/<tool>. */
const MCP_TOOL = /^mcp:([^/]+)\/(.+)$/;
/** What a composio trigger's source holds of the server it runs on, which never travels (agent-package.ts). */
const COMPOSIO_HOST = ["instance_id", "hook", "sealed_config"];
const SEALED_MASK = "[sealed]";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** JSON with every object's keys sorted: two values are the same when their texts are. */
const stable = (value) => (value === undefined ? "undefined" : JSON.stringify(value, (_key, inner) => (isObject(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner)));
const same = (a, b) => stable(a) === stable(b);
const sortedObject = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Each server's source and toolkit by its saved name, or why they can't be read: no list (not served), or a server
 *  the list names without its source (names alone). Only the servers `names` asks for matter. */
function serversBy(servers, names) {
  if (!Array.isArray(servers)) return { why: "GET /v2/settings/mcp-servers is not served here, so an MCP tool's source and toolkit can't be read" };
  const byName = new Map(servers.filter(isObject).map((server) => [server.name, server]));
  const nameless = names.filter((name) => byName.has(name) && typeof byName.get(name).source !== "string");
  if (nameless.length) return { why: `the MCP server list names ${nameless.join(", ")} without a source or toolkit` };
  return { byName };
}

/** A granted MCP tool by its server's source and toolkit (a url server with no toolkit is its own name, as the export
 *  reads it); one whose server is saved nowhere here says so. */
function portableTool(byName, tool) {
  const [, server, name] = MCP_TOOL.exec(tool);
  const saved = byName.get(server);
  return saved ? `mcp:${saved.source}:${saved.toolkit ?? server}/${name}` : `mcp:unsaved:${server}/${name}`;
}

/** A trigger's source without what its host set on it: a composio one's instance, hook and sealed values, and its server
 *  read as its toolkit. */
function portableSource(source, byName) {
  if (!isObject(source) || source.kind !== "composio") return source;
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) => !COMPOSIO_HOST.includes(key)));
  if (isObject(rest.config)) rest.config = Object.fromEntries(Object.entries(rest.config).filter(([, value]) => value !== SEALED_MASK));
  const saved = byName?.get(rest.server);
  if (saved) rest.server = saved.toolkit ?? rest.server;
  return rest;
}

/** The agent's skills by folder (a SKILL.md and the files beside it), each file's path to its content hash. */
function skillsOf(skills) {
  const folders = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const path = String(skill.path).replace(/^skills\//, "");
    const folder = path.split("/")[0];
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push([path, skill.sha256]);
  }
  return sortedObject([...folders].map(([folder, files]) => [folder, sortedObject(files)]));
}

/** The agent `read.agent` (GET /v2/agents/{id}) with what else its install answered: `triggers` (GET /v2/triggers),
 *  `servers` (GET /v2/settings/mcp-servers) and `template` (GET /v2/templates/{id} for the package it came from), each
 *  null when that install does not serve it. `{fields, unread: [{field, why}]}`. */
export function describeAgent({ agent, triggers = null, servers = null, template = null }) {
  const definition = isObject(agent?.definition) ? agent.definition : {};
  const unread = [];

  const granted = Array.isArray(definition.tools) ? definition.tools.map(String) : [];
  const settings = isObject(definition.tool_settings) ? definition.tool_settings : {};
  const isMcp = (tool) => MCP_TOOL.test(tool);
  const mcpServers = [...new Set([...granted, ...Object.keys(settings)].filter(isMcp).map((tool) => MCP_TOOL.exec(tool)[1]))];
  const sources = serversBy(servers, mcpServers);
  if (mcpServers.length && sources.why) unread.push({ field: "mcp_tools", why: sources.why });
  const byName = sources.byName;

  const tools = sortedObject(granted.filter((tool) => !isMcp(tool)).map((tool) => [tool, settings[tool] ?? null]));
  const mcpTools = byName ? sortedObject(granted.filter(isMcp).map((tool) => [portableTool(byName, tool), settings[tool] ?? null])) : {};
  // A setting of a tool the agent is not granted (an MCP one by its portable name, when the servers were read).
  const loose = Object.keys(settings).filter((tool) => !granted.includes(tool) && (!isMcp(tool) || byName));
  const toolSettings = sortedObject(loose.map((tool) => [isMcp(tool) ? portableTool(byName, tool) : tool, settings[tool]]));

  // The keys its package declares, from the package this agent was made from (the same upload: its sha), else unread.
  let secrets = [];
  if (isObject(agent?.template)) {
    const answered = isObject(template?.template) ? template.template : null;
    if (!answered) secrets = (unread.push({ field: "secrets", why: `GET /v2/templates/${agent.template.id} is not served here, so the keys the agent's package declares can't be read` }), undefined);
    else if ((answered.sha ?? null) !== (agent.template.sha ?? null)) secrets = (unread.push({ field: "secrets", why: `the template ${agent.template.id} here is another upload (sha ${answered.sha}) than the agent's (${agent.template.sha})` }), undefined);
    else secrets = [...(Array.isArray(answered.secrets) ? answered.secrets : [])].map(String).sort();
  }

  let triggersOf = {};
  if (!Array.isArray(triggers)) unread.push({ field: "triggers", why: "GET /v2/triggers is not served here, so the agent's triggers can't be read" });
  else {
    triggersOf = sortedObject(triggers.filter((trigger) => isObject(trigger) && trigger.target?.agent_id === agent?.agent_id).map((trigger) => {
      const { agent_id: _agent, ...target } = trigger.target;
      return [trigger.name, { enabled: trigger.enabled, source: portableSource(trigger.source, byName), target, catchup_window_s: trigger.catchup_window_s, max_active_runs: trigger.max_active_runs ?? null }];
    }));
  }

  const computer = isObject(definition.computer) ? { kind: definition.computer.kind, ...(definition.computer.needs !== undefined ? { needs: definition.computer.needs } : {}) } : definition.computer;
  const budget = { ...(definition.max_cost_usd !== undefined ? { max_cost_usd: definition.max_cost_usd } : {}), ...(definition.max_requests !== undefined ? { max_requests: definition.max_requests } : {}) };
  const fields = {
    name: definition.name,
    description: definition.description,
    // A package's body is read trimmed, so the instructions' outer whitespace never travels.
    instructions: typeof definition.instructions === "string" ? definition.instructions.trim() : definition.instructions,
    harness: definition.harness,
    model: definition.model,
    model_tiers: definition.model_tiers,
    effort: definition.thinking,
    approvals: definition.approvals,
    learning: definition.learning,
    input_schema: definition.input_schema,
    output_schema: definition.output_schema,
    checkout: definition.checkout,
    computer,
    budget,
    tools,
    mcp_tools: mcpTools,
    tool_settings: toolSettings,
    skills: skillsOf(agent?.skills),
    secrets,
    triggers: triggersOf,
  };
  unread.sort((a, b) => (a.field < b.field ? -1 : 1));
  // A field the agent does not set is absent, as JSON carries it.
  return { fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), unread };
}

/** Fields compared key by key: a key on one side alone is missing (the source's) or extra (the target's). Triggers go
 *  one level further, so a trigger's changed bound names that bound. */
const KEYED = new Set(["tools", "mcp_tools", "tool_settings", "skills", "triggers"]);

/** The differences from the source `a` to the target `b`: `[{field, kind: missing | changed | extra, source, target}]`,
 *  [] when the agent is the same. A field either side left unread is not compared (unreadFields names it). */
export function parityDiff(a, b) {
  const skip = new Set([...a.unread, ...b.unread].map((one) => one.field));
  const out = [];
  const one = (field, source, target) => {
    if (source === undefined && target === undefined) return;
    if (source === undefined) out.push({ field, kind: "extra", source, target });
    else if (target === undefined) out.push({ field, kind: "missing", source, target });
    else if (!same(source, target)) out.push({ field, kind: "changed", source, target });
  };
  for (const field of [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])]) {
    if (skip.has(field)) continue;
    const source = a.fields[field];
    const target = b.fields[field];
    if (!KEYED.has(field) || !isObject(source) || !isObject(target)) {
      one(field, source, target);
      continue;
    }
    for (const key of [...new Set([...Object.keys(source), ...Object.keys(target)])].sort()) {
      const name = `${field}.${key}`;
      if (field === "triggers" && Object.hasOwn(source, key) && Object.hasOwn(target, key)) {
        for (const sub of [...new Set([...Object.keys(source[key]), ...Object.keys(target[key])])].sort()) one(`${name}.${sub}`, source[key][sub], target[key][sub]);
      } else one(name, Object.hasOwn(source, key) ? source[key] : undefined, Object.hasOwn(target, key) ? target[key] : undefined);
    }
  }
  return out;
}

/** Each field not compared, by side (`source` or `target`), with why: `[{field, side, why}]`. */
export function unreadFields(a, b) {
  return [...a.unread.map((one) => ({ ...one, side: "source" })), ...b.unread.map((one) => ({ ...one, side: "target" }))]
    .sort((x, y) => (x.field < y.field ? -1 : x.field > y.field ? 1 : x.side < y.side ? -1 : 1))
    .map(({ field, side, why }) => ({ field, side, why }));
}

/** What keeps the target's agent from running as the source's does, which is the target's to set up and never a
 *  difference: a key it lacks, an MCP need no saved server meets (its plan, `plan`, null when not read), and what its
 *  run check refuses (the agent's run_blockers). */
export function readinessOf({ agent, plan }) {
  const out = [];
  if (!isObject(plan)) out.push({ kind: "plan_unread", field: "plan" });
  else {
    for (const name of Array.isArray(plan.missing_secrets) ? plan.missing_secrets : []) out.push({ kind: "key_missing", field: `secrets.${name}` });
    for (const need of Array.isArray(plan.unmatched_mcp) ? plan.unmatched_mcp : []) out.push({ kind: "mcp_missing", field: `mcp.${need.source}:${need.toolkit}`, required: need.required === true });
  }
  const blockers = isObject(agent?.run_blockers) ? agent.run_blockers : null;
  if (blockers) {
    const issues = Array.isArray(blockers.fields) ? blockers.fields : [];
    if (!issues.length) out.push({ kind: "not_runnable", field: "run_blockers", message: blockers.message });
    for (const issue of issues) out.push({ kind: "not_runnable", field: `run_blockers.${issue.field}`, message: issue.message });
  }
  return out;
}
