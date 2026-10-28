// A minimal Codex policy for the session's model proxy (@parcha/agentrun-adapters/host), written for AgentRun: the one
// route Codex calls (POST /v1/responses), the session's key as a bearer token, the body as the Responses API takes it
// with the session's model, `store: false`, output clamped, no provider-hosted tool, and only the session's own tools.
// It stands in until the Codex policy (policy.ts) replaces it with the same signature.
import type { IncomingHttpHeaders } from "node:http";
import { ProxyRefusal, type ProviderPolicy, type ProxyRoute, type ProxyUsage } from "@parcha/agentrun-adapters/host";

export const CODEX_RESPONSES_ROUTES: readonly ProxyRoute[] = Object.freeze([
  { method: "POST", path: "/v1/responses", headers: ["originator", "x-client-request-id"] },
]);

/** Hosted tools Codex adds to every request whatever its config says (web search): dropped, never offered. Any other hosted tool is refused. */
const DROPPED = /^(?:web_search|web_search_preview)$/;
const HOSTED_TOOL = /^(?:file_search|code_interpreter|computer|computer_use|computer_use_preview|image_generation|mcp|local_shell|shell)/;
/** Code mode's carriers: the tools a code-mode model calls the session's tools through. */
const CODE_MODE: Readonly<Record<string, string>> = Object.freeze({ exec: "custom", wait: "function" });

export interface CodexPolicyOptions {
  /** The session's model: the body's model is set to it. */
  model: string;
  /** The session's own tool names: every other tool definition is dropped. */
  tools: readonly string[];
  /** The most output tokens one request may ask for. Default 32 000. */
  maxOutputTokens?: number;
}

/** A list of tool definitions with no hosted tool, less any not the session's own (or code mode's carriers). */
function ownTools(tools: unknown, allowed: ReadonlySet<string>, carriers: boolean): unknown[] {
  if (!Array.isArray(tools)) throw new ProxyRefusal(400, "tools is not a list");
  const out: unknown[] = [];
  for (const tool of tools) {
    const { type: rawType, name: rawName, tools: inner } = (tool ?? {}) as { type?: unknown; name?: unknown; tools?: unknown };
    const type = String(rawType ?? "");
    const name = String(rawName ?? "");
    if (DROPPED.test(type)) continue;
    if (type === "namespace") {
      // A namespace holds the tools of a built-in family (or code mode's own): only the session's own ones stay, and an empty one goes.
      const kept = ownTools(inner, allowed, carriers);
      if (carriers || kept.length) out.push({ ...(tool as object), tools: kept });
      continue;
    }
    if (HOSTED_TOOL.test(type) || (type !== "function" && type !== "custom")) throw new ProxyRefusal(403, `a ${type.slice(0, 40) || "typeless"} tool is not offered to this session's model`);
    if (allowed.has(name) || (carriers && CODE_MODE[name] === type)) out.push(tool);
  }
  return out;
}

/** The usage a Responses stream (or body) reports when it completes, if it does. */
function usageOf(text: string): ProxyUsage | undefined {
  let found: ProxyUsage | undefined;
  for (const m of text.matchAll(/"usage"\s*:\s*\{[^{}]*?"input_tokens"\s*:\s*(\d+)(?:[^{}]*?"input_tokens_details"\s*:\s*\{[^{}]*?"cached_tokens"\s*:\s*(\d+)[^{}]*\})?[^{}]*?"output_tokens"\s*:\s*(\d+)/g)) {
    found = { input: Number(m[1]), cacheRead: Number(m[2] ?? 0), output: Number(m[3]) };
  }
  return found;
}

export function codexPolicy(options: CodexPolicyOptions): ProviderPolicy {
  const allowed = new Set(options.tools);
  const maxOutputTokens = options.maxOutputTokens ?? 32_000;
  return {
    id: "codex",
    routes: CODEX_RESPONSES_ROUTES,
    keyOf(headers: IncomingHttpHeaders) {
      const auth = String(headers.authorization ?? "");
      return auth.startsWith("Bearer ") ? auth.slice(7) : "";
    },
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProxyRefusal(400, "the body is not an object");
      const out = { ...(body as Record<string, unknown>) };
      if (out.tools !== undefined) out.tools = ownTools(out.tools, allowed, false);
      if (Array.isArray(out.input)) {
        out.input = out.input.map((item) => {
          const it = item as { type?: unknown; tools?: unknown };
          return it?.type === "additional_tools" ? { ...it, tools: ownTools(it.tools, allowed, true) } : item;
        });
      }
      const asked = typeof out.max_output_tokens === "number" && out.max_output_tokens > 0 ? out.max_output_tokens : maxOutputTokens;
      return { ...out, model: options.model, store: false, max_output_tokens: Math.min(asked, maxOutputTokens) };
    },
    usageOf,
  };
}
