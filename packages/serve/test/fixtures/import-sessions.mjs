// Synthetic Claude Code, Codex and pi sessions, written as each tool writes its JSONL, for the importer's tests. Every
// value is invented: the projects are under the test's own scratch home, the ids are made up, and no line comes from a
// real transcript.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
export const at = (minute) => new Date(T0 + minute * 60_000).toISOString();
export const sessionId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writes `records` as JSONL at `file`, dated an hour ago unless `fresh`: an import leaves a file written lately. */
export function writeSession(file, records, { fresh = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  if (!fresh) {
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
  }
  return file;
}

/** A Claude Code session in `cwd`: a question, a Bash call and its output, an answer, and its cost record. */
export function claudeSession(home, cwd, n, { prompt = "List the files.", output = "README.md", cost = 0.0421, sidechain = false, interrupted = false, failed = false, env = {}, slug = cwd.replaceAll("/", "-") } = {}) {
  const id = sessionId(n);
  const base = {
    sessionId: id,
    cwd,
    gitBranch: "main",
    version: "2.1.0",
    isSidechain: sidechain,
    userType: "external",
  };
  const records = [
    {
      ...base,
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      message: { role: "user", content: prompt },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a1",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "thinking", thinking: "unseen" }],
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a2",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Listing them." }],
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a3",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls", env },
          },
        ],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u2",
      timestamp: at(2),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: output }],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u3",
      timestamp: at(2),
      isMeta: true,
      message: { role: "user", content: "a hook's note, not the person's" },
    },
    failed
      ? {
          ...base,
          type: "assistant",
          uuid: "a4",
          timestamp: at(3),
          isApiErrorMessage: true,
          message: {
            id: "msg_2",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: overloaded" }],
          },
        }
      : {
          ...base,
          type: "assistant",
          uuid: "a4",
          timestamp: at(3),
          message: {
            id: "msg_2",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: `The files: ${output}.` }],
          },
        },
    ...(interrupted
      ? [
          {
            ...base,
            type: "user",
            uuid: "u4",
            timestamp: at(4),
            message: { role: "user", content: "[Request interrupted by user]" },
          },
        ]
      : []),
    {
      type: "cost-state",
      sessionId: id,
      totalCostUSD: cost,
      hasUnknownModelCost: false,
      startTime: T0,
    },
  ];
  return writeSession(join(home, ".claude", "projects", slug, `${id}.jsonl`), records);
}

/** A Codex session in `cwd`: the CLI's own context, a question, a shell call and its output, an answer; tokens only, no
 *  cost. Each of the person's turns is a user message and, as older Codex wrote it, a user_message event too; with
 *  `events: false`, as current Codex writes it, the user message alone. `then` is a second turn, with an image. */
export function codexSession(home, cwd, n, { prompt = "Run the tests.", output = "2 passed", subagent = false, aborted = false, events = true, then } = {}) {
  const id = sessionId(n);
  const text = (value) => ({ type: "input_text", text: value });
  const said = (minute, content, message) => [
    {
      timestamp: at(minute),
      type: "response_item",
      payload: { type: "message", role: "user", content },
    },
    ...(events
      ? [
          {
            timestamp: at(minute),
            type: "event_msg",
            payload: { type: "user_message", message, images: [] },
          },
        ]
      : []),
  ];
  const ended = (minute, answer, last) => ({
    timestamp: at(minute),
    type: "event_msg",
    payload: aborted && last ? { type: "turn_aborted", reason: "interrupted" } : { type: "task_complete", last_agent_message: answer },
  });
  const records = [
    {
      timestamp: at(0),
      type: "session_meta",
      payload: {
        id,
        cwd,
        timestamp: at(0),
        model_provider: "openai",
        cli_version: events ? "0.99.0" : "0.150.0",
        source: subagent
          ? {
              subagent: {
                thread_spawn: { parent_thread_id: sessionId(n + 1000) },
              },
            }
          : "cli",
      },
    },
    {
      timestamp: at(0),
      type: "turn_context",
      payload: { cwd, model: "gpt-sol-6.1", effort: "medium" },
    },
    {
      timestamp: at(0),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [text(`# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nnot the person's\n</INSTRUCTIONS>`), text(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`)],
      },
    },
    ...said(0, [text(prompt)], prompt),
    {
      timestamp: at(1),
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "unseen" },
    },
    {
      timestamp: at(1),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["npm", "test"] }),
        call_id: "call_1",
      },
    },
    {
      timestamp: at(2),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_1", output },
    },
    {
      timestamp: at(2),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 900, output_tokens: 40 } },
      },
    },
    {
      timestamp: at(3),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Tests: ${output}.` }],
      },
    },
    ended(3, `Tests: ${output}.`, !then),
    ...(then
      ? [
          {
            timestamp: at(4),
            type: "turn_context",
            payload: { cwd, model: "gpt-sol-6.1", effort: "medium" },
          },
          ...said(4, [text("<image name=[Image #1]>"), { type: "input_image", image_url: "data:image/png;base64,AAAA" }, text("</image>"), text(then)], then),
          {
            timestamp: at(5),
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          },
          ended(5, "Done.", true),
        ]
      : []),
  ];
  return writeSession(join(home, ".codex", "sessions", "2026", "10", "20", `rollout-2026-10-20T09-00-00-${id}.jsonl`), records);
}

/** A pi session in `cwd`: a question, a read call and its result, an answer; each request priced. */
export function piSession(home, cwd, n, { prompt = "Read the notes.", output = "three notes", costs = [0.002, 0.003], fresh = false } = {}) {
  const id = sessionId(n);
  const usage = (total) => ({
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: total === null ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const t = (minute) => T0 + minute * 60_000;
  const records = [
    { type: "session", version: 3, id, timestamp: at(0), cwd },
    {
      type: "model_change",
      id: "e1",
      parentId: null,
      timestamp: at(0),
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: at(0),
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: t(0),
      },
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: at(1),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_1",
            name: "read",
            arguments: { path: "notes.md" },
          },
        ],
        provider: "anthropic",
        model: "claude-sonnet-5",
        api: "anthropic-messages",
        usage: usage(costs[0]),
        stopReason: "toolUse",
        timestamp: t(1),
      },
    },
    {
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: at(2),
      message: {
        role: "toolResult",
        toolCallId: "tc_1",
        toolName: "read",
        content: [{ type: "text", text: output }],
        isError: false,
        timestamp: t(2),
      },
    },
    {
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: at(3),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Read: ${output}.` }],
        provider: "anthropic",
        model: "claude-sonnet-5",
        api: "anthropic-messages",
        usage: usage(costs[1]),
        stopReason: "stop",
        timestamp: t(3),
      },
    },
  ];
  const dir = `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;
  return writeSession(join(home, ".pi", "agent", "sessions", dir, `2026-10-20T09-00-00-000Z_${id}.jsonl`), records, { fresh });
}
