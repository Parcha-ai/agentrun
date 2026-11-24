// Deploy parity, the pure half: one agent as an install answers for it (deploy-parity-read.mjs reads it), described with
// nothing its host set on its own, and two descriptions diffed into named differences. No I/O and no imports, so the
// check runs anywhere: against two local servers in a test, or a local install and a hosted one before a release.
//
// A description is `{fields, unread}`. `fields` holds every field of the agent's definition but the few HOST_SET names,
// so a field serve adds is compared by default, each by a name that means the same on any host: an MCP tool by its
// server's source and toolkit (mcp:<source>:<toolkit>/<tool>), never the name an owner saved the server under, and one
// the instructions name by its toolkit, as the export writes it; the computer by its kind and needs; a skill by its
// files' content hashes, read from the agent's package (whose texts name MCP tools by toolkit too); a trigger by its
// name, without its id, times, hook or the agent it names. `unread` lists each field the install did not serve, with
// why: such a field is never compared, and a pass needs none (unreadFields). What a deploy legitimately changes (ids,
// revisions, timestamps, links, the place and computer provider a host picks, the pins of a host's listings) is not in
// a description at all.

/** A granted MCP tool: mcp:<server>/<tool>. */
const MCP_TOOL = /^mcp:([^/]+)\/(.+)$/;
/** An MCP tool named in prose, whole, as serve's apply finds it (templates.ts MCP_NAME_IN_TEXT): `mcp:<server>/` before a
 *  tool or `*`, not the tail of a longer word. */
const MCP_IN_TEXT = /(?<![A-Za-z0-9_.:/-])mcp:([a-z][a-z0-9-]{0,31})\/(?=\*|[A-Za-z0-9_-])/g;
const SHA256 = /^[0-9a-f]{64}$/;

/** The definition's fields an install sets on its own, never compared, each with why. Every other field is. */
export const HOST_SET = {
  id: "the agent's id on that install",
  version: "how many revisions the agent has on that install",
  place: "where that install runs the agent: its own pick",
};
/** The definition's fields read into the description under another form: the rest go by their own names. */
const MAPPED = new Set(["instructions", "thinking", "max_cost_usd", "max_requests", "computer", "skills", "tools", "tool_settings"]);
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

/** `[name, setting]` entries by name. A name two grants share (two saved servers of one source and toolkit) holds each
 *  one's setting, sorted, so neither is lost to the other. */
function grouped(entries) {
  const byName = new Map();
  for (const [name, setting] of entries) byName.set(name, [...(byName.get(name) ?? []), setting]);
  const order = (x, y) => (stable(x) < stable(y) ? -1 : stable(x) > stable(y) ? 1 : 0);
  return sortedObject([...byName].map(([name, settings]) => [name, settings.length === 1 ? settings[0] : settings.sort(order)]));
}

/** `text` with each MCP tool it names on a saved server named by that server's toolkit, as the export writes it
 *  (agent-package.ts), so the name an apply gave it on one install reads the same on another. */
const byToolkit = (text, byName) => text.replace(MCP_IN_TEXT, (whole, server) => (byName.has(server) ? `mcp:${byName.get(server).toolkit ?? server}/` : whole));

/** The agent's skills by folder from its package's files (`[{path, sha256}]`, readAgent): each file under skills/, and
 *  each rules/ file beside every SKILL.md, as an apply puts it, by path to its content hash. Or why they can't be read:
 *  no package, or a file without a sha256 hash. */
function skillFilesOf(files) {
  if (!Array.isArray(files)) return { why: "GET /v2/agents/{id}/package is not served here, so the skills' files can't be read" };
  const tree = files.filter((file) => /^(skills|rules)\//.test(file?.path));
  const unhashed = tree.filter((file) => !SHA256.test(file.sha256 ?? ""));
  if (unhashed.length) return { why: `the package's ${unhashed.map((file) => file.path).join(", ")} has no sha256 content hash` };
  const skills = tree.filter((file) => file.path.startsWith("skills/")).map((file) => [file.path.slice("skills/".length), file.sha256]);
  const folders = skills.filter(([path]) => /^[^/]+\/SKILL\.md$/.test(path)).map(([path]) => path.split("/")[0]);
  const rules = tree.filter((file) => file.path.startsWith("rules/")).flatMap((file) => folders.map((folder) => [`${folder}/${file.path.slice("rules/".length)}`, file.sha256]));
  const byFolder = new Map();
  for (const [path, sha] of [...skills, ...rules]) {
    const folder = path.split("/")[0];
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), [path, sha]]);
  }
  return { skillFiles: sortedObject([...byFolder].map(([folder, entries]) => [folder, sortedObject(entries)])) };
}

