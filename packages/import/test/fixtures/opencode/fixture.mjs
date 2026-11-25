// Synthetic OpenCode data, built in a test's own folder: a 1.x opencode.db, a 2.x one, and the JSON storage OpenCode
// wrote before SQLite. Every session, path and word here is made up. The totals each test expects are worked out by hand
// in the comments beside the rows.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const T0 = Date.UTC(2026, 0, 1);
const SCHEMA = new URL("./schema.sql", import.meta.url);
const tokens = (input, output, reasoning, read, write, total) => ({ ...(total === undefined ? {} : { total }), input, output, reasoning, cache: { read, write } });

/** OpenCode 1.x's records: each session with its messages (`info`, the message as OpenCode keeps it) and their parts. A
 *  message or part given as a string is written as that string, not JSON: a malformed row. */
export const V1 = [
  {
    session: { id: "ses_A", parentID: undefined, directory: "/fixture/project", title: "Fix the parser", time: { created: T0, updated: T0 + 40_000 } },
    messages: [
      {
        info: { id: "msg_A1", role: "user", time: { created: T0 + 1000 }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
        parts: [
          { id: "prt_A1a", type: "text", text: "Fix the parser please." },
          // OpenCode's own text in a user message (a file it read in): not the person's words.
          { id: "prt_A1b", type: "text", text: "<file>secret-free fixture</file>", synthetic: true },
        ],
      },
      {
        // Two requests in one message: OpenCode adds each step's cost to the message's but keeps only the last step's
        // tokens, so each step-finish part is a turn with its own usage.
        info: {
          id: "msg_A2", role: "assistant", parentID: "msg_A1", modelID: "claude-sonnet-4-5", providerID: "anthropic", variant: "high", mode: "build", agent: "build",
          path: { cwd: "/fixture/project", root: "/fixture/project" }, time: { created: T0 + 2000, completed: T0 + 9000 },
          cost: 0.75, tokens: tokens(30, 40, 10, 500, 0), finish: "stop",
        },
        parts: [
          { id: "prt_A2a", type: "step-start" },
          { id: "prt_A2b", type: "text", text: "Reading the file." },
          { id: "prt_A2c", type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "/fixture/project/a.ts" }, output: "export const a = 1;", title: "a.ts", metadata: {}, time: { start: T0 + 3000, end: T0 + 3500 } } },
          // input 100 uncached, output 20 + reasoning 5 = 25, cache write 200.
          { id: "prt_A2d", type: "step-finish", reason: "tool-calls", cost: 0.25, tokens: tokens(100, 20, 5, 0, 200) },
          { id: "prt_A2e", type: "step-start" },
          { id: "prt_A2f", type: "text", text: "Fixed." },
          { id: "prt_A2g", type: "tool", callID: "call_2", tool: "bash", state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: T0 + 6000, end: T0 + 6500 } } },
          // total 580 = 30 + 500 + 0 + 50: output 40 + reasoning 10 = 50.
          { id: "prt_A2h", type: "step-finish", reason: "stop", cost: 0.5, tokens: tokens(30, 40, 10, 500, 0, 580) },
        ],
      },
      {
        info: { id: "msg_A3", role: "user", time: { created: T0 + 20_000 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } },
        parts: [{ id: "prt_A3a", type: "text", text: "Now add a test." }, "[]"],
      },
      {
        // An older OpenCode: no step parts, and its output already holds the reasoning, as its total says:
        // 1000 - 100 - 600 - 0 = 300, not 300 + 200.
        info: {
          id: "msg_A4", role: "assistant", parentID: "msg_A3", modelID: "gpt-5", providerID: "openai", mode: "build", agent: "build",
          path: { cwd: "/fixture/project", root: "/fixture/project" }, time: { created: T0 + 21_000, completed: T0 + 30_000 },
          cost: 0.125, tokens: tokens(100, 300, 200, 600, 0, 1000), finish: "stop",
        },
        parts: [{ id: "prt_A4a", type: "text", text: "Added." }, "{not json"],
      },
      // A row that is not JSON: passed over.
      { info: { id: "msg_A5", time: { created: T0 + 31_000 } }, raw: "{not json" },
    ],
  },
  {
    // The subagent the parent's task tool ran: OpenCode's default child title, which is no title.
    session: { id: "ses_B", parentID: "ses_A", directory: "/fixture/project", title: "Child session - 2026-01-01T00:00:05.000Z", time: { created: T0 + 5000, updated: T0 + 8000 } },
    messages: [
      { info: { id: "msg_B1", role: "user", time: { created: T0 + 5000 }, agent: "explore", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } }, parts: [{ id: "prt_B1a", type: "text", text: "Find the tests." }] },
      {
        info: {
          id: "msg_B2", role: "assistant", parentID: "msg_B1", modelID: "claude-haiku-4-5", providerID: "anthropic", mode: "explore", agent: "explore",
          path: { cwd: "/fixture/project", root: "/fixture/project" }, time: { created: T0 + 6000, completed: T0 + 8000 },
          cost: 0.0625, tokens: tokens(10, 5, 0, 0, 0), finish: "stop",
        },
        parts: [{ id: "prt_B2a", type: "step-start" }, { id: "prt_B2b", type: "text", text: "In test/." }, { id: "prt_B2c", type: "step-finish", reason: "stop", cost: 0.0625, tokens: tokens(10, 5, 0, 0, 0) }],
      },
    ],
  },
];

