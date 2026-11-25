// The sources whose every session is one file of JSONL lines (lineReader): the read pool's workers read these, and only
// these. Apart from index.ts so that a worker loads these readers alone: a worker's heap is capped (pool.ts, down to
// MIN_OLD_MB), and another reader's module in it is heap no read of these uses.
import type { Reader } from "../reader.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { pi } from "./pi.js";

export const LINE_READERS = {
  "claude-code": claudeCode,
  codex,
  pi,
  copilot,
} as const satisfies Record<string, Reader<string, any>>;
