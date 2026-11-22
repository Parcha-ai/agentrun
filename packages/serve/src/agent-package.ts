// An agent's current revision written as a template package (GET /v2/agents/{id}/package): the reverse of an apply. Its
// grants of saved MCP servers become needs by source and toolkit, its triggers bodies with no agent and no secret, and
// what names this host (its box, its computer's provider, its pins of this server's listings, its place) is left out.
// What can't travel is said in two lists: `blocked` (the agent would not work elsewhere, or a field it copies holds a
// credential in the clear, so `agentrun export` writes nothing) and `remade` (the target sets it up again: a webhook's
// secret, a sign-in, a paired computer, learned state).
// The answer's files are read back with readPackage before they are answered, so what is answered is a package.
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { LOOPBACK } from "./mcp-oauth.js";
import { MANIFEST, memoryFiles, onServerNames, type Package, PackageError, readPackage } from "./templates.js";
import { isMcpName, isMonidName, mcpToolName, parseToolName } from "./tool-names.js";
import { permissionKeys, SHELL_FAMILY } from "./tool-gate.js";
import { toolOf } from "./tools.js";
import { configSecrets, SEALED_FIELD, SEALED_MASK } from "./trigger-composio.js";
import { CATCHUP_WINDOW_S } from "./triggers.js";
import { isObject, type Json, MODEL_TIER_NAMES, stable } from "./validate.js";
import { PAIRED_ID_PREFIX } from "./workspace/attached-computers.js";

/** A package's file as the API carries it: text as itself, anything else base64. */
export type PackageFile = { path: string; encoding: "utf8" | "base64"; content: string };
/** What an export's note can be about: the document's enum of them (openapi.ts), so a note of a kind not here fails the
 *  build, and an answer the document does not list fails its schema check. */
export const EXPORT_NOTE_KINDS = ["mcp_server", "trigger", "pin", "tool_setting", "tool_policy", "computer", "paired_computer", "sign_in", "learning", "secrets", "input_schema", "budget", "package"] as const;
/** One thing an export could not carry as it is here: what it is, which one, and why, in words. */
export type ExportNote = { kind: (typeof EXPORT_NOTE_KINDS)[number]; name: string; reason: string };
export type AgentPackage = { name: string; files: PackageFile[]; sha256: string; report: { blocked: ExportNote[]; remade: ExportNote[] } };
/** A saved MCP server as an export reads it: its address, its auth type, what it is (mcp-sources.ts) and its tools. */
export type SavedServer = { url: string; auth: string; source: { source: string; toolkit: string | null }; tools: readonly { name: string }[] };
export type ExportInput = {
  agent: { id: string; name: string; description: string | null };
  /** The current revision as GET /agents shows it (agents-store.ts definitionOf). */
  definition: Json;
  /** The revision's skill files, by path under the agent's skills folder. */
  skills: Readonly<Record<string, string>>;
  /** The package the agent was applied from (agentView's `template`) with the key names its apply kept (absent on a
   *  revision applied before they were kept), and that package as this server holds it now. */
  template: { id: string; version: string; secrets?: readonly string[] } | null;
  origin: Package | undefined;
  servers: ReadonlyMap<string, SavedServer>;
  /** The agent's triggers as GET /triggers shows them: those that start its runs, and those that message one of them. */
  triggers: readonly Json[];
  /** The agent's saved browser sign-ins. */
  signIns: readonly { provider: string; name: string }[];
  /** The time by the triggers' clock, in epoch milliseconds. */
  now: number;
};

/** The package's digest: sha256, in hex, over its files sorted by path, each written as `path NUL bytes NUL`. */
export function packageSha256(files: readonly PackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update(NUL).update(Buffer.from(file.content, file.encoding)).update(NUL);
  }
  return hash.digest("hex");
}
const NUL = Buffer.from([0]);

/** A package name (lowercase letters, digits and single dashes, at most 64) made of `text`, or "" when nothing of it fits. */
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "");

/** The trigger kinds whose setup the target makes again, and what the owner does there. */
const REMADE_TRIGGERS: Record<string, string> = {
  webhook: "A webhook trigger gets its own signing secret on the target: give the sender the new one.",
  github: "A github trigger takes events through the target's GitHub App: connect GitHub there (it is skipped until then).",
  composio: "A composio trigger is made again on the target's Composio project.",
  email: "An email trigger receives at an address the target gives it: point the sender at the new one.",
};

