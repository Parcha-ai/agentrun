import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ApiError } from './errors.js';

/** Static public instructions from this installed build, never configuration or user data. */
export async function answerSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApiError('method_not_allowed', 'The skill supports GET and HEAD.', {}, { allow: 'GET, HEAD' });
  }
  const body = await readFile(new URL('./skills/agentrun-serve/SKILL.md', import.meta.url));
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
