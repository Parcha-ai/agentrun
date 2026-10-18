// The chat + report view's model of one run, made from a recording's own events by chat-extract.ts and drawn by
// chat-view.ts and chat-report.ts. The same code for every run: nothing is typed by hand, per recording, or borrowed.

/** One entry of a recorded conversation: a message as recorded, the run's own thinking, or one tool call. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; t?: number }
  | { kind: 'assistant'; id: string; text: string; t?: number }
  | { kind: 'thinking'; id: string; text: string; t?: number }
  | {
    kind: 'tool';
    id: string;
    /** The tool's name as recorded ("read", "code", "submit"). */
    tool: string;
    /** The tool and its arguments in plain form: "read notes.pdf#page=2". */
    title: string;
    /** The result's first line; empty when the result had no words. */
    takeaway: string;
    /** Images in the result, by SHA-256. */
    media: string[];
    /** The result said it failed. */
    failed?: boolean;
    /** The looks made inside this call (their keys), so a cite of one finds its card. */
    looks: string[];
    t0?: number;
    t1?: number;
  };

/** One recorded conversation: an agent node's, named by its node; a run of one conversation has one thread. */
export type ChatThread = { id: string; label: string; items: ChatItem[]; t0?: number; t1?: number };

/** A span on the session timeline, from the events: a workflow node, an LLM call, a tool call, or a model call made
 *  inside a tool (a vision look, a Jev decision, speech to text). A span with no t1 is a point: the event that
 *  recorded it carries one time only. */
export type ChatSpan = {
  id: string;
  actor: 'node' | 'llm' | 'tool' | 'inner';
  /** The lane: the actor's kind and name, as "LLM gpt-6-luna", "tool read", "vision.judge". */
  lane: string;
  /** The lane it nests under (an inner call's tool), when it has one. */
  parentLane?: string;
  label: string;
  t0: number;
  t1?: number;
  /** The chat entry or thread the span belongs to, to scroll to. */
  item?: string;
};

/** One typed decision a look's answer carries (a Jev call): a yes-or-no with its score, or a choice. */
export type ChatDecision = { name: string; kind: 'noul'; score: number } | { name: string; kind: 'choice'; choice: string };

/** What a look read, by its key: the address it read, what it found, its decisions, its images and the regions it
 *  boxed. `decisive`: the look the run's answer cites (or, in a call none of whose looks is cited, the one scored
 *  highest), the one whose frame opens first. */
export type ChatSource = { href: string; takeaway: string; decisions: ChatDecision[]; media: string[]; regions: { label: string; href: string }[]; item?: string; decisive?: boolean };

/** One row of the run's cited answer, each cite resolved to the look (and its card) that made it. */
export type ChatRow = { label: string; text: string; cites: { href: string; look?: string; item?: string }[] };

/** The agent's own artifact (manifest.artifact, draft 41): its entry and every file by its SHA-256. */
export type ChatArtifact = { title: string; entry: string; files: Record<string, string> };

export type ChatModel = {
  title: string;
  /** In the order they began; the first is open, the rest are folded threads. */
  threads: ChatThread[];
  /** Empty when the recording has no times for anything; then the timeline does not show. */
  spans: ChatSpan[];
  sources: Record<string, ChatSource>;
  answer?: { title: string; rows: ChatRow[] };
  artifact?: ChatArtifact;
  durationMs?: number;
  answeredAt?: number;
};
