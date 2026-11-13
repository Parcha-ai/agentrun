import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, delimiter, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { ApiError } from "../errors.js";
import { NATIVE_MINIMUM_VERSION, NATIVE_RUNTIME_FACTS, NATIVE_RUNTIMES } from "./runtimes.js";
export { NATIVE_MINIMUM_VERSION } from "./runtimes.js";
import type { NativeBinding, NativeRuntime, NativeSelector, NativeTarget } from "./types.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const name = (value: unknown): string | null => typeof value === "string" && /^[\w./:@+-]{1,160}$/.test(value) ? value : null;
const selectorName = (value: string) => /^[\w.@+-]{1,160}$/.test(value);
const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
const rootsOf = (project: string) => { const roots = [project]; while (dirname(roots[0]) !== roots[0]) roots.unshift(dirname(roots[0])); return roots; };
const filesIn = async (path: string) => { try { return (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name)); } catch { return []; } };

/** Minimum installed CLI versions whose native JSON/resume/permission interfaces this bridge supports.
 * New major releases and prereleases require explicit compatibility validation before launch. */
// The minimums come from the native protocol registry; discovery remains their public export.

function supportedVersion(runtime: NativeRuntime, version: string | null): boolean {
  if(!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))return false;
  const parts=version.split(".").map(Number),minimum=NATIVE_MINIMUM_VERSION[runtime].split(".").map(Number);
  return parts.every(Number.isSafeInteger) && parts[0]===minimum[0] && (parts[1]>minimum[1] || (parts[1]===minimum[1] && parts[2]>=minimum[2]));
}

export class NativeDiscoveryError extends ApiError {
  constructor() { super("input_invalid","Choose an existing project directory on this machine, then discover again.",{fields:[{field:"project",reason:"directory",message:"Choose an existing project directory on this machine."}]}); this.name = "NativeDiscoveryError"; }
}

/** Resolve only through the supplied native PATH. Never substitutes a bundled managed runtime. */
export async function nativeExecutable(runtime: NativeRuntime, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const binary = NATIVE_RUNTIME_FACTS[runtime].binary;
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, binary);
    try { await access(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  return null;
}

/** Metadata commands are bounded and never contain a prompt or a launch command. */
export async function nativeMetadata(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5_000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveResult) => {
    let stdout = "", done = false;
    const child = spawn(binary, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolveResult({code,stdout}); };
    const timer = setTimeout(() => { try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ } finish(null); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 65_536) { child.kill("SIGKILL"); finish(null); } });
    child.once("error", () => finish(null)); child.once("close", finish);
  });
}

export function nativeIdentity(target: Pick<NativeTarget, "runtime" | "project" | "selector" | "machine_id">): string {
  return hash(JSON.stringify([target.runtime,target.project,target.selector.kind,target.selector.name ?? null,target.machine_id]));
}

