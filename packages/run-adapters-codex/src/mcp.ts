// A session's remote MCP servers on Codex, written for AgentRun. Codex's own MCP client calls each one at the session's
// model proxy (`<modelUrl>/mcp/<server>`, which the kernel's proxy mounts from the session's MCP and CODEX_MCP_CLIENT),
// with the session's key as its bearer, so it never holds a server's credential. The session's machine
// (host/machine.ts) does both halves:
//  - it writes each server in Codex's `mcp_servers` (an app may not: config.ts RESERVED_CONFIG_KEYS), with only the
//    granted tools. Each call is allowed without asking (`default_tools_approval_mode = "approve"`): the proxy is the
//    one gate, and under Codex's default a tool with no `readOnlyHint` is refused when nobody is there to approve it.
//    Each server is `required`: one that does not start fails the thread's start, never a turn without its tools.
//  - it records each call (`recorded`). Codex sends a call to the proxy as soon as it starts the call's item, and waits
//    for nothing of ours, so the proxy writes the call's intent in the session's records itself, by Codex's own call id
//    (`_meta.callId`), before anything is sent, and its outcome after. A call a crash cut off is then answered
//    interrupted from the records, never sent twice.
import type { McpCallResult, McpClient, SessionMcp } from "@parcha/agentrun-kernel";
import type { TomlValue } from "./config.js";
import type { DriveContext } from "./host/kernel.js";
import { BuiltinCalls, type CallHooks, toolKey } from "./host/process.js";

/** Codex's own MCP client: it sends a call's id in tools/call's `_meta.callId`, its `mcpToolCall` item's id
 *  (codex-rs core/src/mcp_tool_call.rs at rust-v0.164.0), the id the drive records the call by. */
export const CODEX_MCP_CLIENT: McpClient = { callIdMeta: "callId" };

/** What a call answers when its line never reached the log: nothing was sent, and it may be made again. */
const LAGGING = "Not sent: the session's log had not caught up with this call yet. Nothing reached the MCP server; make the same call again.";

/** The `mcp_servers` table for `mcp`'s servers at the proxy `modelUrl`, Codex's bearer read from `keyEnv` (the env var
 *  that holds the session's key). No `tool_timeout_sec`: Codex's 300 s default covers the gateway's own bound on one
 *  call (120 s), and a call that needs a person parks and ends the turn, never waits at the proxy. */
export function mcpServersConfig(mcp: SessionMcp, modelUrl: string, keyEnv: string): Record<string, TomlValue> {
  return Object.fromEntries(mcp.servers.map((server) => [server.name, {
    url: `${modelUrl}/mcp/${server.name}`,
    bearer_token_env_var: keyEnv,
    enabled_tools: server.tools.map((tool) => tool.name),
    required: true,
    default_tools_approval_mode: "approve",
  }]));
}

const said = (text: string, isError: boolean): McpCallResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** `mcp` with each call recorded in the drive's session as a built-in's, `mcp__<server>__<tool>` under Codex's call id:
 *  its intent once `barrier` has its line in the log and before it is sent, its outcome once it answers. A call id the
 *  records already hold is answered from them. */
export function recorded(mcp: SessionMcp, ctx: DriveContext, hooks: () => CallHooks | undefined): SessionMcp {
  const calls = new BuiltinCalls(ctx);
  return {
    servers: mcp.servers,
    async call(server, tool, args, context) {
      const callId = context.callId;
      if (!callId) return said("Not sent: the call carried no call id to record it by. Nothing reached the MCP server.", true);
      const name = `mcp__${server}__${tool}`;
      // A call the interrupted turn already completed, re-issued by a rewritten script under a new id: answered from the log.
      const again = hooks()?.recovered(name, args);
      if (again !== undefined) return said(again, false);
      let start;
      try {
        // The call's own line in the log before its intent, as a built-in's (code-mode.ts holds the barrier).
        if (!ctx.isMemoized(toolKey(callId)) && !(await (hooks()?.barrier(callId) ?? false))) return said(LAGGING, true);
        start = await calls.begin({ callId, name, input: args, replay: "never" });
      } catch {
        return said("Not sent: the session could not record the call. Nothing reached the MCP server.", true);
      }
      if (!start.run) return said(start.result.text, start.result.isError === true);
      const result = await mcp.call(server, tool, args, context);
      await calls.end(callId, { text: result.content.map((block) => block.text).join("\n\n"), isError: result.isError === true }).catch(() => {});
      return result;
    },
  };
}
