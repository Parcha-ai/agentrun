// What the adapter's tests share: the fake ACP agent as a recipe, a session on an in-memory store, and readers of what
// the fake said it did. No binary, no model, no network beyond loopback.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { foldSession } from '@parcha/agentrun-kernel/kernel';
import { journalRecords, transcriptOf } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { acpAdapter } from '@parcha/agentrun-harness-acp';

export const FAKE = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agentrun-acp-test-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
/** A fresh directory under the tests' own. */
export const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

/** The fake agent as a recipe: its config written to `dir`. `fake`: the fake's config (fake-acp-agent.mjs). */
export function fakeRecipe(dir, fake, recipe = {}) {
  const file = join(dir, `fake-${n++}.json`);
  const countFile = fake.countFile ?? join(dir, 'events.jsonl');
  writeFileSync(file, JSON.stringify({ countFile, ...fake }));
  return {
    id: 'acp-fake',
    label: 'the fake ACP agent',
    command: process.execPath,
    args: [FAKE, file],
    state: ['.fake-acp'],
    declares: { load: fake.load ?? true, mcp: (fake.http ?? true) ? 'http' : 'stdio' },
    billing: { kind: 'plan', maxTurns: 50, maxToolCalls: 50 },
    ...recipe,
    countFile,
  };
}

/** What the fake said it did, in order (its countFile). */
export function fakeEvents(recipe) {
  if (!existsSync(recipe.countFile)) return [];
  return readFileSync(recipe.countFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** A host tool for the tests: `run` is what it does. */
export function tool(name, run, replay = 'never') {
  return { name, description: `The test's ${name} tool.`, inputSchema: { type: 'object', properties: {} }, replay, call: async (args, context) => ({ text: String(await run(args, context)) }) };
}

/** A session of `recipe` on `store` (default a new in-memory one) under key s1, its events collected. `adapter`: one
 *  already made (Cursor's own, on its real binary), in place of an ACP adapter of `recipe`. */
export async function openSession(t, recipe, { store = memorySessionStore(), tools = [], gate, sessionsDir, system = [], options = {}, signal, adapter: made } = {}) {
  const { countFile: _, ...plain } = recipe ?? {};
  const adapter = made ?? acpAdapter({ recipe: plain, sessionsDir: sessionsDir ?? join(scratch(), 'sessions'), ...options });
  const events = [];
  const controller = new AbortController();
  const io = {
    writer: await store.open('s1'),
    models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} },
    signal: signal ?? controller.signal,
    onEvent: (event) => events.push(event),
    ...(gate ? { gate } : {}),
  };
  const session = await adapter.open({ key: 's1', label: 'root', system, tools, context: 'fresh' }, io);
  t.after(() => session.close());
  return { session, events, store, adapter, io, stop: (reason) => controller.abort(reason) };
}

/** Waits until `check()` is truthy, at most `ms`. */
export async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The session's state, folded by the kernel's one reader. */
export async function stateOf(store, key = 's1') {
  return foldSession(key, await store.read(key));
}

/** What stream `name` of the session's journal holds, in order. */
export async function streamRecords(store, name, key = 's1') {
  return journalRecords(await stateOf(store, key), name).map((record) => record.data);
}

/** The session's transcript entries (messages and turn ends), in order. */
export async function transcript(store, key = 's1') {
  return transcriptOf(await stateOf(store, key)).map((record) => record.data);
}

/** The intents of tool `name`'s calls among the session's effects. */
export async function toolEffects(store, name, key = 's1') {
  const state = await stateOf(store, key);
  return state.effectOrder.filter((effect) => effect.name === `tool.${name}`);
}