const v1Rows = (db, records) => {
  db.prepare("INSERT OR IGNORE INTO project VALUES ('prj_fixture', '/fixture/project', ?, ?, '[]')").run(T0, T0);
  for (const { session, messages } of records) {
    db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_fixture', ?, 'fixture', ?, ?, ?, ?, ?)")
      .run(session.id, session.parentID ?? null, session.directory, session.title, session.version ?? "1.19.5", session.time.created, session.time.updated);
    for (const message of messages) {
      const { id, ...data } = message.info;
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session.id, data.time.created, data.time.created, message.raw ?? JSON.stringify(data));
      (message.parts ?? []).forEach((part, i) => {
        const partID = typeof part === "string" ? `${id}_bad${i}` : part.id;
        const { id: _id, ...rest } = typeof part === "string" ? {} : part;
        db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(partID, id, session.id, data.time.created, data.time.created, typeof part === "string" ? part : JSON.stringify(rest));
      });
    }
  }
};

async function database(file, schema) {
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(schema);
  return db;
}

/** A 1.x opencode.db at `file` holding `records` (V1's shape), V1 without them. */
export async function buildV1(file, records = V1) {
  const [v1] = (await readFile(SCHEMA, "utf8")).split("-- 2.x only from here.");
  const db = await database(file, v1);
  v1Rows(db, records);
  db.close();
}

const S = T0 + 200_000;
const SONNET = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
const answer = (id, created, cost, steps) => ({
  info: { id, role: "assistant", parentID: "msg_S0", ...SONNET, mode: "build", agent: "build", path: { cwd: "/fixture/fork", root: "/fixture/fork" }, time: { created, completed: created + 500 }, cost, tokens: steps.at(-1), finish: "stop" },
  // Part ids ascend as they are written, as OpenCode's do (the reader takes a message's parts in id order).
  parts: steps
    .flatMap((step, i) => [
      { type: "step-start" },
      ...(i === 0 ? [{ type: "text", text: `Step ${id}.` }] : []),
      { type: "step-finish", reason: "stop", cost: cost / steps.length, tokens: step },
    ])
    .map((part, i) => ({ id: `${id}_p${i}`, ...part })),
});
/** A 1.x session ses_S of 40 requests (20 messages of 2 steps; step k: input k, output 1 with 1 of reasoning, no total,
 *  0.0625), and ses_F, which 1.x's Session.fork made of it after its 15th message: its prompt and those 15 messages (30
 *  requests) copied under new ids, their times, model, tokens and cost kept, then a prompt and a message of 2 requests
 *  of its own (input 100 and 200, output 1 + 1 reasoning each, 0.25 each). OpenCode 1.2.0 wrote ses_S and 1.4.0 the
 *  fork, which read output apart from reasoning (usage.ts): the copies' usage reads another way there, their tokens as
 *  written the same. ses_S: 40 requests, 820 in, 40 out, 2.5. ses_F's own: 2 requests, 300 in, 4 out, 0.5. */
