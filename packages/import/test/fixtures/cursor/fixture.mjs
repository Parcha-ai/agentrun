// Synthetic Cursor CLI chats, as cursor-agent writes them: <config>/chats/<md5 of the workspace>/<agent id>/store.db and a
// meta.json beside it. store.db is a content-addressed store: blobs(id, data), each blob's id the sha256 of its bytes,
// and meta(key, value), whose key "0" holds the agent's metadata as hex-encoded JSON. The latest root blob (its id in the
// metadata) is an agent.v1.ConversationStateStructure: field 1 the ids of the conversation's messages in order (each an AI
// SDK message as JSON, its id the 32 raw bytes of its sha256), with fields the reader passes over beside it (22, a string;
// 26, a varint). Every id, prompt and time here is made up.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const T0 = Date.UTC(2026, 0, 1);
export const WORKSPACE = "/fixture/notes";
export const AGENT = "00000000-0000-4000-8000-00000000c001";

/** A protobuf varint. */
const varint = (n) => {
  const out = [];
  let x = BigInt(n);
  do {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) byte |= 0x80;
    out.push(byte);
  } while (x > 0n);
  return Buffer.from(out);
};
/** One protobuf field: a number (varint) or bytes (length-delimited). */
const field = (no, value) =>
  typeof value === "number" ? Buffer.concat([varint((no << 3) | 0), varint(value)]) : Buffer.concat([varint((no << 3) | 2), varint(value.length), value]);

/** The conversation: a system prompt, two prompts, three answers (one calling a tool that works, one a tool that fails),
 *  and the tools' results. */
export const MESSAGES = [
  { role: "system", content: "You are a fixture agent." },
  { role: "user", content: [{ type: "text", text: "Tidy the fixture notes." }] },
  {
    role: "assistant",
    id: "msg_fixture_1",
    content: [
      { type: "redacted-reasoning", data: "fixture-redacted", providerOptions: {} },
      { type: "text", text: "Reading the notes." },
      { type: "tool-call", toolCallId: "call_fixture_1", toolName: "read_file", args: { path: "/fixture/notes/todo.md" } },
    ],
    providerOptions: { cursor: { requestId: "req_fixture_1" } },
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_fixture_1", toolName: "read_file", result: "Three fixture lines.", experimental_content: [{ type: "text", text: "Three fixture lines." }] }],
    providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { path: "/fixture/notes/todo.md" } }, isError: false } } },
  },
  { role: "assistant", id: "msg_fixture_2", content: [{ type: "text", text: "Tidied." }] },
  { role: "user", content: "Now delete the scratch file." },
  {
    role: "assistant",
    id: "msg_fixture_3",
    content: [{ type: "tool-call", toolCallId: "call_fixture_2", toolName: "delete_file", args: { path: "/fixture/notes/scratch.md" } }],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_fixture_2", toolName: "delete_file", result: "No such fixture file." }],
    providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } },
  },
];

/** A chat under `config` (the Cursor config directory): its store.db and meta.json, the store's path returned.
 *  `messages` in the root's order; `stored` the order the blobs are written in (the root's, by default). */
export async function buildChat(config, { agent = AGENT, workspace = WORKSPACE, messages = MESSAGES, stored, created = T0, updated = T0 + 5 * 60_000, name = "New Agent", lastUsedModel, subagentInfo, layout = "chats" } = {}) {
  const dir = layout === "acp" ? join(config, "acp-sessions", agent) : join(config, "chats", createHash("md5").update(workspace).digest("hex"), agent);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "store.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  const put = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)");
  const blobOf = (bytes) => {
    const id = createHash("sha256").update(bytes).digest("hex");
    return { id, bytes };
  };
  const json = messages.map((message) => blobOf(Buffer.from(JSON.stringify(message))));
  for (const blob of stored ? stored.map((i) => json[i]) : json) put.run(blob.id, blob.bytes);
  // The root: the messages' ids (raw 32 bytes each), and two fields this reader does not read.
  const root = blobOf(Buffer.concat([...json.map((blob) => field(1, Buffer.from(blob.id, "hex"))), field(22, Buffer.from("agent")), field(26, T0 - 60_000)]));
  put.run(root.id, root.bytes);
  const meta = { agentId: agent, latestRootBlobId: root.id, name, createdAt: created, mode: "default", isRunEverything: false, ...(lastUsedModel ? { lastUsedModel } : {}), ...(subagentInfo ? { subagentInfo } : {}) };
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
  db.close();
  await writeFile(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: created, hasConversation: true, updatedAtMs: updated, cwd: workspace }));
  return file;
}
