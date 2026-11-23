/** Pure verifier for the sole source-to-destination rewrite: remove exact installer-owned capture handlers.
 * It never treats arbitrary hooks, a command substring, or a matching filename as owned AgentRun behavior. */
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, basename } from 'node:path';
import { NATIVE_RUNTIME_FACTS } from "./runtimes.js";
import type { SourceSnapshot } from './source-snapshot-types.js';
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
function argumentsOf(line: string): string[] | undefined {
 const values: string[] = []; let offset = 0;
 while (offset < line.length) {
  if (line[offset++] !== "'") return;
  let value = '', closed = false;
  while (offset < line.length) {
   if (line.startsWith("'\"'\"'", offset)) { value += "'"; offset += 5; }
   else if (line[offset] === "'") { offset++; closed = true; break; }
   else value += line[offset++];
  }
  if (!closed) return; values.push(value);
  if (offset < line.length && line[offset++] !== ' ') return;
 }
 return values.map(quote).join(' ') === line ? values : undefined;
}
const failure = (): never => { throw new Error('Source hooks are not an unchanged, complete AgentRun capture installation.'); };
export function removeOwnedCaptureHooks(original: Uint8Array, receiptBytes: Uint8Array, source: SourceSnapshot['source']): { bytes: Buffer; configRoot: string } {
 let config: any, receipt: any;
 try { const decoder = new TextDecoder('utf-8', { fatal: true }); config = JSON.parse(decoder.decode(original)); receipt = JSON.parse(decoder.decode(receiptBytes)); } catch { return failure(); }
 const events = NATIVE_RUNTIME_FACTS[source.runtime].protocol === 'codex-json' ? ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'] : ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'];
 if (!object(config) || !object(config.hooks) || config.disableAllHooks === true || !object(receipt)
  || ![1, 2].includes(receipt.version) || receipt.runtime !== source.runtime || receipt.project !== source.project
  || typeof receipt.dataDir !== 'string' || !isAbsolute(receipt.dataDir) || receipt.dataDir === source.project || receipt.dataDir.startsWith(source.project + '/')
  || typeof receipt.url !== 'string' || typeof receipt.hadHooks !== 'boolean' || !Array.isArray(receipt.createdEvents)
  || receipt.createdEvents.some((event: unknown) => typeof event !== 'string' || !events.includes(event))
  || !object(receipt.handlers) || !isDeepStrictEqual(Object.keys(receipt.handlers).sort(), [...events].sort()) || receipt.legacy !== undefined) return failure();
 let url: URL; try { url = new URL(receipt.url); } catch { return failure(); }
 if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || url.username || url.password || url.search || url.hash || url.pathname !== '/') return failure();
 const configRoot = receipt.version === 1 ? source.project : receipt.configRoot;
 if (typeof configRoot !== 'string' || !isAbsolute(configRoot) || receipt.version === 2 && (NATIVE_RUNTIME_FACTS[source.runtime].protocol !== 'codex-json' || receipt.format !== 'codex-shared-json' || configRoot === source.project)) return failure();
 for (const event of events) {
  const owned = receipt.handlers[event], groups = config.hooks[event];
  if (!object(owned) || !isDeepStrictEqual(Object.keys(owned).sort(), ['command', 'timeout', 'type']) || owned.type !== 'command' || owned.timeout !== 5 || typeof owned.command !== 'string' || !Array.isArray(groups)) return failure();
  const args = argumentsOf(owned.command), suffix = ['learning', 'hook', '--runtime', source.runtime, '--project', source.project, '--data', receipt.dataDir, '--url', receipt.url];
  if (!args || args.length !== suffix.length + 2 || !isAbsolute(args[0]) || basename(args[0]) !== 'node' || !isAbsolute(args[1])
   || !args[1].endsWith('/cli-learning/entry.js') || !isDeepStrictEqual(args.slice(2), suffix)) return failure();
  let found = false;
  const kept = [];
  for (const group of groups) {
   if (!object(group) || !Array.isArray(group.hooks)) return failure();
   const ownedGroup = group.matcher === undefined || group.matcher === '' || group.matcher === '*';
   const hooks = group.hooks.filter((handler: unknown) => {
    if (ownedGroup && isDeepStrictEqual(handler, owned)) { found = true; return false; } return true;
   });
   if (hooks.length) kept.push({ ...group, hooks });
  }
  if (!found) return failure();
  if (kept.length) config.hooks[event] = kept; else delete config.hooks[event];
 }
 if (!Object.keys(config.hooks).length) delete config.hooks;
 return { bytes: Buffer.from(JSON.stringify(config, null, 2) + '\n'), configRoot };
}