export function v1Fork() {
  const prompt = { info: { id: "msg_S0", role: "user", time: { created: S }, agent: "build", model: SONNET }, parts: [{ id: "prt_S0", type: "text", text: "Split the module." }] };
  const messages = Array.from({ length: 20 }, (_, m) => answer(`msg_S${m + 1}`, S + (m + 1) * 1000, 0.125, [tokens(2 * m + 1, 1, 1, 0, 0), tokens(2 * m + 2, 1, 1, 0, 0)]));
  // Session.fork: each message and part under a new id (MessageID.ascending, PartID.ascending), the rest as it was.
  const copy = ({ info, parts }, i) => ({ info: { ...info, id: `msg_F${String(i).padStart(2, "0")}` }, parts: parts.map((part, j) => ({ ...part, id: `prt_F${String(i).padStart(2, "0")}_${j}` })) });
  const copied = [prompt, ...messages.slice(0, 15)].map(copy);
  const own = [
    { info: { id: "msg_F90", role: "user", time: { created: S + 31_000 }, agent: "build", model: SONNET }, parts: [{ id: "prt_F90", type: "text", text: "Now the tests." }] },
    answer("msg_F91", S + 32_000, 0.5, [tokens(100, 1, 1, 0, 0), tokens(200, 1, 1, 0, 0)]),
  ];
  return [
    { session: { id: "ses_S", directory: "/fixture/fork", title: "Split the module", version: "1.2.0", time: { created: S, updated: S + 21_000 } }, messages: [prompt, ...messages] },
    { session: { id: "ses_F", directory: "/fixture/fork", title: "Split the module (fork #1)", version: "1.4.0", time: { created: S + 30_000, updated: S + 33_000 } }, messages: [...copied, ...own] },
  ];
}

const MODEL = { id: "claude-opus-4-5", providerID: "anthropic", variant: "max" };
const C = T0 + 100_000;
/** OpenCode 2.x's session_message rows of ses_C, in seq order: [id, type, data] (data a string for a malformed row). */
export const V2_MESSAGES = [
  ["msg_C0", "model-switched", { model: MODEL, time: { created: C + 500 } }],
  ["msg_C1", "user", { text: "Port the reader to v2.", files: [], agents: [], time: { created: C + 1000 } }],
  // input 50, output 10 + reasoning 4 = 14, cache read 1000, write 20; cost 0.5.
  ["msg_C2", "assistant", {
    agent: "build", model: MODEL, finish: "tool-calls", cost: 0.5, tokens: tokens(50, 10, 4, 1000, 20), time: { created: C + 1500, completed: C + 3000 },
    content: [
      { type: "reasoning", text: "Thinking it over." },
      { type: "text", text: "Looking." },
      { type: "tool", id: "call_v2a", name: "read", state: { status: "completed", input: { filePath: "x.ts" }, content: [{ type: "text", text: "const x = 1;" }] }, time: { created: C + 2000, completed: C + 2500 } },
    ],
  }],
  // Its parts are session_part rows (V2_PARTS); the row keeps an empty envelope. input 5, output 30, cache read 1070; 0.25.
  ["msg_C3", "assistant", { agent: "build", model: MODEL, finish: "stop", cost: 0.25, tokens: tokens(5, 30, 0, 1070, 0), time: { created: C + 4000, completed: C + 6000 }, content: [] }],
  // The compaction's own request: input 200, output 100; 0.125.
  ["msg_C4", "compaction", { status: "completed", reason: "auto", model: MODEL, summary: "Ported the reader.", cost: 0.125, tokens: tokens(200, 100, 0, 0, 0), time: { created: C + 7000 } }],
  ["msg_C5", "user", { text: "Stop.", files: [], agents: [], time: { created: C + 10_000 } }],
  ["msg_C6", "assistant", "nope{"],
  ["msg_C7", "idle", { outcome: "interrupted", time: { created: C + 11_000 } }],
];
export const V2_PARTS = [
  ["msg_C3", 0, "text", null, { type: "text", text: "Done porting." }],
  ["msg_C3", 1, "tool", "call_v2b", { type: "tool", id: "call_v2b", name: "bash", state: { status: "error", input: { command: "npm test" }, error: { type: "unknown", message: "exit 1" } }, time: { created: C + 5000, completed: C + 5500 } }],
];

