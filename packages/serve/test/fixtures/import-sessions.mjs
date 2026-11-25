// Synthetic Claude Code, Codex, pi, OpenCode and Copilot CLI sessions, written as each tool writes its JSONL (OpenCode: its SQLite
// database), for the importer's tests. Every
// value is invented: the projects are under the test's own scratch home, the ids are made up, and no line comes from a
// real transcript.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
 *  answer's text record is written twice, and the answer runs on `answerModel`, `pause` minutes after the result. With
 *  `failed`, the answer is the CLI's API-error turn; with `noted`, the CLI's own "No response requested." follows the
 *  interrupt. With `unknownCost`, the CLI could not price a model it used. */
export function claudeSession(home, cwd, n, { prompt = "List the files.", output = "README.md", cost = 0.0421, unknownCost = false, sidechain = false, interrupted = false, failed = false, noted = false, env = {}, slug = cwd.replaceAll("/", "-"), usage = true, effort = "high", parallel = false, answerModel = "claude-sonnet-5", pause = 0 } = {}) {
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
    uuid: `a4-${n}`,
    timestamp: at(3 + pause),
    message: {
      id: `msg_2_${n}`,
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
      uuid: `u1-${n}`,
      timestamp: at(0),
      message: { role: "user", content: prompt },
    },
    {
      ...base,
      ...turn,
      type: "assistant",
      uuid: `a1-${n}`,
      timestamp: at(1),
      message: {
        id: `msg_1_${n}`,
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
      uuid: `a2-${n}`,
      timestamp: at(1),
      message: {
        id: `msg_1_${n}`,
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
      uuid: `a3-${n}`,
      timestamp: at(1),
      message: {
        id: `msg_1_${n}`,
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
      uuid: `u2-${n}`,
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
            uuid: `a3b-${n}`,
            timestamp: at(2),
            message: {
              id: `msg_1_${n}`,
              role: "assistant",
              model: "claude-sonnet-5",
              content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "missing.md" } }],
              ...first,
            },
          },
          {
            ...base,
            type: "user",
            uuid: `u2b-${n}`,
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
      uuid: `u3-${n}`,
      timestamp: at(2),
      isMeta: true,
      message: { role: "user", content: "a hook's note, not the person's" },
    },
    failed
      ? {
          ...base,
          type: "assistant",
          uuid: `a4-${n}`,
          timestamp: at(3),
          isApiErrorMessage: true,
          error: "rate_limit",
          message: {
            id: `msg_2_${n}`,
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: overloaded" }],
            usage: claudeUsage(0, 0, 0, 0),
          },
        }
      : answer,
    ...(parallel && !failed ? [answer] : []),
    ...(interrupted
      ? [
          {
            ...base,
            type: "user",
            uuid: `u4-${n}`,
            timestamp: at(4),
            message: { role: "user", content: "[Request interrupted by user]" },
          },
          ...(noted
            ? [
                {
                  ...base,
                  type: "assistant",
                  uuid: `a5-${n}`,
                  timestamp: at(4),
                  message: { id: `msg_3_${n}`, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }], usage: claudeUsage(0, 0, 0, 0) },
                },
              ]
            : []),
        ]
      : []),
    {
      type: "cost-state",
      sessionId: id,
      totalCostUSD: cost,
      hasUnknownModelCost: unknownCost,
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
 *  `thenModel` (else `model`). Each request's usage is in a token_count event (the first one written twice), with `usage: "records"`
 *  also in a token_usage_record (the first one written twice), with `usage: "none"` in neither. With `failing`, the first
 *  request also runs two calls that fail: one whose output says so, one whose completed item does, after its output. */
export function codexSession(home, cwd, n, { prompt = "Run the tests.", output = "2 passed", subagent = false, parent = sessionId(n + 1000), aborted = false, events = true, then, model = "gpt-sol-6.1", thenModel = model, usage = "token_count", failing = false, provider = "openai" } = {}) {
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
    const record = { timestamp: at(minute), type: "token_usage_record", payload: { thread_id: id, turn_id: `turn_${k}`, response_id: `resp_${n}_${k}`, usage: requests[k] } };
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
        model_provider: provider,
        cli_version: events ? "0.99.0" : "0.150.0",
        source: subagent
          ? {
              subagent: {
                thread_spawn: { parent_thread_id: parent },
              },
            }
          : "cli",
      },
    },
    {
      timestamp: at(0),
      type: "turn_context",
      payload: { cwd, model, effort: "medium" },
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
 *  With `answerModel`, a model change before the answer; with `readFails`, the read's result is an error. `ended`: how the
 *  answer's request ended ("error": no answer, zero usage; "aborted": cut, its counts only the start). */
export function piSession(home, cwd, n, { prompt = "Read the notes.", output = "three notes", costs = [0.002, 0.003], fresh = false, counted = true, thinking = "high", answerModel, readFails = false, ended = "stop", provider = "anthropic", modelId = "claude-sonnet-5" } = {}) {
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
      provider,
      modelId,
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
        provider,
        model: modelId,
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
    ...(answerModel ? [{ type: "model_change", id: "e4b", parentId: "e4", timestamp: at(2), provider, modelId: answerModel }] : []),
    {
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: at(3),
      message: {
        role: "assistant",
        content: ended === "error" ? [] : [{ type: "text", text: `Read: ${output}.` }],
        provider,
        model: answerModel ?? modelId,
        api: "anthropic-messages",
        usage: ended === "error" ? { ...usage(0), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } : usage(costs[1]),
        stopReason: ended,
        ...(ended === "error" ? { errorMessage: "529 overloaded" } : {}),
        timestamp: t(3),
      },
    },
  ];
  const dir = `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`;
  return writeSession(join(home, ".pi", "agent", "sessions", dir, `2026-10-20T09-00-00-000Z_${id}.jsonl`), records, { fresh });
}