/** The agent `read.agent` (GET /v2/agents/{id}) with what else its install answered: `triggers` (GET /v2/triggers),
 *  `servers` (GET /v2/settings/mcp-servers), `template` (GET /v2/templates/{id} for the package it came from) and
 *  `packageFiles` (GET /v2/agents/{id}/package's files, each by its content hash), each null when that install does not
 *  serve it. `{fields, unread: [{field, why}]}`. */
export function describeAgent({ agent, triggers = null, servers = null, template = null, packageFiles = null }) {
  const definition = isObject(agent?.definition) ? agent.definition : {};
  const unread = [];

  const granted = Array.isArray(definition.tools) ? definition.tools.map(String) : [];
  const settings = isObject(definition.tool_settings) ? definition.tool_settings : {};
  const isMcp = (tool) => MCP_TOOL.test(tool);
  const mcpServers = [...new Set([...granted, ...Object.keys(settings)].filter(isMcp).map((tool) => MCP_TOOL.exec(tool)[1]))];
  const named = typeof definition.instructions === "string" ? [...definition.instructions.matchAll(MCP_IN_TEXT)].map((match) => match[1]) : [];
  const sources = serversBy(servers, [...new Set([...mcpServers, ...named])]);
  if (mcpServers.length && sources.why) unread.push({ field: "mcp_tools", why: sources.why });
  if (named.length && sources.why) unread.push({ field: "instructions", why: `${sources.why}, nor the saved servers the instructions name MCP tools on` });
  const byName = sources.byName;

  const tools = sortedObject(granted.filter((tool) => !isMcp(tool)).map((tool) => [tool, settings[tool] ?? null]));
  const mcpTools = byName ? grouped(granted.filter(isMcp).map((tool) => [portableTool(byName, tool), settings[tool] ?? null])) : {};
  // A setting of a tool the agent is not granted (an MCP one by its portable name, when the servers were read).
  const loose = Object.keys(settings).filter((tool) => !granted.includes(tool) && (!isMcp(tool) || byName));
  const toolSettings = grouped(loose.map((tool) => [isMcp(tool) ? portableTool(byName, tool) : tool, settings[tool]]));
  const files = skillFilesOf(packageFiles);
  if (files.why) unread.push({ field: "skill_files", why: files.why });

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
  const text = definition.instructions;
  const mapped = {
    // A package's body is read trimmed, so the instructions' outer whitespace never travels.
    instructions: typeof text === "string" ? (byName ? byToolkit(text, byName) : text).trim() : text,
    effort: definition.thinking,
    budget,
    computer,
    skills: Array.isArray(definition.skills) ? [...definition.skills].sort() : definition.skills,
    tools,
    mcp_tools: mcpTools,
    tool_settings: toolSettings,
    skill_files: files.skillFiles,
    secrets,
    triggers: triggersOf,
  };
  // Every other field of the definition by its own name; one that shares a name with a field above goes under
  // definition.<name>, so neither hides the other.
  const fields = {};
  for (const [key, value] of Object.entries(definition)) {
    if (Object.hasOwn(HOST_SET, key) || MAPPED.has(key)) continue;
    fields[Object.hasOwn(mapped, key) ? `definition.${key}` : key] = value;
  }
  Object.assign(fields, mapped);
  unread.sort((a, b) => (a.field < b.field ? -1 : 1));
  // A field the agent does not set is absent, as JSON carries it.
  return { fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), unread };
}

/** Fields compared key by key: a key on one side alone is missing (the source's) or extra (the target's). Triggers go
 *  one level further, so a trigger's changed bound names that bound. */
const KEYED = new Set(["tools", "mcp_tools", "tool_settings", "skill_files", "triggers"]);

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