/** The input fields' keys in the order a package writes them (templates.ts INPUT_KEYS), and a list's items'. */
const FIELD_KEYS = ["type", "title", "description", "pattern", "format", "minLength", "maxLength", "minimum", "maximum", "enum", "examples", "default"];
const ITEM_KEYS = ["type", "pattern", "format", "minLength", "maxLength", "minimum", "maximum", "enum"];
const pick = (from: Json, keys: readonly string[]): Json => Object.fromEntries(keys.flatMap((key) => (from[key] !== undefined ? [[key, from[key]]] : [])));

/** Each field of `value`, a part of the agent an export copies as it is, that holds a credential in the clear, as its
 *  path from `at` (source.urls.0, target.input.api_key): by the walk a composio trigger's config is sealed by
 *  (trigger-composio.ts configSecrets: a field named like a credential, at any depth, and an address that carries one,
 *  such as a query's token). The field, never the value. */
const clearIn = (value: unknown, at: string): string[] => configSecrets(value).map((secret) => [at, ...secret.path].join("."));
const IN_THE_CLEAR = "It holds a credential in the clear, and a package carries no credential: take it out of this field here, then export again.";

/** `schema`, a compiled input schema, as the manifest's `inputs` that compile to it again; undefined for one that is not a
 *  closed object of fields. Whether it compiles back the same is checked once the package is read. */
function inputsOf(schema: unknown): Json | undefined {
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties) || !Object.keys(schema.properties).length) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const inputs: Json = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!isObject(property)) return undefined;
    const field = pick(property, FIELD_KEYS);
    inputs[key] = { ...field, ...(isObject(property.items) ? { items: pick(property.items, ITEM_KEYS) } : {}), ...(required.includes(key) ? {} : { required: false }) };
  }
  return inputs;
}
/** An input schema as a package compiles one: an empty `required` is left out. */
const compiledForm = (schema: Json): Json => (Array.isArray(schema.required) && !schema.required.length ? (({ required: _none, ...rest }) => rest)(schema) : schema);

