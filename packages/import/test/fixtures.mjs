// Synthetic session files, as Claude Code, Codex and pi write them, under a temporary home. Nothing here is copied from
// a real session: every id, prompt and count is made up for the test that uses it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A fresh temporary home, removed when the test ends. */
export async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The records as JSONL, one a line, each ending in a newline. */
export const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

export async function writeJsonl(file, records) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl(records));
  return file;
}

/** The i-th second of 2026-01-01, UTC. */
export const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

export const SESSION = "00000000-0000-4000-8000-000000000001";
export const claudeFile = (home, id = SESSION, project = "-work-fixture") => join(home, ".claude", "projects", project, `${id}.jsonl`);
export const subagentFile = (home, id = SESSION, name = "agent-a1", project = "-work-fixture") => join(home, ".claude", "projects", project, id, "subagents", `${name}.jsonl`);

const base = (session, i, extra = {}) => ({ sessionId: session, cwd: "/work/fixture", isSidechain: false, timestamp: at(i), ...extra });

/** A Claude Code user record. */
export const claudeUser = ({ uuid, text, i = 0, session = SESSION, sidechain = false }) => ({ ...base(session, i, { isSidechain: sidechain }), type: "user", uuid, message: { role: "user", content: text } });

/** One Claude Code assistant record: one content block of message `msg` (request `req`), with the usage it repeats. */
export const claudeAnswer = ({ uuid, msg, req, usage, i = 1, session = SESSION, block = { type: "text", text: "Done." }, model = "claude-fixture-1", sidechain = false }) => ({
  ...base(session, i, { isSidechain: sidechain }),
  type: "assistant",
  uuid,
  ...(req ? { requestId: req } : {}),
  message: { id: msg, role: "assistant", model, content: [block], usage },
});

/** Anthropic's usage block. */
export const anthropicUsage = (input, output, cacheRead = 0, cacheWrite = 0, long) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  ...(long !== undefined ? { cache_creation: { ephemeral_1h_input_tokens: long, ephemeral_5m_input_tokens: cacheWrite - long } } : {}),
});

export const codexFile = (home, name = "rollout-2026-01-01T00-00-00-fixture.jsonl") => join(home, ".codex", "sessions", "2026", "01", "01", name);
/** A Codex rollout's opening record; `parent` makes it a subagent's thread. */
export const codexMeta = (id, parent) => ({ type: "session_meta", timestamp: at(0), payload: { id, cwd: "/work/fixture", model_provider: "openai", ...(parent ? { parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } });
export const codexContext = (i = 1) => ({ type: "turn_context", timestamp: at(i), payload: { model: "gpt-fixture", effort: "high", cwd: "/work/fixture" } });
export const codexUser = (text, i = 2) => ({ type: "response_item", timestamp: at(i), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
export const codexAnswer = (text, i = 3) => ({ type: "response_item", timestamp: at(i), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
/** OpenAI's usage block: `cached` is part of `input`, `reasoning` part of `output`. */
export const openaiUsage = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
export const codexTokens = (last, total, i = 4) => ({ type: "event_msg", timestamp: at(i), payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });

export const piFile = (home, id = "pi-session-1") => join(home, ".pi", "agent", "sessions", "--work-fixture--", `2026-01-01T00-00-00_${id}.jsonl`);
export const piMeta = (id = "pi-session-1") => ({ type: "session", id, cwd: "/work/fixture", timestamp: at(0) });
export const piUser = (text, i = 1) => ({ type: "message", timestamp: at(i), message: { role: "user", content: text, timestamp: Date.parse(at(i)) } });
export const piAnswer = (usage, i = 2, cost) => ({
  type: "message",
  timestamp: at(i),
  message: { role: "assistant", provider: "fixture", model: "fixture-model", content: [{ type: "text", text: "Done." }], stopReason: "stop", usage: { ...usage, ...(cost !== undefined ? { cost: { total: cost } } : {}) }, timestamp: Date.parse(at(i)) },
});
