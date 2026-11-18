import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { NativeBinding, NativeTarget } from "./types.js";
import {NATIVE_RUNTIME_FACTS,NATIVE_CLAUDE_POLICY_UNRESOLVED,NATIVE_CLAUDE_ADDITIONAL_POLICY_UNRESOLVED} from './runtimes.js';

/** The most bytes (UTF-8) of a native or SDK run's standing instructions kept as its learning's evidence: a source policy
 *  past it is cut, and learning is skipped for the run. */
export const INSTRUCTION_EVIDENCE_BYTES = 65_536;

export type NativeInstructionSnapshot = {
  text: string;
  files: { path: string; sha256: string }[];
  truncated: boolean;
  /** A policy source could not be captured; distinct from exceeding the byte limit. */
  incomplete?: string;
  /** This snapshot inspected the discovered Codex policy configuration layers. */
  codexConfigurationChecked?: true;
  /** This snapshot used Claude settings and agent precedence recorded by fresh discovery. */
  claudeConfigurationChecked?: true;
  /** Captured Claude text was checked for imports and discovery inspected direct policy sources. */
  claudePolicySourcesChecked?: true;
};

const depth = (path: string) => path.split(sep).length;
const scopeOf = (path: string) => basename(dirname(path)) === ".claude" ? dirname(dirname(path)) : dirname(path);