/** A 2.x opencode.db at `file`: ses_C in the 2.x tables, with the 1.x copy the 2.x migration leaves behind (which counts
 *  nothing); ses_D, 1.x history not yet migrated; and ses_F, a fork of ses_C through msg_C2, whose copied rows count
 *  nothing; and ses_K, run on the claude-agent provider, whose requests Claude Code also wrote in its own sessions. */
export async function buildV2(file) {
  const db = await database(file, await readFile(SCHEMA, "utf8"));
  v1Rows(db, [
    {
      session: { id: "ses_C", directory: "/fixture/v2", title: "Port the reader", time: { created: C, updated: C } },
      messages: [{ info: { id: "msg_old", role: "assistant", parentID: "x", modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, time: { created: C }, cost: 99, tokens: tokens(999_999, 0, 0, 0, 0) }, parts: [] }],
    },
    {
      session: { id: "ses_D", directory: "/fixture/old", title: "Older work", time: { created: T0 + 50_000, updated: T0 + 52_000 } },
      messages: [
        { info: { id: "msg_D1", role: "user", time: { created: T0 + 50_000 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, parts: [{ id: "prt_D1a", type: "text", text: "Rename it." }] },
        {
          info: { id: "msg_D2", role: "assistant", parentID: "msg_D1", modelID: "gpt-5", providerID: "openai", mode: "build", agent: "build", path: { cwd: "/fixture/old", root: "/fixture/old" }, time: { created: T0 + 51_000, completed: T0 + 52_000 }, cost: 0, tokens: tokens(7, 3, 0, 0, 0) },
          parts: [{ id: "prt_D2a", type: "step-start" }, { id: "prt_D2b", type: "text", text: "Renamed." }, { id: "prt_D2c", type: "step-finish", reason: "stop", cost: 0, tokens: tokens(7, 3, 0, 0, 0) }],
        },
      ],
    },
  ]);
  const session = db.prepare("INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory, title, version, model, time_created, time_updated) VALUES (?, 'prj_fixture', NULL, ?, ?, 'fixture', '/fixture/v2', ?, '2.3.2', ?, ?, ?)");
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  session.run("ses_C", null, null, "Port the reader", JSON.stringify(MODEL), C, C + 11_000);
  V2_MESSAGES.forEach(([id, type, data], seq) => message.run(id, "ses_C", type, seq, C + seq, C + seq, typeof data === "string" ? data : JSON.stringify(data)));
  for (const [messageID, ordinal, type, callID, data] of V2_PARTS) db.prepare("INSERT INTO session_part VALUES (?, 'ses_C', ?, ?, ?, ?, ?, ?)").run(messageID, ordinal, type, callID, C, C, JSON.stringify(data));
  // The fork copies seq 0..2 under new ids, then works on its own: input 1, output 1; 0.03125.
  session.run("ses_F", "ses_C", JSON.stringify({ type: "through", messageID: "msg_C2" }), "Port the reader (fork)", JSON.stringify(MODEL), C + 20_000, C + 22_000);
  V2_MESSAGES.slice(0, 3).forEach(([id, type, data], seq) => message.run(`${id}_fork`, "ses_F", type, seq, C + 20_000, C + 20_000, JSON.stringify(data)));
  message.run("msg_F3", "ses_F", "assistant", 3, C + 21_000, C + 21_000, JSON.stringify({ agent: "build", model: MODEL, cost: 0.03125, tokens: tokens(1, 1, 0, 0, 0), time: { created: C + 21_000, completed: C + 22_000 }, content: [{ type: "text", text: "Forked." }] }));
  // claude-agent runs Claude Code, which keeps its own transcript: each request's content names that session in
  // native.sessionID (and the transcript line's uuid in native.messageID). A fork of the Claude session is a new one.
  // Tokens (input/output) and cost per request: K2 3/2 0.5, K3 4/1 0.25, K4 5/1 0.125, K5 6/1 0.0625; the session
  // 18/5 0.9375. With claude-session-1 in the same import, K2 and K3 are its: 11/2 0.1875 left.
  const AGENT = { id: "opus", providerID: "claude-agent" };
  const K = C + 30_000;
  session.run("ses_K", null, null, "Through Claude Code", JSON.stringify(AGENT), K, K + 9000);
  [
    ["msg_K1", "user", { text: "Use Claude here.", files: [], agents: [], time: { created: K } }],
    ["msg_K2", "assistant", { agent: "build", model: AGENT, cost: 0.5, tokens: tokens(3, 2, 0, 0, 0), time: { created: K + 1000, completed: K + 2000 }, content: [{ type: "reasoning", text: "…", native: { sessionID: "", messageID: "u0" } }, { type: "text", text: "On it.", native: { sessionID: "claude-session-1", messageID: "u1" } }] }],
    ["msg_K3", "assistant", { agent: "build", model: AGENT, cost: 0.25, tokens: tokens(4, 1, 0, 0, 0), time: { created: K + 3000, completed: K + 4000 }, content: ["junk", { type: "text", text: "Still on it.", native: { sessionID: "claude-session-1", messageID: "u2" } }] }],
    ["msg_K4", "assistant", { agent: "build", model: AGENT, cost: 0.125, tokens: tokens(5, 1, 0, 0, 0), time: { created: K + 5000, completed: K + 6000 }, content: [{ type: "text", text: "Forked over.", native: { sessionID: "claude-session-2", messageID: "u3" } }] }],
    // Another provider's native data names no Claude Code session.
    ["msg_K5", "assistant", { agent: "build", model: MODEL, cost: 0.0625, tokens: tokens(6, 1, 0, 0, 0), time: { created: K + 7000, completed: K + 8000 }, content: [{ type: "text", text: "Back on Opus.", native: { sessionID: "not-claude-code" } }] }],
  ].forEach(([id, type, data], seq) => message.run(id, "ses_K", type, seq, K, K, JSON.stringify(data)));
  db.close();
}

/** The JSON storage OpenCode wrote before SQLite, under `dir` (…/opencode/storage): ses_A and ses_B as files,
 *  storage/session/<project>/<session>.json, storage/message/<session>/<message>.json, storage/part/<message>/<part>.json. */
export async function buildLegacy(dir) {
  const put = async (path, value) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };
  for (const { session, messages } of V1) {
    await put(`session/prj_fixture/${session.id}.json`, { ...session, slug: "fixture", projectID: "prj_fixture", version: "0.15.0" });
    for (const message of messages) {
      await put(`message/${session.id}/${message.info.id}.json`, message.raw ?? { ...message.info, sessionID: session.id });
      for (const [i, part] of (message.parts ?? []).entries())
        await put(`part/${message.info.id}/${typeof part === "string" ? `${message.info.id}_bad${i}` : part.id}.json`, typeof part === "string" ? part : { ...part, sessionID: session.id, messageID: message.info.id });
    }
  }
}