/** The agent as a package (see the head of this file). */
export function agentPackage(input: ExportInput): AgentPackage {
  const { agent, definition, origin, template } = input;
  const blocked: ExportNote[] = [];
  const remade: ExportNote[] = [];
  // Its name: the template's it was applied from, else the agent's own as a package name.
  const pkgName = origin?.name || (template ? slug(template.id.split(/[/:]/).at(-1) ?? "") : "") || slug(agent.name) || slug(agent.id) || "agent";
  const sameVersion = !!origin && !!template && origin.version === template.version;
  const settings = (isObject(definition.tool_settings) ? definition.tool_settings : {}) as Record<string, Json>;
  // Denied as the gate reads the agent's own settings: a shell tool by bash's, then the most specific key set (the tool's
  // own, else its MCP server's or monid provider's wildcard).
  const denied = (tool: string) => permissionKeys(Object.hasOwn(SHELL_FAMILY, tool) ? SHELL_FAMILY[tool]! : tool).map((key) => settings[key]).find((setting) => setting?.permission !== undefined)?.permission === "deny";

  // Its tools: plain and monid ones as they are; MCP ones by server, a wildcard read as the tools its server lists.
  // A tool denied here is left out, so no target grants it.
  const tools = Array.isArray(definition.tools) ? (definition.tools as string[]) : undefined;
  const plain = tools?.filter((tool) => !isMcpName(tool) && !denied(tool));
  const byServer = new Map<string, string[]>();
  for (const tool of tools?.filter(isMcpName) ?? []) {
    const parsed = parseToolName(tool);
    if (!parsed || (parsed.kind !== "mcp" && parsed.kind !== "mcp-server")) continue;
    const named = parsed.kind === "mcp" ? [parsed.tool] : (input.servers.get(parsed.server)?.tools ?? []).map((one) => one.name);
    const list = byServer.get(parsed.server) ?? [];
    for (const one of named) if (!list.includes(one) && !denied(mcpToolName(parsed.server, one))) list.push(one);
    byServer.set(parsed.server, list);
  }
  // A trigger that messages one of its runs names a run of this server's, which no package can.
  const starts = input.triggers.filter((view) => !(isObject(view.target) && view.target.kind === "message_run"));
  for (const view of input.triggers.filter((one) => !starts.includes(one))) remade.push({ kind: "trigger", name: String(view.name), reason: "It sends a message to a run on this server, which a package can't name: make it again on the target, aimed at a run there." });
  const composioServers = new Set(starts.flatMap((trigger) => (isObject(trigger.source) && trigger.source.kind === "composio" && typeof trigger.source.server === "string" ? [trigger.source.server] : [])));
  // Each saved server the agent is granted tools of, by source and toolkit; one saved nowhere here, on this machine's
  // loopback, or with its own credential in a header is blocked; one the owner signed in to is remade.
  const mcp: Json[] = [];
  const toolkits: Record<string, string> = {};
  for (const [server, granted] of byServer) {
    const saved = input.servers.get(server);
    if (!saved) {
      blocked.push({ kind: "mcp_server", name: server, reason: "It is not a saved MCP server here: a local (stdio) server the agent was given on its own machine stays there. Save it as a remote MCP server, or take its tools out of the agent." });
      continue;
    }
    if (saved.source.source === "url") {
      const why: string[] = [];
      let host = "";
      try {
        host = new URL(saved.url).hostname;
      } catch {
        why.push("its address does not read as a URL");
      }
      if (LOOPBACK.test(host)) why.push(`it is on this machine (${host}), which the target can't reach`);
      if (saved.auth === "bearer" || saved.auth === "headers") why.push("it sends its own auth header, a credential saved on this server that a package never carries");
      if (why.length) {
        blocked.push({ kind: "mcp_server", name: server, reason: `${why.map((one) => `${one.charAt(0).toUpperCase()}${one.slice(1)}`).join(". ")}. Save a server the target reaches, with its own credential there, and grant its tools.` });
        continue;
      }
      if (saved.auth === "oauth") remade.push({ kind: "mcp_server", name: server, reason: "It signs in with OAuth: sign in to it again on the target." });
      if (saved.auth === "per_run") remade.push({ kind: "mcp_server", name: server, reason: "It takes its credential with each run: the target's runs pass their own." });
    }
    if (!granted.length) continue;
    const toolkit = saved.source.toolkit ?? server;
    toolkits[server] = toolkit;
    const pin: Json = {};
    // A pin travels as it is, so one that holds a credential in the clear is blocked, and left out.
    for (const tool of granted) {
      const held = settings[mcpToolName(server, tool)]?.pin;
      if (held === undefined) continue;
      const clear = clearIn(held, `pin.${tool}`);
      for (const field of clear) blocked.push({ kind: "pin", name: `${server}: ${field}`, reason: IN_THE_CLEAR });
      if (!clear.length) pin[tool] = held;
    }
    const reason = origin?.mcp.find((need) => need.source === saved.source.source && need.toolkit === toolkit)?.reason;
    // Required where a composio trigger runs on it (as a package's composio trigger must); else skipped where none matches.
    mcp.push({ source: saved.source.source, toolkit, tools: granted, ...(composioServers.has(server) ? { required: true } : {}), ...(reason ? { reason } : {}), ...(Object.keys(pin).length ? { pin } : {}) });
  }
  // What the tool settings hold beyond a pin of a granted MCP tool and bash's policy is this server's.
  for (const [tool, setting] of Object.entries(settings)) {
    if (!isObject(setting) || setting.permission === "deny") continue;
    const parsed = parseToolName(tool);
    const ofNeed = parsed?.kind === "mcp" && mcp.some((need) => toolkits[parsed.server] === need.toolkit && (need.tools as string[]).includes(parsed.tool));
    if (setting.pin !== undefined && !ofNeed) {
      if (parsed?.kind === "mcp" || parsed?.kind === "mcp-server") remade.push({ kind: "pin", name: tool, reason: "A pin on a tool the agent is not granted: pin it again on the target if the tool is granted there." });
      else blocked.push({ kind: "tool_setting", name: tool, reason: "Its arguments are pinned, and a package pins MCP tools alone: without the pin the agent would get more than it has here." });
    }
    if (setting.permission === "allow") remade.push({ kind: "tool_setting", name: tool, reason: "It runs without asking here: allow it again on the target." });
    const own = ["provider", "scope"].filter((key) => setting[key] !== undefined);
    if (own.length) remade.push({ kind: "tool_setting", name: tool, reason: `Its ${own.join(" and ")} is set on this server: set it again on the target.` });
  }

  // The computer it needs, read down to what any server gives: a shell, or none. The box, the provider, a paired
  // computer and a sandbox's own setup are this server's.
  const computer = isObject(definition.computer) ? definition.computer : undefined;
  const shellTools = (plain ?? []).filter((tool) => toolOf(tool)?.sandboxOnly);
  let computers: string[] | undefined;
  // The programs its sandbox must have (computer.needs), which a package names beside [shell] alone.
  let needs: string[] | undefined;
  if (computer?.kind === "none") computers = shellTools.length ? ["shell", "none"] : ["none"];
  else if (computer?.kind === "sandbox") {
    computers = ["shell"];
    if (Array.isArray(computer.needs) && computer.needs.length) needs = computer.needs.map(String);
    if (computer.image !== undefined || computer.gpu !== undefined || computer.persistent !== undefined) remade.push({ kind: "computer", name: "sandbox", reason: "Its sandbox's image, GPUs or persistence are set on this server: set them again on the target." });
  } else if (computer) remade.push({ kind: "computer", name: String(computer.kind), reason: `A ${String(computer.kind)} computer is this server's: give the agent one again on the target.` });
  if (typeof computer?.provider === "string" && computer.provider.startsWith(PAIRED_ID_PREFIX)) remade.push({ kind: "paired_computer", name: computer.provider, reason: "A computer paired with this server: pair one with the target." });

  // Its model: the agent's own, and the tier whose model it is (that tier's entry then left out), else balanced; with no
  // model, the tier the package it came from names, so the target picks its own model for it.
  const model = typeof definition.model === "string" ? definition.model : undefined;
  const tiers = (isObject(definition.model_tiers) ? definition.model_tiers : {}) as Record<string, string>;
  const ownTier = model ? MODEL_TIER_NAMES.find((tier) => tiers[tier] === model) : undefined;
  const tier = ownTier ?? (model ? "balanced" : origin?.model?.tier ?? "balanced");
  const modelEntry = { tier, ...(model ? { prefer: model } : {}), ...Object.fromEntries(MODEL_TIER_NAMES.flatMap((one) => (one !== ownTier && typeof tiers[one] === "string" ? [[one, tiers[one]]] : []))) };

  // Its triggers, as POST /triggers bodies with no agent: a composio one's server read as its need's toolkit, and what
  // this server set on it (its instance, its hook, its sealed values) left out.
  const triggers: Json[] = [];
  for (const view of starts) {
    const target = isObject(view.target) ? view.target : {};
    const triggerName = String(view.name);
    let source = isObject(view.source) ? { ...view.source } : {};
    const kind = String(source.kind);
    // A one-shot schedule whose time has passed fired here (or was missed): an apply refuses a time in the past.
    if (kind === "schedule" && typeof source.at === "string" && Date.parse(source.at) <= input.now) {
      remade.push({ kind: "trigger", name: triggerName, reason: `It fired once, at ${source.at}, which has passed: give it a new time on the target.` });
      continue;
    }
    let sealed: string[] = [];
    if (kind === "composio") {
      const { instance_id: _instance, hook: _hook, [SEALED_FIELD]: _sealed, ...rest } = source;
      const config = isObject(rest.config) ? rest.config : undefined;
      sealed = config ? Object.keys(config).filter((key) => config[key] === SEALED_MASK) : [];
      source = { ...rest, ...(config ? { config: Object.fromEntries(Object.entries(config).filter(([key]) => !sealed.includes(key))) } : {}) };
      if (typeof source.server !== "string" || !Object.hasOwn(toolkits, source.server)) {
        blocked.push({ kind: "trigger", name: triggerName, reason: `Its Composio server ${String(source.server)} is not one whose tools the agent is granted, and a package's composio trigger runs on one of its MCP needs.` });
        continue;
      }
      source.server = toolkits[source.server];
    }
    // Its source and input travel as they are, so one that holds a credential in the clear (a feed URL's ?token=, an
    // input's api_key) is blocked, and left out.
    const runInput = target.input ?? {};
    const clear = [...clearIn(source, "source"), ...clearIn(runInput, "target.input")];
    if (clear.length) {
      for (const field of clear) blocked.push({ kind: "trigger", name: `${triggerName}: ${field}`, reason: IN_THE_CLEAR });
      continue;
    }
    triggers.push({
      name: triggerName, ...(view.enabled === false ? { enabled: false } : {}), source,
      ...(typeof view.catchup_window_s === "number" && view.catchup_window_s !== CATCHUP_WINDOW_S ? { catchup_window_s: view.catchup_window_s } : {}),
      ...(typeof view.max_active_runs === "number" ? { max_active_runs: view.max_active_runs } : {}),
      target: { kind: "start_run", input: runInput, ...(target.max_cost_usd !== undefined ? { max_cost_usd: target.max_cost_usd } : {}), ...(target.effort !== undefined ? { effort: target.effort } : {}) },
    });
    if (Object.hasOwn(REMADE_TRIGGERS, kind)) remade.push({ kind: "trigger", name: triggerName, reason: `${REMADE_TRIGGERS[kind]}${sealed.length ? ` Its sealed config (${sealed.join(", ")}) is set again there.` : ""}` });
  }
  for (const signIn of input.signIns) remade.push({ kind: "sign_in", name: signIn.provider, reason: `The browser sign-in ${signIn.name} is saved on this server: sign in again on the target.` });
  const learning = definition.learning;
  if (learning === true || isObject(learning)) remade.push({ kind: "learning", name: "learning", reason: "What the agent learned here stays here: its learning starts fresh on the target." });

  // Its texts with each saved server's name read as its toolkit's, as the package names its tools.
  const renamed = Object.fromEntries(Object.entries(toolkits).filter(([server, toolkit]) => server !== toolkit));
  const instructions = onServerNames(String(definition.instructions ?? ""), renamed).trim();
  const skills = Object.fromEntries(Object.entries(input.skills).map(([path, text]) => [path, onServerNames(text, renamed)]));
  // A rule the package it came from ships beside each SKILL.md, the same text beside each, is its rules/ file again.
  const folders = Object.keys(skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.slice(0, -"/SKILL.md".length));
  const rules: Record<string, string> = {};
  for (const rule of origin?.rules ?? []) {
    const texts = new Set(folders.map((folder) => skills[`${folder}/${rule}`]));
    const [text] = texts;
    if (!folders.length || texts.size !== 1 || typeof text !== "string") continue;
    rules[rule] = text;
    for (const folder of folders) delete skills[`${folder}/${rule}`];
  }
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(skills)) files.set(`skills/${path}`, text);
  for (const [rule, text] of Object.entries(rules)) files.set(`rules/${rule}`, text);
  // The answer's schema: a skill file that is it, else a file of its own at the package's root.
  const outputSchema = isObject(definition.output_schema) ? definition.output_schema : undefined;
  let output: string | undefined;
  if (outputSchema) {
    output = [...files.keys()].sort().find((path) => {
      try {
        return stable(JSON.parse(files.get(path)!)) === stable(outputSchema);
      } catch {
        return false;
      }
    });
    if (!output) {
      const given = origin?.output?.schema;
      output = given && !given.includes("/") && given !== MANIFEST ? given : "output.schema.json";
      files.set(output, `${JSON.stringify(outputSchema, null, 2)}\n`);
    }
  }
  const inputSchema = isObject(definition.input_schema) ? definition.input_schema : undefined;
  const inputs = inputSchema && inputsOf(inputSchema);
  if (inputSchema && !inputs) blocked.push({ kind: "input_schema", name: "inputs", reason: "Its input schema is not a closed object of fields, which is what a package's inputs are." });
  // The keys its package declared, as its apply kept them; for a revision applied before they were kept, the package as
  // this server holds it, which names them only while it is the same version.
  const declared = template?.secrets ?? (sameVersion ? origin!.secrets : []);
  const secrets = [...new Set([...declared, ...((plain ?? []).some(isMonidName) ? ["MONID_API_KEY"] : [])])].sort();
  // Such a revision of a package updated or removed since its apply: the keys it was applied with are unknown here.
  if (template && !template.secrets && !sameVersion) remade.push({ kind: "secrets", name: template.id, reason: `The keys version ${template.version} of ${template.id} names are not known here: ${origin ? `this server holds version ${origin.version}` : "this server no longer holds it"}. Save the keys the agent uses on the target, and name them under secrets in ${MANIFEST}.` });
  const bash = settings.bash?.policy;
  // Bash's policy holds every shell tool, and a package writes it only beside bash: a shell tool kept without bash would
  // run there what the policy refuses here.
  const shellKept = (plain ?? []).filter((tool) => Object.hasOwn(SHELL_FAMILY, tool));
  if (typeof bash === "string" && shellKept.length && !shellKept.includes("bash")) blocked.push({ kind: "tool_policy", name: "bash", reason: `Its bash policy (${bash}) holds ${shellKept.join(", ")}, and a package writes that policy only beside bash: grant bash too, or take ${shellKept.length === 1 ? "it" : "them"} out of the agent.` });
  const description = (agent.description?.trim() || agent.name).slice(0, 1024);
  // A package's budget is a spend cap per run first, and one with triggers has one: what fires runs nobody watches.
  const cost = typeof definition.max_cost_usd === "number" ? definition.max_cost_usd : undefined;
  const requests = typeof definition.max_requests === "number" ? definition.max_requests : undefined;
  if (cost === undefined && requests !== undefined) blocked.push({ kind: "budget", name: "max_requests", reason: "It caps each run's requests and not its spend, and a package's budget is a spend cap per run: set the agent's max_cost_usd." });
  if (cost === undefined && triggers.length) {
    blocked.push({ kind: "budget", name: "max_cost_usd", reason: "It has triggers and no spend cap per run, and a package with triggers caps what each run they fire may spend: set the agent's max_cost_usd." });
    triggers.length = 0;
    remade.splice(0, remade.length, ...remade.filter((note) => note.kind !== "trigger"));
  }

  // The manifest, in the order templates.ts reads its fields.
  const manifest: Json = {
    name: pkgName, display_name: agent.name, version: template?.version ?? "1.0.0", description,
    harness: [definition.harness], model: modelEntry,
    ...(typeof definition.thinking === "string" ? { effort: definition.thinking } : {}),
    ...(plain ? { tools: plain } : {}), ...(mcp.length ? { mcp } : {}),
    ...(typeof bash === "string" && plain?.includes("bash") ? { tool_policy: { bash } } : {}),
    ...(computers ? { computer: computers } : {}), ...(needs ? { needs } : {}),
    ...(definition.checkout === "pull_request" ? { checkout: "pull_request" } : {}),
    ...(inputs ? { inputs } : {}), ...(secrets.length ? { secrets } : {}),
    ...(cost !== undefined ? { budget: { per_run_usd: cost, ...(requests !== undefined ? { max_requests: requests } : {}) } } : {}),
    ...(learning !== undefined ? { learning } : {}),
    approvals: definition.approvals === "never" ? "never" : "ask",
    ...(triggers.length ? { triggers } : {}),
    ...(output ? { output: { schema: output } } : {}),
  };
  files.set(MANIFEST, `---\n${stringify(manifest, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n${instructions}\n`);

  const answer = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, content]): PackageFile => ({ path, encoding: "utf8", content }));
  // Read back as any package is: each problem is a reason the export would not apply anywhere.
  try {
    const pkg = readPackage(memoryFiles(pkgName, `the export of ${agent.id}`, new Map(answer.map((file) => [file.path, Buffer.from(file.content, "utf8")]))));
    if (inputs && stable(pkg.inputSchema) !== stable(compiledForm(inputSchema!))) blocked.push({ kind: "input_schema", name: "inputs", reason: "Its input schema uses JSON Schema a package's inputs can't say, so the target's agent would take other input." });
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    for (const problem of error.problems) blocked.push({ kind: "package", name: pkgName, reason: problem });
  }
  return { name: pkgName, files: answer, sha256: packageSha256(answer), report: { blocked, remade } };
}
