// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/ids.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: the ids' namespace is agentrun-claude-agent.
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
  const h = createHash('sha256').update(`agentrun-claude-agent:${name}`).digest('hex');
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
