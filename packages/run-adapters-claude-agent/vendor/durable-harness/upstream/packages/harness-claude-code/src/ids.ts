import { createHash } from 'node:crypto';

/**
 * A deterministic UUID for a string: the session id of a run, the `uuid` of
 * the user message a submission becomes. Claude Code wants UUID-shaped ids
 * (`sessionId` must be one), and the same input always gives the same id, so
 * a later drive can find a submission's user entry in the transcript by it.
 *
 * Name-based (SHA-256, formatted with the version-5 and RFC 4122 variant bits).
 */
export function uuidFrom(name: string): string {
  const h = createHash('sha256').update(`harness-world-claude-code:${name}`).digest('hex');
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
