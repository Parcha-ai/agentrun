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

/** A Claude Code request's usage as the CLI writes it on each of its records. */
const claudeUsage = (input, cacheRead, cacheWrite, output) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, service_tier: "standard" });

/** A Claude Code session in `cwd`: a question, a Bash call and its output, an answer, and its cost record. Each
 *  request's records carry its usage (the first one the stream's start), unless `usage: false`, and the effort. With
 *  `parallel`, the first request also reads a file, its record after the Bash call's result, and the read fails; the
 *  answer's text record is written twice, and the answer runs on `answerModel`, `pause` minutes after the result. */
export function claudeSession(home, cwd, n, { prompt = "List the files.", output = "README.md", cost = 0.0421, sidechain = false, interrupted = false, failed = false, env = {}, slug = cwd.replaceAll("/", "-"), usage = true, effort = "high", parallel = false, answerModel = "claude-sonnet-5", pause = 0 } = {}) {
  const id = sessionId(n);
  const base = {
    sessionId: id,
    cwd,
    gitBranch: "main",
    version: "2.1.0",
    isSidechain: sidechain,
    userType: "external",
  };
  const turn = { effort, perTurnEffort: effort };
  const first = usage ? { usage: claudeUsage(3, 1000, 200, 50) } : {};
  const answer = {
    ...base,
    ...turn,
    type: "assistant",
    uuid: "a4",
    timestamp: at(3 + pause),
    message: {
      id: "msg_2",
      role: "assistant",
      model: answerModel,
      content: [{ type: "text", text: `The files: ${output}.` }],
      ...(usage ? { usage: claudeUsage(5, 1300, 100, 30) } : {}),
    },
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
      ...turn,
      type: "assistant",
      uuid: "a1",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "thinking", thinking: "unseen" }],
        ...(usage ? { usage: claudeUsage(3, 1000, 200, 1) } : {}),
      },
    },
    {
      ...base,
      ...turn,
      type: "assistant",
      uuid: "a2",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Listing them." }],
        ...first,
      },
    },
    {
      ...base,
      ...turn,
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
        ...first,
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
    ...(parallel
      ? [
          {
            ...base,
            ...turn,
            type: "assistant",
            uuid: "a3b",
            timestamp: at(2),
            message: {
              id: "msg_1",
              role: "assistant",
              model: "claude-sonnet-5",
              content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "missing.md" } }],
              ...first,
            },
          },
          {
            ...base,
            type: "user",
            uuid: "u2b",
            timestamp: at(2),
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "File does not exist.", is_error: true }],
            },
          },
        ]
      : []),
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
      : answer,
    ...(parallel && !failed ? [answer] : []),
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

/** A Codex request's usage as the CLI writes it: OpenAI's input_tokens holds the cached ones, its output_tokens the
 *  reasoning. */
const codexUsage = (input, cached, output, reasoning) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const plus = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + b[key]]));

/** A Codex session in `cwd`: the CLI's own context, a question, a shell call and its output, an answer; tokens only, no
 *  cost. Each of the person's turns is a user message and, as older Codex wrote it, a user_message event too; with
 *  `events: false`, as current Codex writes it, the user message alone. `then` is a second turn, with an image, on
 *  `thenModel`. Each request's usage is in a token_count event (the first one written twice), with `usage: "records"`
 *  also in a token_usage_record (the first one written twice), with `usage: "none"` in neither. With `failing`, the first
 *  request also runs two calls that fail: one whose output says so, one whose completed item does, after its output. */
export function codexSession(home, cwd, n, { prompt = "Run the tests.", output = "2 passed", subagent = false, aborted = false, events = true, then, thenModel = "gpt-sol-6.1", usage = "token_count", failing = false } = {}) {
  const id = sessionId(n);
  const text = (value) => ({ type: "input_text", text: value });
  const requests = [codexUsage(900, 600, 40, 10), codexUsage(1000, 900, 25, 5), codexUsage(1200, 1000, 10, 0)];
  let total;
  const counted = (minute, k, { again = false } = {}) => {
    if (usage === "none") return [];
    total = total ? plus(total, requests[k]) : requests[k];
    const count = {
      timestamp: at(minute),
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: requests[k], model_context_window: 272000 }, rate_limits: null },
    };
    const record = { timestamp: at(minute), type: "token_usage_record", payload: { thread_id: id, turn_id: `turn_${k}`, response_id: `resp_${k}`, usage: requests[k] } };
    return [...(usage === "records" ? (again ? [record, record] : [record]) : []), count, ...(again ? [count] : [])];
  };
  const call = (minute, callId, command) => ({
    timestamp: at(minute),
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command }), call_id: callId },
  });
  const result = (minute, callId, value) => ({ timestamp: at(minute), type: "response_item", payload: { type: "function_call_output", call_id: callId, output: value } });
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
    call(1, "call_1", ["npm", "test"]),
    ...(failing ? [call(1, "call_2", ["npm", "run", "lint"]), call(1, "call_3", ["cat", "missing.md"])] : []),
    result(2, "call_1", output),
    ...(failing
      ? [
          result(2, "call_2", "Exit code: 1\nWall time: 0.4 seconds\nOutput:\n1 problem"),
          result(2, "call_3", "No such file"),
          {
            timestamp: at(2),
            type: "event_msg",
            payload: { type: "item_completed", turn_id: "turn_0", item: { type: "CommandExecution", id: "call_3", status: "failed", exit_code: 1 } },
          },
        ]
      : []),
    ...counted(2, 0, { again: true }),
    {
      timestamp: at(3),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Tests: ${output}.` }],
      },
    },
    ...counted(3, 1),
    ended(3, `Tests: ${output}.`, !then),
    ...(then
      ? [
          {
            timestamp: at(4),
            type: "turn_context",
            payload: { cwd, model: thenModel, effort: "medium" },
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
          ...counted(5, 2),
          ended(5, "Done.", true),
        ]
      : []),
  ];
  return writeSession(join(home, ".codex", "sessions", "2026", "10", "20", `rollout-2026-10-20T09-00-00-${id}.jsonl`), records);
}

/** A pi session in `cwd`: a question, a read call and its result, an answer; each request priced, its usage counted
 *  (with `counted: false`, zeros, as pi writes a request it did not measure), the session at thinking level `thinking`.
 *  With `answerModel`, a model change before the answer; with `readFails`, the read's result is an error. */
export function piSession(home, cwd, n, { prompt = "Read the notes.", output = "three notes", costs = [0.002, 0.003], fresh = false, counted = true, thinking = "high", answerModel, readFails = false } = {}) {
  const id = sessionId(n);
  const usage = (total) => ({
    input: counted ? 100 : 0,
    output: counted ? 20 : 0,
    cacheRead: counted ? 400 : 0,
    cacheWrite: counted ? 30 : 0,
    totalTokens: counted ? 550 : 0,
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
    { type: "thinking_level_change", id: "e1b", parentId: "e1", timestamp: at(0), thinkingLevel: thinking },
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
        isError: readFails,
        timestamp: t(2),
      },
    },
    ...(answerModel ? [{ type: "model_change", id: "e4b", parentId: "e4", timestamp: at(2), provider: "anthropic", modelId: answerModel }] : []),
    {
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: at(3),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Read: ${output}.` }],
        provider: "anthropic",
        model: answerModel ?? "claude-sonnet-5",
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