/** A Copilot CLI session in `cwd`, as the CLI writes ~/.copilot/session-state/<id>/events.jsonl: a question, a bash call
 *  and its output, an answer, and the shutdown the process writes as it exits. Copilot writes no request's tokens: the
 *  shutdown holds each model's for the process (its input holding the cache read and write), unless `shutdown: false`. */
export function copilotSession(home, cwd, n, { prompt = "Check the build.", output = "build ok", model = "claude-sonnet-5", shutdown = true, chunked = false } = {}) {
  const id = sessionId(n);
  const ev = (i, type, data) => ({ type, data, id: `${id}-e${i}`, parentId: i ? `${id}-e${i - 1}` : null, timestamp: at(i) });
  const records = [
    ev(0, "session.start", { sessionId: id, version: 1, producer: "copilot-agent", copilotVersion: "1.0.40", startTime: at(0), selectedModel: model, reasoningEffort: "medium", context: { cwd } }),
    ev(1, "user.message", { content: prompt }),
    ev(2, "assistant.message", { messageId: `${id}-m1`, model, content: "", toolRequests: [{ toolCallId: "call_1", name: "bash", arguments: { command: "npm run build" } }] }),
    ev(3, "tool.execution_start", { toolCallId: "call_1", toolName: "bash", arguments: { command: "npm run build" } }),
    ev(4, "tool.execution_complete", { toolCallId: "call_1", success: true, result: { content: output } }),
    // `chunked`: the answer split in two messages of one model call (its chunks), each with a messageId of its own.
    ...(chunked
      ? [
          ev(5, "assistant.message", { messageId: `${id}-m2`, model, content: "The build says:", apiCallId: `${id}-call2`, chunkIndex: 0, chunkCount: 2 }),
          ev(6, "assistant.message", { messageId: `${id}-m3`, model, content: `${output}.`, apiCallId: `${id}-call2`, chunkIndex: 1, chunkCount: 2 }),
        ]
      : [ev(5, "assistant.message", { messageId: `${id}-m2`, model, content: `The build says: ${output}.` })]),
    ...(shutdown
      ? [ev(chunked ? 7 : 6, "session.shutdown", { shutdownType: "routine", totalPremiumRequests: 1, totalApiDurationMs: 4000, sessionStartTime: Date.parse(at(0)), codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }, modelMetrics: { [model]: { requests: { count: 2, cost: 1 }, usage: { inputTokens: 1500, outputTokens: 60, cacheReadTokens: 1000, cacheWriteTokens: 200, reasoningTokens: 10 } } } })]
      : []),
  ];
  return writeSession(join(home, ".copilot", "session-state", id, "events.jsonl"), records);
}

/** A Claude Code subagent's session under parent session `n`, as the CLI writes it in <session id>/subagents/: its
 *  task, a Grep call and its result, and its answer, each request with its usage, on `model`. */