export async function discoverNative(options: { project: string; runtime?: NativeRuntime; env?: NodeJS.ProcessEnv }): Promise<{ machine_id: string; targets: NativeTarget[] }> {
  const env = options.env ?? process.env, home = homeOf(env);
  let project: string;
  try { project = await realpath(resolve(options.project)); if(!(await stat(project)).isDirectory())throw new NativeDiscoveryError(); }
  catch { throw new NativeDiscoveryError(); }
  let machine = hostname(); try { machine = (await readFile("/etc/machine-id", "utf8")).trim(); } catch { /* hostname fallback */ }
  const machine_id = hash(machine), targets: NativeTarget[] = [];
  for (const runtime of options.runtime ? [options.runtime] : NATIVE_RUNTIMES) {
    const binary = await nativeExecutable(runtime, env);
    const versionResult = binary ? await nativeMetadata(binary, ["--version"], project, env) : null;
    const version = versionResult?.code === 0 ? versionResult.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=$|\s|\()/)?.[1] ?? null : null;
    const supported=Boolean(binary && supportedVersion(runtime,version));
    const configuration = new Map<string,string>(), skills = new Set<string>(), mcp = new Set<string>(), issues: string[] = [];
    const selectors: { selector: NativeSelector; model?: string | null; path?: string }[] = [{selector:{kind:"project"}}];
    let model: string | null = null, needsAttention = false;
    const issue = (message: string) => { needsAttention = true; issues.push(message); };
    const take = async (path: string): Promise<string | null> => {
      try { const body = await readFile(path, "utf8"); configuration.set(path,hash(body)); return body; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") issue(`Cannot read configuration: ${path}`); return null; }
    };
    const json = async (path: string): Promise<Record<string,any> | null> => {
      const body = await take(path); if (body === null) return null;
      try { const value: unknown = JSON.parse(body); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string,any>; } catch { /* actionable without config contents */ }
      issue(`Invalid JSON configuration: ${path}`); return null;
    };
    const readSkills = async (path: string) => {
      for (const entry of await filesIn(path)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (await take(join(path,entry.name,"SKILL.md")) !== null && name(entry.name)) skills.add(entry.name);
      }
    };
    const ancestors = rootsOf(project);
    if (NATIVE_RUNTIME_FACTS[runtime].protocol === "claude-json") {
      const claudeHome = env.CLAUDE_CONFIG_DIR || join(home,".claude");
      const configRoots = [claudeHome,...ancestors.map(root=>join(root,".claude"))];
      await take(join(claudeHome,"CLAUDE.md"));
      for (const root of configRoots) {
        for (const filename of ["settings.json","settings.local.json"]) {
          const settings = await json(join(root,filename)); if (name(settings?.model)) model = name(settings?.model);
        }
        await readSkills(join(root,"skills"));
        await take(join(root,"CLAUDE.md"));
        for (const entry of await filesIn(join(root,"agents"))) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const path = join(root,"agents",entry.name), body = await take(path);
          const frontmatter = body?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
          // Native Claude accepts frontmatter descriptions beyond strict YAML. Extract labels only.
          const field = (key: string) => name(frontmatter?.match(new RegExp(`^${key}:\\s*["']?([^\\s"']+)["']?\\s*$`,"m"))?.[1]);
          const selectedName = field("name") ?? name(basename(entry.name,".md"));
          if (!selectedName) continue;
          if (!selectorName(selectedName)) { issues.push(`Unsupported native agent selector in ${path}. Rename it using letters, numbers, dots, @, +, - or underscores.`);continue; }
          const prior = selectors.findIndex(x=>x.selector.kind === "agent" && x.selector.name === selectedName);
          const selected = {selector:{kind:"agent" as const,name:selectedName},model:field("model"),path};
          if (prior >= 0) selectors[prior] = selected; else selectors.push(selected);
        }
      }
      for (const root of ancestors) {
        await take(join(root,"CLAUDE.md")); await take(join(root,"CLAUDE.local.md"));
        const config = await json(join(root,".mcp.json")); for (const key of Object.keys(config?.mcpServers ?? {})) if(name(key)) mcp.add(key);
      }
      const user = await json(join(home,".claude.json"));
      for (const config of [user,user?.projects?.[project]]) for (const key of Object.keys(config?.mcpServers ?? {})) if(name(key)) mcp.add(key);
      const desktop = new Set<string>();
      for (const path of [join(home,".config","Claude","claude_desktop_config.json"),join(home,"Library","Application Support","Claude","claude_desktop_config.json")]) {
        const config = await json(path);for(const key of Object.keys(config?.mcpServers??{}))if(name(key)&&!mcp.has(key))desktop.add(key);
      }
      if(desktop.size)issue(`Claude Desktop MCP servers are not loaded by Claude Code CLI: ${[...desktop].sort().join(", ")}. Configure those tools in Claude Code before connecting this project.`);
    } else {
      const codexHome = env.CODEX_HOME || join(home,".codex");
      const toml = async (path: string, overlay = false) => {
        const body = await take(path); if (body === null) return null;
        // Discovery extracts labels only. Native Codex remains the authority for TOML resolution.
        const top = body.split(/^\s*\[/m,1)[0], chosen = name(top.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]);
        if (!overlay && chosen) model = chosen;
        for (const match of body.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\]\s*(?:#.*)?$/gm)) { const key = name(match[1]||match[2]||match[3]); if(key) mcp.add(key); }
        return chosen;
      };
      await take(join(codexHome,"AGENTS.md")); await take(join(codexHome,"AGENTS.override.md"));
      await toml(join(codexHome,"config.toml"));
      await readSkills(join(codexHome,"skills")); await readSkills(join(home,".agents","skills"));
      for (const entry of await filesIn(codexHome)) if (entry.isFile() && entry.name.endsWith(".config.toml")) {
        const selectedName = name(entry.name.slice(0,-".config.toml".length)); if(!selectedName) continue;
        if(!selectorName(selectedName)){issues.push(`Unsupported native profile selector in ${join(codexHome,entry.name)}. Rename it using letters, numbers, dots, @, +, - or underscores.`);continue;}
        const path = join(codexHome,entry.name), selectedModel = await toml(path,true);
        selectors.push({selector:{kind:"profile",name:selectedName},model:selectedModel,path});
      }
      for(const root of ancestors) {
        await take(join(root,"AGENTS.md"));await take(join(root,"AGENTS.override.md"));
        await toml(join(root,".codex","config.toml"));await readSkills(join(root,".agents","skills"));await readSkills(join(root,".codex","skills"));
      }
    }
    if (!binary) issue(`Install ${NATIVE_RUNTIME_FACTS[runtime].label} on this machine and add it to PATH.`);
    else if (!supported) {
      const label=NATIVE_RUNTIME_FACTS[runtime].label,minimum=NATIVE_MINIMUM_VERSION[runtime],major=minimum.split(".")[0];
      issue(`${version ? `Native CLI version ${version} is unsupported.` : "The installed native CLI version could not be checked."} Use ${label} ${minimum} or newer within major ${major}. Other majors and prereleases require bridge compatibility validation.`);
    }
    issues.push("Interactive approval requests cannot be answered by this bridge; denied requests must be run in the native CLI.");
    const config = [...configuration].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}));
    for (const selected of selectors) {
      const ownModel = selected.model === "inherit" ? model : selected.model ?? model;
      const target: NativeTarget = {runtime,project,selector:selected.selector,machine_id,version,model:ownModel,fingerprint:hash(JSON.stringify([runtime,version,selected.selector,config])),configuration:config,skills:[...skills].sort(),mcp_servers:[...mcp].sort(),state:needsAttention ? "needs_attention" : "needs_verification",issues:[...issues],capabilities:{launch:supported,notes:supported,skills:supported,workflows:false,approval:"unavailable",usage:supported}};
      targets.push(target);
    }
  }
  return {machine_id,targets};
}

