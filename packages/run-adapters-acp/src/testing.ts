// What a harness author tests an ACP harness on (`@parcha/agentrun-harness-acp/testing`, HARNESS.md): the fake ACP agent,
// a stdio agent on the official SDK whose model is a script, and its recipe. No binary, no model, no network beyond
// loopback: the conformance suite's script drives it, so an author's module runs the suite before any real agent is in it.
// Written for AgentRun.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpRecipe } from "./recipe.js";

/** The fake agent's file: `node FAKE_ACP_AGENT <config.json>` starts it (its header says what the config holds). */
export const FAKE_ACP_AGENT: string = fileURLToPath(new URL("../testing/fake-acp-agent.mjs", import.meta.url));

/** How the fake plays an agent: `load` it resumes with session/load (else a crash restarts the turn); `http` our tools
 *  reach it over HTTP (else stdio); `style` how it names our tools and what it asks permission for ("goose": every tool
 *  asks; "cursor": MCP and shell calls ask, edits do not); `askMcp` whether an MCP call asks first (default: the
 *  style's). */
export interface FakeAgentPlay {
  readonly load?: boolean;
  readonly http?: boolean;
  readonly style?: "goose" | "cursor";
  readonly askMcp?: boolean;
}

/** The fake agent as the recipe of harness `id`, its config written into `dir`, driven by `script` (the conformance
 *  suite's ScriptStep list). Billed `plan`: the fake calls no model, so no proxy is started. Our tools' permission
 *  requests are answered as each style's shipped recipe answers them: "goose" writes Goose's permission file
 *  (allowFile), so the fake asks nothing for our tools; "cursor" declares the title tie (quirks.permissionTie). */
export function fakeAgentRecipe(id: string, dir: string, script: readonly unknown[], play: FakeAgentPlay = {}): AcpRecipe {
  const load = play.load ?? true;
  const http = play.http ?? true;
  const config = join(dir, `${id}-fake-agent.json`);
  writeFileSync(config, JSON.stringify({ script, load, http, style: play.style ?? "goose", ...(play.askMcp === undefined ? {} : { askMcp: play.askMcp }) }));
  return {
    id,
    label: `${id} (the fake ACP agent)`,
    command: process.execPath,
    args: [FAKE_ACP_AGENT, config],
    state: [".fake-acp"],
    declares: { load, mcp: http ? "http" : "stdio" },
    billing: { kind: "plan", maxTurns: 100, maxToolCalls: 100 },
    ...((play.style ?? "goose") === "cursor" ? { quirks: { permissionTie: "title" } } : { allowFile: { path: ".config/goose/permission.yaml", form: "goose-permission" } }),
  };
}
