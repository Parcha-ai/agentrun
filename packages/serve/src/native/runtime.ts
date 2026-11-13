import { spawn, type ChildProcess } from "node:child_process";
import { NATIVE_RUNTIME_FACTS } from "./runtimes.js";
import { nativeExecutable, nativeMetadata } from "./discovery.js";
import type { NativeBinding, NativeEvent, NativeResult, NativeSendOptions, NativeSession, NativeTarget, NativeUsage } from "./types.js";

const unknownUsage = (): NativeUsage => ({input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,cost_usd:null});
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const usageOf = (raw: Record<string,unknown> | undefined, claude: boolean, cost?: unknown): NativeUsage => ({
  input_tokens:count(raw?.input_tokens), output_tokens:count(raw?.output_tokens),
  cache_read_tokens:count(claude ? raw?.cache_read_input_tokens : raw?.cached_input_tokens),
  cache_write_tokens:count(claude ? raw?.cache_creation_input_tokens : raw?.cache_write_input_tokens),cost_usd:count(cost),
});

export class NativeRuntimeError extends Error {
  constructor(message: string, readonly code: "unavailable" | "protocol" | "failed" | "timeout" | "aborted" | "approval_required", readonly sessionId?: string) { super(message); this.name = code === "aborted" ? "AbortError" : "NativeRuntimeError"; }
}

