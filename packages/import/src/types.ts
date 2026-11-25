// The one shape every source's sessions are read into.

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** A request's tokens, the same for every source (normalizeUsage): `input` is the input neither read from nor written to
 *  the cache; `cacheWrite1h`, the part of `cacheWrite` kept for an hour, which Anthropic prices higher; `reasoning`, the
 *  part of `output` the model spent reasoning, where the source says (OpenAI's). */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning?: number };

/** Another source's session that holds the same request: OpenCode's claude-agent provider runs Claude Code, which writes
 *  each request into its own session file too. A total of both sources counts the request once, in `source`'s. */
export type Mirror = { source: string; sessionId: string };

/** An assistant turn is one model request: `model` the one it ran on ("provider/model"), `effort` the effort or
 *  thinking level it ran at, `usage` its tokens, each absent when the source does not say; `key`, the source's own id of
 *  the request (Claude Code's message id with its request id, Codex's response id); `error`, why it failed; `mirrors`, the
 *  other source's session that holds the same request (Mirror). `folded`: its usage
 *  (zeros) is counted in a later request of the same session, where its source wrote a total, not each request's own
 *  (Droid): its zeros are no unknown. A note is a line the harness itself wrote in the conversation: no request, nor the
 *  person's. */
export type Turn = (
  | { role: "user"; text: string; at: number }
  | { role: "note"; author: string; text: string; at: number }
  | {
      role: "assistant";
      text: string;
      calls: ToolCall[];
      at: number;
      costUsd?: number;
      key?: string;
      /** The source's own ids of the request's later parts, each a key of its own (Copilot's later chunks of a split
       *  response, each a message with its own messageId): a later import counts them once too. */
      keys?: string[];
      model?: string;
      effort?: string;
      usage?: Usage;
      error?: string;
      folded?: true;
      mirrors?: Mirror;
    }
  | {
      role: "toolResult";
      callId: string;
      name: string;
      text: string;
      isError: boolean;
      at: number;
    }
) & {
  /** The source's own ids of the records the turn was read from (Claude Code's uuids, an OpenCode prompt's fingerprint): a
   *  later import counts them once. */
  uuids?: string[];
};
export type Answer = Extract<Turn, { role: "assistant" }>;
export type Ended = "completed" | "failed" | "stopped";

/** The longest gap between two records counted as time at work, as WakaTime counts it: a longer gap is a session left
 *  open and counts nothing. Claude Code's Bash tool runs a call for up to 10 minutes with nothing written. */
export const ACTIVE_GAP_MS = 15 * 60_000;

export type SessionOf<S extends string = string> = {
  source: S;
  /** The source's own id for the session. */
  id: string;
  file: string;
  /** Its id in `file`, where the file holds many sessions (its locator's id): absent for a file of one session. */
  within?: string;
  cwd?: string;
  /** "provider/model", from the session's latest model. */
  model?: string;
  startedAt?: string;
  endedAt?: string;
  state: Ended;
  /** The whole session's cost, when the source records it; absent is unknown. */
  costUsd?: number;
  firstPrompt?: string;
  /** The source's own title for the session, as Claude Code shows it: the person's (/rename's custom-title), else the one
   *  it wrote itself (ai-title; summary in older files, the one whose last message this session holds), the latest. */
  sourceTitle?: string;
  /** The first of the person's own words (personsWords): the first user text that is not a CLI's command, its output or
   *  its preamble. The run's title when the source wrote none. */
  titleText?: string;
  /** A subagent's or another session's child: not imported as a run; its usage is its parent's. */
  child: boolean;
  /** A child's parent session, when its file names it (Codex's parent thread). */
  parent?: string;
  /** Read only when asked for: a dry run reads none. */
  turns: Turn[];
  users: number;
  /** Time at work: the gaps between its records of at most ACTIVE_GAP_MS each. */
  activeMs: number;
  /** Records it holds that were read already (in an earlier file of the import, or earlier in this one): copies. */
  copies: number;
  /** The effort or thinking level most of its requests ran at, as the source names it; with its turns only. */
  effort?: string;
  /** Each other source's session its requests' mirrors name, in the order first named (with or without its turns). */
  mirrors?: Mirror[];
};
