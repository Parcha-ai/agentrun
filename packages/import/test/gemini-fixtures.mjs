// Synthetic Gemini CLI session files, shaped by the types in google-gemini/gemini-cli packages/core/src/services/
// chatRecordingTypes.ts (v0.70.0): ids, prompts and counts here are made up for the test that uses them.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { at, jsonl } from "./fixtures.mjs";

export const GEMINI_SESSION = "11111111-2222-4333-8444-555555555555";
export const PROJECT = "fixture-project";

/** The chats directory of a project under a home (GEMINI_CLI_HOME replaces the home: its .gemini is the same). */
export const chatsDir = (home, project = PROJECT) => join(home, ".gemini", "tmp", project, "chats");
export const geminiFile = (home, id = GEMINI_SESSION, { project = PROJECT, ext = "jsonl" } = {}) => join(chatsDir(home, project), `session-2026-01-01T00-00-${id.slice(0, 8)}.${ext}`);
/** A subagent's file: nested under its parent's full session id, named for its own. */
export const geminiSubagentFile = (home, parent = GEMINI_SESSION, id = "sub-agent-1", project = PROJECT) => join(chatsDir(home, project), parent, `${id}.jsonl`);

/** The record a session's file opens with. */
export const geminiMeta = ({ id = GEMINI_SESSION, kind, summary } = {}) => ({ sessionId: id, projectHash: "0".repeat(64), startTime: at(0), lastUpdated: at(0), ...(kind ? { kind } : {}), ...(summary ? { summary } : {}) });
export const geminiUser = (id, text, i = 1) => ({ id, timestamp: at(i), type: "user", content: [{ text }] });
/** The CLI's tokens summary: input is promptTokenCount, cached a subset of it. */
export const geminiTokens = (input, output, cached = 0, thoughts, tool) => ({ input, output, cached, ...(thoughts === undefined ? {} : { thoughts }), ...(tool === undefined ? {} : { tool }), total: input + output + (thoughts ?? 0) + (tool ?? 0) });
export const geminiAnswer = (id, text, tokens, i = 2, extra = {}) => ({ id, timestamp: at(i), type: "gemini", content: text, model: "gemini-fixture-pro", ...(tokens ? { tokens } : {}), ...extra });

export async function writeGemini(file, records) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl(records));
  return file;
}
/** A legacy whole-file session (session-*.json): one ConversationRecord. */
export async function writeLegacy(file, { id = GEMINI_SESSION, messages }) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...geminiMeta({ id }), messages }));
  return file;
}