/** CLI JSON mode preserves normal native resolution. An unavailable approval is denied, never upgraded. */
export async function openNativeSession(options: {
  target: NativeTarget | NativeBinding;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  context?: string;
  onEvent?: (event: NativeEvent) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<NativeSession> {
  const {target} = options, env = options.env ?? process.env;
  if (options.signal?.aborted) throw new NativeRuntimeError("Native launch was cancelled.","aborted");
  if (target.selector.kind !== "project" && target.selector.kind !== NATIVE_RUNTIME_FACTS[target.runtime].namedSelector) throw new NativeRuntimeError("This native runtime does not support the selected agent/profile selector. Discover this project again.","unavailable");
  if (target.selector.kind !== "project" && (!target.selector.name || !/^[\w.@+-]{1,160}$/.test(target.selector.name))) throw new NativeRuntimeError("The native selector is invalid. Discover this project again.","unavailable");
  const binary = await nativeExecutable(target.runtime,env);
  if (!binary) throw new NativeRuntimeError("The installed native CLI is unavailable on this machine. Verify the connection and PATH.","unavailable");
  let sessionId = options.sessionId, active: ChildProcess | undefined, closed = false, busy = false, failed = false;
  // Claude's total_cost_usd includes previous resumed invocations; token counters do not.
  let claudeCumulativeCost: number | null = options.sessionId ? null : 0;
  let codexCumulativeUsage: NativeUsage = options.sessionId ? unknownUsage() : {input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,cost_usd:null};
  let stopActive: (()=>void) | undefined;
  const kill = () => { if (!active?.pid) return; try { process.kill(process.platform === "win32" ? active.pid : -active.pid,"SIGKILL"); } catch { /* process already exited */ } };
  const session: NativeSession = {
    async send(prompt: string, sendOptions: NativeSendOptions = {}): Promise<NativeResult> {
      if (closed || failed) throw new NativeRuntimeError("This native session is closed. Inspect its recorded outcome before starting another run.","unavailable",sessionId);
      if (busy) throw new NativeRuntimeError("A turn is already running in this native session.","unavailable",sessionId);
      if (sendOptions.signal?.aborted || options.signal?.aborted) throw new NativeRuntimeError("Native turn was cancelled before dispatch.","aborted",sessionId);
      busy = true;
      try {
      const claude = NATIVE_RUNTIME_FACTS[target.runtime].protocol === "claude-json", args: string[] = [];
      if (claude) {
        args.push("--print","--output-format","stream-json","--verbose","--permission-prompts","none");
        if (target.selector.kind === "agent") args.push("--agent",target.selector.name!);
        if (sessionId) args.push("--resume",sessionId);
        if (options.context && !sessionId) args.push("--append-system-prompt",options.context);
        if (sendOptions.reflection) args.push("--tools","","--disallowedTools","*");
      } else {
        if (target.selector.kind === "profile") args.push("--profile",target.selector.name!);
        if (sendOptions.reflection) {
          // Restrict only this reflection process. The user's files and task settings remain native.
          // Resolve with the installed CLI rather than guessing TOML layouts or profile/plugin precedence.
          const metadata = await nativeMetadata(binary,[...(target.selector.kind === "profile" ? ["--profile",target.selector.name!] : []),"mcp","list","--json"],target.project,env);
          let servers: { name: string; type: "stdio" | "streamable_http" }[];
          try {
            const list: unknown = JSON.parse(metadata.stdout);
            if(metadata.code!==0 || !Array.isArray(list) || list.some(server=>!server || typeof server.name!=="string" || !/^[\w-]+$/.test(server.name) || !["stdio","streamable_http"].includes(server.transport?.type)))throw new Error();
            servers=list.map(server=>({name:server.name,type:server.transport.type}));
          } catch { throw new NativeRuntimeError("Native MCP configuration could not be safely disabled for reflection. Check codex mcp list --json and use MCP server names containing only letters, numbers, hyphens or underscores.","unavailable",sessionId); }
          if(closed || options.signal?.aborted || sendOptions.signal?.aborted)throw new NativeRuntimeError("Native reflection was cancelled before dispatch.","aborted",sessionId);
          args.push("--sandbox","read-only");
          for (const feature of ["shell_tool","unified_exec","apps","plugins","multi_agent","multi_agent_v2","in_app_browser","browser_use","computer_use"]) args.push("--disable",feature);
          for (const server of servers) {
            args.push("--config",`mcp_servers.${server.name}.enabled=false`);
            // Inherited native entries can lack a base TOML transport. Supply an inert disabled transport,
            // never credentials or the original command/URL, so native validation still succeeds.
            args.push("--config",server.type === "stdio" ? `mcp_servers.${server.name}.command="agentrun-reflection-disabled"` : `mcp_servers.${server.name}.url="http://127.0.0.1:1"`);
          }
          const disabled = await nativeMetadata(binary,[...args,"mcp","list","--json"],target.project,env);
          try {
            const list: unknown = JSON.parse(disabled.stdout);
            if(disabled.code!==0 || !Array.isArray(list) || list.some(server=>server?.enabled!==false) || servers.some(server=>!list.some(disabledServer=>disabledServer?.name===server.name)))throw new Error();
          } catch { throw new NativeRuntimeError("Native MCP servers could not be confirmed disabled. Reflection was not dispatched; verify the native CLI configuration before enabling learning.","unavailable",sessionId); }
          if(closed || options.signal?.aborted || sendOptions.signal?.aborted)throw new NativeRuntimeError("Native reflection was cancelled before dispatch.","aborted",sessionId);
        }
        args.push("exec");
        if (sessionId) args.push("resume","--json",sessionId,"-"); else args.push("--json","--color","never","-");
      }
      const input = !claude && options.context && !sessionId ? `<agentrun_context>\n${options.context}\n</agentrun_context>\n\n${prompt}` : prompt;
        return await new Promise<NativeResult>((resolveResult,reject) => {
          let buffer = "", bytes = 0, answer = "", usage = unknownUsage(), model: string | undefined, completed = false, stopped = false, terminalReceived = false, protocolError: Error | undefined;
          const denials: string[] = [], toolNames = new Map<string,string>();
          const seenEvents = new Set<string>();
          let eventQueue = Promise.resolve();
          const child = spawn(binary,args,{cwd:target.project,env,detached:process.platform !== "win32",stdio:["pipe","pipe","pipe"]}); active = child;
          const emit = (event: NativeEvent) => { eventQueue = eventQueue.then(()=>options.onEvent?.(event)).then(()=>{}); eventQueue.catch(error=>stop(error instanceof Error ? error : new Error("Native event recording failed."))); };
          const abort = () => stop(new NativeRuntimeError("Native turn was cancelled; its outcome may be incomplete. Inspect the recorded session before retrying.","aborted",sessionId));
          const timer = setTimeout(()=>stop(new NativeRuntimeError("Native turn timed out; its outcome may be incomplete. Inspect the recorded session before retrying.","timeout",sessionId)),Math.min(Math.max(sendOptions.timeoutMs ?? 180_000,1),600_000));
          const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort",abort);sendOptions.signal?.removeEventListener("abort",abort);if(active===child)active=undefined;stopActive=undefined; };
          const stop = (error: Error) => { if(stopped)return;stopped=true;failed=true;kill();cleanup();reject(error); };
          stopActive = abort;
          options.signal?.addEventListener("abort",abort,{once:true});sendOptions.signal?.addEventListener("abort",abort,{once:true});
          const setSession = (id: unknown) => {
            if(typeof id !== "string" || !id)return;
            if(sessionId && id !== sessionId)throw new NativeRuntimeError("The native CLI resumed a different session; this turn was stopped.","protocol",sessionId);
            if(!sessionId){sessionId=id;emit({type:"session",sessionId:id});}
          };
          const onLine = (line: string) => {
            if(!line.trim())return;
            let event: any;try{event=JSON.parse(line);}catch{throw new NativeRuntimeError("The native CLI returned invalid JSON. Check its installed version and configuration.","protocol",sessionId);}
            const eventKey = !claude && event.item?.id && ["item.started","item.completed"].includes(event.type) ? `${event.type}:${event.item.id}` : JSON.stringify(event);
            if(seenEvents.has(eventKey))return;seenEvents.add(eventKey);
            if(claude){
              setSession(event.session_id);
              if(event.type === "system" && event.subtype === "init")model=typeof event.model === "string" ? event.model : undefined;
              if(event.type === "assistant")for(const block of event.message?.content ?? []){
                if(block.type === "text" && typeof block.text === "string"){answer+=block.text;emit({type:"text",text:block.text});}
                if(block.type === "tool_use"){toolNames.set(block.id,block.name);emit({type:"tool",id:block.id,name:block.name,input:block.input,status:"started"});}
              }
              if(event.type === "user")for(const block of event.message?.content ?? [])if(block.type === "tool_result")emit({type:"tool",id:block.tool_use_id,name:toolNames.get(block.tool_use_id)??"native_tool",output:block.content,status:block.is_error?"failed":"completed"});
              if(event.type === "result"){
                if(terminalReceived)return;terminalReceived=true;
                completed=event.subtype === "success" && !event.is_error;
                if(typeof event.result === "string")answer=event.result;
                const cumulative = count(event.total_cost_usd);
                const incremental = cumulative !== null && claudeCumulativeCost !== null && cumulative >= claudeCumulativeCost ? cumulative - claudeCumulativeCost : null;
                claudeCumulativeCost=cumulative;usage=usageOf(event.usage,true,incremental);emit({type:"usage",usage});
                for(const denial of event.permission_denials ?? []){const tool=typeof denial.tool_name === "string"?denial.tool_name:"native_tool";denials.push(tool);emit({type:"approval",id:String(denial.tool_use_id??denials.length),tool,input:denial.tool_input});}
                if(!completed)protocolError=new NativeRuntimeError("Claude Code did not complete the turn. Inspect its native session and authentication before retrying.","failed",sessionId);
              }
            }else{
              if(event.type === "thread.started")setSession(event.thread_id);
              const item=event.item;
              if((event.type === "item.started"||event.type === "item.completed"||event.type === "item.updated")&&item){
                if(item.type === "agent_message"&&event.type === "item.completed"&&typeof item.text === "string"){answer+=item.text;emit({type:"text",text:item.text});}
                if(["command_execution","mcp_tool_call","file_change","web_search","dynamic_tool_call"].includes(item.type)){
                  const tool=item.type === "mcp_tool_call" ? `mcp__${item.server}__${item.tool}` : item.type;
                  emit({type:"tool",id:String(item.id),name:tool,input:item.arguments??item.command??item.changes,output:item.result??item.aggregated_output??item.error,status:event.type === "item.started"?"started":["failed","declined"].includes(item.status)?"failed":"completed"});
                  if(item.status === "declined" || item.status === "denied"){denials.push(tool);emit({type:"approval",id:String(item.id),tool,input:item.arguments??item.command});}
                }
              }
              if(event.type === "turn.completed"){
                if(terminalReceived)return;terminalReceived=true;
                completed=true;
                const cumulative=usageOf(event.usage,false), incremental=unknownUsage();
                for(const key of ["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"] as const){const total=cumulative[key],previous=codexCumulativeUsage[key];incremental[key]=total!==null&&previous!==null&&total>=previous?total-previous:null;}
                codexCumulativeUsage=cumulative;usage=incremental;emit({type:"usage",usage});
              }
              if(event.type === "turn.failed" || event.type === "error"){terminalReceived=true;protocolError=new NativeRuntimeError("Codex did not complete the turn. Inspect its native session, configuration and authentication before retrying.","failed",sessionId);}
            }
          };
          child.stdout.on("data",(chunk: Buffer)=>{
            if(stopped)return;bytes+=chunk.length;if(bytes>16_777_216){stop(new NativeRuntimeError("Native output exceeded the transport limit; inspect the native session.","protocol",sessionId));return;}
            buffer+=chunk.toString();let index;while((index=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{onLine(line);}catch(error){stop(error instanceof Error?error:new Error("Native event failed."));return;}}
          });
          // Drain diagnostic output without storing credentials or unbounded stderr in the run record.
          child.stderr.on("data",()=>{});
          child.stdin.on("error",()=>{});
          child.once("error",()=>stop(new NativeRuntimeError("The native CLI could not start. Verify its executable and original project directory.","unavailable",sessionId)));
          child.once("close",(code)=>{
            if(stopped)return;
            if(buffer.trim()){try{onLine(buffer);}catch(error){stop(error instanceof Error?error:new Error("Native event failed."));return;}}
            eventQueue.then(()=>{
              if(stopped)return;
              if(protocolError || code !== 0 || !completed || !sessionId){stop(protocolError??new NativeRuntimeError(`The native CLI exited without a completed turn (exit ${code ?? "unknown"}). Inspect its native session before retrying.`,"failed",sessionId));return;}
              if(denials.length){stop(new NativeRuntimeError(`Native approval is required for ${[...new Set(denials)].join(", ")}. This bridge denied the request; continue in the native CLI.`,"approval_required",sessionId));return;}
              stopped=true;cleanup();resolveResult({sessionId,answer,model,usage,...denials.length?{permission_denials:denials}:{}});
            }).catch(stop);
          });
          child.stdin.end(input);
          if(options.signal?.aborted||sendOptions.signal?.aborted)abort();
        });
      } finally { busy = false; }
    },
    async close() { if(closed)return;closed=true;stopActive?.();kill(); },
  };
  return session;
}