/** Checks installed CLI and local sign-in only; this never launches a model or project hooks. */
export async function verifyNative(target: NativeTarget | NativeBinding, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<NativeBinding> {
  const env = options.env ?? process.env;
  const discovered = await discoverNative({project:target.project,runtime:target.runtime,env});
  const current = discovered.targets.find(each=>nativeIdentity(each) === nativeIdentity(target));
  if (!current) return {...target,state:"needs_attention",connected:false,issues:["The selected native agent or profile no longer exists. Discover this project again."]};
  const binary = await nativeExecutable(current.runtime,env);
  if (!binary || current.state === "needs_attention") return {...current,connected:false};
  const auth = await nativeMetadata(binary,[...NATIVE_RUNTIME_FACTS[current.runtime].authStatus],current.project,env,options.timeoutMs);
  let authenticated = auth.code === 0;
  if (NATIVE_RUNTIME_FACTS[current.runtime].authStatusJson) { try { authenticated = authenticated && JSON.parse(auth.stdout).loggedIn === true; } catch { authenticated = false; } }
  // Codex reports login status to stderr in released CLIs; its exit code is the supported check.
  if (!authenticated) return {...current,state:"needs_attention",connected:false,issues:[...current.issues,`Sign in with ${NATIVE_RUNTIME_FACTS[current.runtime].loginCommand} on this machine, then verify again.`]};
  return {...current,state:"ready",connected:true,verified_at:new Date().toISOString(),issues:[...current.issues,"Authentication checked; model and tool execution remain untested."]};
}