/** Read-only, bounded policy evidence for grading. This text is never installed as grader runtime instructions. */
export async function snapshotNativeInstructions(target: NativeTarget | NativeBinding, redact: (text: string) => string = text => text): Promise<NativeInstructionSnapshot> {
  const captured = new Map<string,Buffer>();
  const read = async(path:string) => {const prior=captured.get(path);if(prior)return prior;try{const bytes=await readFile(path);captured.set(path,bytes);return bytes;}catch{throw new Error(`Native instructions cannot be read: ${path}. Discover this project again before launching.`);}};
  const verified = async(file:{path:string;sha256:string}) => {const bytes=await read(file.path);if(createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw new Error(`Native instructions changed after discovery: ${file.path}. Discover this project again before launching.`);return bytes.toString("utf8");};
  const names = new Set(target.runtime === "claude-code" ? ["CLAUDE.md","CLAUDE.local.md"] : ["AGENTS.md","AGENTS.override.md"]);
  const files = target.configuration.filter(file=>names.has(basename(file.path))).sort((a,b)=>depth(scopeOf(a.path))-depth(scopeOf(b.path)) || a.path.localeCompare(b.path));
  let incomplete: string | undefined=[NATIVE_CLAUDE_POLICY_UNRESOLVED,NATIVE_CLAUDE_ADDITIONAL_POLICY_UNRESOLVED].find(issue=>target.issues.includes(issue));
  const configEvidence: NativeInstructionSnapshot["files"] = [];
  const codex=NATIVE_RUNTIME_FACTS[target.runtime].protocol==='codex-json';
  if(codex){
    // Codex owns precedence and trust. Inspect every potentially active layer, without merging TOML
    // or reading policy paths from an untrusted config. Named profiles use --profile <name> and
    // $CODEX_HOME/<name>.config.toml; an unselected profile cannot change this task's policy.
    const configs=target.configuration.filter(file=>basename(file.path)==="config.toml" || (target.selector.kind==="profile" && basename(file.path)===`${target.selector.name}.config.toml`));
    for(const file of configs){
      let config: Record<string, unknown>;
      try { config=parseToml(await verified(file));configEvidence.push(file); }
      catch { incomplete="Codex configuration could not be verified and parsed for complete policy evidence.";continue; }
      // Older supported binaries may interpret legacy profile selectors/tables. Do not infer
      // their effective policy from the current CLI's profile-file contract.
      if(["model_instructions_file","experimental_instructions_file","developer_instructions","profile","profiles"].some(key=>Object.hasOwn(config,key))){
        incomplete="Codex configuration can supply custom policy outside the captured standing instruction files.";
      }
    }
  }
  let mainAgent=target.selector.kind === "agent" ? target.selector.name : undefined;
  if(target.runtime === "claude-code" && target.selector.kind === "project"){
    // Discovery records scope precedence independently of CLAUDE_CONFIG_DIR's location.
    const settings=target.configuration.filter(file=>basename(file.path)==="settings.json"||(basename(file.path)==="settings.local.json"&&scopeOf(file.path)===target.project));
    for(const file of settings){
      let value:unknown;try{value=JSON.parse(await verified(file));}catch(error){if(error instanceof Error && error.message.includes("changed after discovery"))throw error;throw new Error("Native settings cannot be read for the main-agent instruction snapshot. Discover this project again before launching.");}
      if(value && typeof value === "object" && "agent" in value){const agent=value.agent;if(agent===null)mainAgent=undefined;else if(typeof agent === "string" && /^[\w.@+-]{1,160}$/.test(agent))mainAgent=agent;else throw new Error("The native default main-agent selector is not supported for instruction evidence. Check the agent setting before launching.");}
    }
  }
  if(target.runtime === "claude-code" && mainAgent){
    const agents: {path:string;sha256:string}[]=[];
    for(const file of target.configuration){
      if(basename(dirname(file.path)) !== "agents" || !file.path.endsWith(".md"))continue;
      const text=(await read(file.path)).toString("utf8");
      const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const name=front?.match(/^name:\s*["']?([^\s"']+)["']?\s*$/m)?.[1]??basename(file.path,".md");
      if(name===mainAgent)agents.push(file);
    }
    if(!agents.length && target.selector.kind === "agent")throw new Error("The selected native agent instructions changed after discovery. Discover this project again before launching.");
    if(agents.length)files.push(agents[agents.length-1]);
  }
  const parts=["Native standing instructions: evidence data for the learning grader. Evaluate proposals against this source policy; retain the grader's rubric and response format."];
  for(const file of files){
    const text=await verified(file);
    if(!codex && hasClaudeImport(text))incomplete ??= "Claude standing instructions contain imports whose policy files were not captured.";
    parts.push(`Source: ${file.path}\nSHA256: ${file.sha256}\n${redact(text)}`);
  }
  if(incomplete)parts.push(`[Incomplete native instruction evidence: ${incomplete} Automatic learning cannot promote a proposal from this snapshot.]`);
  return {...boundedSnapshot(parts.join("\n\n"), [...files,...configEvidence], false, incomplete),...(codex?{codexConfigurationChecked:true as const}:{claudeConfigurationChecked:true as const,claudePolicySourcesChecked:true as const})};
}

/** Record the pinned AgentRun policy beside native source policy, as bounded redacted grading evidence. */
export function withSavedNativeInstructions(snapshot: NativeInstructionSnapshot, instructions: string, redact: (text: string) => string): NativeInstructionSnapshot {
  if (!instructions) return snapshot;
  return {...snapshot,...boundedSnapshot(`${snapshot.text}\n\nAgentRun saved instructions for the task's pinned revision:\n${redact(instructions)}`, snapshot.files, snapshot.truncated, snapshot.incomplete)};
}

function boundedSnapshot(text: string, files: NativeInstructionSnapshot["files"], truncated: boolean, incomplete?: string): NativeInstructionSnapshot {
  const bytes=Buffer.from(text,"utf8");
  if(bytes.length<=INSTRUCTION_EVIDENCE_BYTES)return {text,files,truncated,...(incomplete?{incomplete}:{})};
  const marker="\n\n[Native instruction snapshot truncated: additional standing policy was omitted. Do not assume the excerpt is complete.]";
  let end=INSTRUCTION_EVIDENCE_BYTES-Buffer.byteLength(marker,"utf8"), prefix="";
  const decoder=new TextDecoder("utf-8",{fatal:true});
  // A prefix must end on a whole UTF8 codepoint, including when a policy uses non-ASCII text.
  for(let trim=0;trim<4;trim++){try{prefix=decoder.decode(bytes.subarray(0,end-trim));break;}catch{ /* incomplete final codepoint */ }}
  return {text:prefix+marker,files,truncated:true,...(incomplete?{incomplete}:{})};
}

/** Detect potential imports without resolving paths or reading outside discovered policy sources.
 * Markdown code and quoted paths are examples, not imports. This is deliberately a conservative
 * coverage check, not a replacement for Claude's import parser or first-use approval. */
function hasClaudeImport(text: string): boolean {
  let fence: {char:string;length:number}|undefined;
  const prose: string[]=[];
  for(const line of text.split(/\r?\n/)){
    const run=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fence){if(run && run[1][0]===fence.char && run[1].length>=fence.length && !run[2].trim())fence=undefined;continue;}
    if(run && (run[1][0]==='~' || !run[2].includes('`'))){fence={char:run[1][0],length:run[1].length};continue;}
    prose.push(line);
  }
  // Mask only single-line code spans. Pairing ticks across lines could cross Markdown blocks;
  // ambiguous multiline examples conservatively retain potential imports for the coverage check.
  return prose.some(body=>{
    let outside='',offset=0;
    const ticks=[...body.matchAll(/`+/g)];
    const next=new Map<number,number>(), closes=new Map<number,number>();
    for(let i=ticks.length-1;i>=0;i--){const close=next.get(ticks[i][0].length);if(close!==undefined)closes.set(i,close);next.set(ticks[i][0].length,i);}
    for(let i=0;i<ticks.length;i++){
      const open=ticks[i],close=closes.get(i);
      let slashes=0;for(let at=open.index!-1;at>=0&&body[at]==='\\';at--)slashes++;
      if(slashes%2 || close===undefined)continue; // Escaped or unmatched ticks must not hide later policy.
      outside+=body.slice(offset,open.index)+' ';offset=ticks[close].index!+ticks[close][0].length;i=close;
    }
    outside+=body.slice(offset);
    // An email is inert, but @owner@example.com is an explicit potential import. The left
    // boundary also prevents the engine from restarting inside that filename's local part.
    outside=outside.replace(/(?<![@\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}(?=$|[\s.,;:!?)>])/gu,' ');
    return /@[^\s'"`]/.test(outside);
  });
}