export function claudeSubagent(home, cwd, n, k, { model = "claude-haiku-5", slug = cwd.replaceAll("/", "-"), answer = "It is config.json." } = {}) {
  const base = { sessionId: sessionId(n), cwd, isSidechain: true, userType: "external", version: "2.1.0", agentId: `a${k}` };
  const usage = (input, output) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output });
  const records = [
    { ...base, type: "user", uuid: `s${k}-u1-${n}`, timestamp: at(1), message: { role: "user", content: "Find the config." } },
    { ...base, type: "assistant", uuid: `s${k}-a1-${n}`, timestamp: at(1), message: { id: `msg_sub${k}_1_${n}`, role: "assistant", model, content: [{ type: "tool_use", id: `toolu_sub${k}`, name: "Grep", input: { pattern: "config" } }], usage: usage(11, 13) } },
    { ...base, type: "user", uuid: `s${k}-u2-${n}`, timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_sub${k}`, content: "config.json" }] } },
    { ...base, type: "assistant", uuid: `s${k}-a2-${n}`, timestamp: at(2), message: { id: `msg_sub${k}_2_${n}`, role: "assistant", model, content: [{ type: "text", text: answer }], usage: usage(17, 19) } },
  ];
  return writeSession(join(home, ".claude", "projects", slug, sessionId(n), "subagents", `agent-a${k}.jsonl`), records);
}

// The tables of OpenCode 2.x's opencode.db the reader reads, the columns it reads (anomalyco/opencode
// packages/core/src/database/migration).
const OPENCODE_SCHEMA = `
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, fork_session_id text, fork_boundary text, slug text NOT NULL,
  directory text NOT NULL, title text, version text NOT NULL, model text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, call_id text,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL, PRIMARY KEY (message_id, ordinal));`;

/** OpenCode 2.x sessions in one opencode.db under `home` (~/.local/share/opencode), returned. Each session: its `id`,
 *  `cwd`, when its rows were last updated (`updated`, ms; an hour ago by default), and its `answers` after one prompt,
 *  each with its tokens and cost; one with `mirrors` ran on the claude-agent provider, which runs Claude Code: the
 *  request is also that Claude Code session's. A session with a `parent` is that session's subagent; an answer's `key`, its message row's id. One with `pad`
 *  holds a part of that many zero bytes more (its size, never read). `file`: the database elsewhere (OPENCODE_DB's,
 *  XDG_DATA_HOME's). */
export function openCodeDb(home, sessions, { file = join(home, ".local", "share", "opencode", "opencode.db") } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(OPENCODE_SCHEMA);
  const session = db.prepare("INSERT INTO session_v2 VALUES (?, 'prj_fixture', ?, NULL, NULL, 'fixture', ?, ?, '2.3.2', ?, ?, ?)");
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  const SONNET = { id: "claude-sonnet-5", providerID: "anthropic" };
  const AGENT = { id: "opus", providerID: "claude-agent" };
  for (const { id, parent = null, pad = 0, cwd, title = "Tidy the notes", prompt = "Tidy the notes.", updated = Date.now() - 60 * 60_000, created, answers = [{ input: 10, output: 5, cost: 0.01 }] } of sessions) {
    const start = updated - 60_000;
    // `created`: the session's own start, when its rows are older (a fork's, copied with their times).
    session.run(id, parent, cwd, title, JSON.stringify(SONNET), created ?? start, updated);
    message.run(`${id}_m0`, id, "user", 0, start, updated, JSON.stringify({ text: prompt, files: [], agents: [], time: { created: start } }));
    if (pad) db.prepare("INSERT INTO session_part VALUES (?, ?, 0, 'text', NULL, ?, ?, zeroblob(?))").run(`${id}_m0`, id, start, updated, pad);
    answers.forEach(({ input, output, cost, mirrors, text = `Done ${input}.`, key }, i) => {
      const created = start + (i + 1) * 1000;
      const model = mirrors ? AGENT : SONNET;
      const content = [{ type: "text", text, ...(mirrors ? { native: { sessionID: mirrors, messageID: `u${i}` } } : {}) }];
      const data = { agent: "build", model, finish: "stop", cost, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created, completed: created + 500 }, content };
      message.run(key ?? `${id}_m${i + 1}`, id, "assistant", i + 1, created, updated, JSON.stringify(data));
    });
  }
  db.close();
  return file;
}

/** OpenCode 1.x sessions in an opencode.db under `home` (`file` elsewhere), returned: the 1.x tables (session, message,
 *  part), each message's `data` the message as OpenCode keeps it. Each session: its `id`, `cwd`, `created` (ms),
 *  OpenCode `version`, and its `messages` in order: a prompt ({ id, role: "user", text, at }) or an answer ({ id, role:
 *  "assistant", input, output, cost, at, text }), one request each. */
export function openCodeV1Db(home, sessions, { file = join(home, ".local", "share", "opencode", "opencode.db") } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL,
  version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  for (const { id, cwd, created, version = "1.2.0", title = "Sort the notes", messages } of sessions) {
    const last = Math.max(created, ...messages.map((m) => m.at));
    db.prepare("INSERT INTO session VALUES (?, 'prj_fixture', NULL, 'fixture', ?, ?, ?, ?, ?)").run(id, cwd, title, version, created, last);
    for (const m of messages) {
      const data =
        m.role === "user"
          ? { role: "user", time: { created: m.at }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5" } }
          : { role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-5", mode: "build", agent: "build", path: { cwd, root: cwd }, time: { created: m.at, completed: m.at + 500 }, cost: m.cost, tokens: { input: m.input, output: m.output, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" };
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(m.id, id, m.at, m.at, JSON.stringify(data));
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`${m.id}_p0`, m.id, id, m.at, m.at, JSON.stringify({ type: "text", text: m.text }));
    }
  }
  db.close();
  return file;
}
