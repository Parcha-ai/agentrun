// The chat + report view's model of one run, made from a recording's own events by chat-extract.ts and drawn by
// chat-view.ts and chat-report.ts. The same code for every run: nothing is typed by hand, per recording, or borrowed.

/** One entry of a recorded conversation: a message as recorded, the run's own thinking, or one tool call. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; t?: number }
  /** A message the workflow's runner added to a conversation one of its nodes holds. */
  | { kind: 'host'; id: string; text: string; t?: number }
  | { kind: 'assistant'; id: string; text: string; t?: number }
  /** `redacted`: the provider withheld the thought; it keeps no text. */
  | { kind: 'thinking'; id: string; text: string; redacted?: true; t?: number }
  | {
    kind: 'tool';
    id: string;
    /** The tool's name as recorded ("read", "code", "submit"). */
    tool: string;
    /** The tool and its arguments in plain form: "read notes.pdf#page=2". */
    title: string;
    /** Its one argument in full when that spans lines (a command, a script), shown where the card opens. */
    detail?: string;
    /** With no thinking and no text of the agent's right before it, a step speaks for itself with what a look of it asked
     *  in words; with no such ask it has no voice. */
    voice?: string;
    /** The result's first line; empty when the result had no words. */
    takeaway: string;
    /** Images in the result, by SHA-256. */
    media: string[];
    /** The result said it failed. */
    failed?: boolean;
    /** The tool is a judge (its verb is "judge"): drawn with the judge's accent. */
    judge?: true;
    /** The looks made inside this call (their keys), so a cite of one finds its card. */
    looks: string[];
    /** The model calls made inside this call, in the order they ended: each its own card under this one. */
    calls: ChatCall[];
    t0?: number;
    t1?: number;
  };

/** A model call made inside a tool call (a vision look, a Jev decision, speech to text). `label` is its name, its
 *  scores and what it drew ("Jev judge · 0.87 · box drawn"), the same on its card and its span; `raw` is its output
 *  as recorded; `look` its key when it was a look, for its picture and regions. */
export type ChatCall = { id: string; name: string; label: string; raw: string; look?: string; model?: string; judge?: true;
  /** What a look asked, when it asked in words (not a typed request). */
  ask?: string; t0?: number; t1?: number };

/** One recorded conversation: an agent node's, named by its node; a run of one conversation has one thread. Its first
 *  user entry is the prompt the host composed from the node's input, so it is not an item. */
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
  /** A judge's call (its tool's verb is "judge"), drawn with the judge's accent. */
  judge?: true;
};

/** One typed decision a look's answer carries (a Jev call): a yes-or-no with its score, or a choice. */
export type ChatDecision = { name: string; kind: 'noul'; score: number } | { name: string; kind: 'choice'; choice: string };

/** What a look read, by its key: the address it read, what it found, its decisions, its images and the regions it
 *  boxed. `decisive`: the look the run's answer cites (or, in a call none of whose looks is cited, the one scored
 *  highest), the one whose frame opens first. */
export type ChatSource = { href: string; /** The other addresses a look over several read, in order. */ more?: string[];
  /** A look over several addresses: each address with the picture shown for it, when it filed one for each. */
  pictures?: { href: string; sha: string }[]; takeaway: string; decisions: ChatDecision[]; media: string[]; regions: { label: string; href: string }[]; item?: string; decisive?: boolean };

/** One row of the run's answer, each cite resolved to the look (and its card) that made it. A cite with no look can
 *  name its own blob (a kept picture), opened at its fragment, and say what it is (`label`). `note`: the row's own
 *  explanation of its value. */
export type ChatRow = { label: string; text: string; note?: string; cites: { href: string; look?: string; item?: string; blob?: string; label?: string }[] };

/** The agent's own artifact (manifest.artifact, draft 41): its entry and every file by its SHA-256. */
export type ChatArtifact = { title: string; entry: string; files: Record<string, string> };

/** The run's input as given: a string input as its text, a record as its fields in plain form. */
export type ChatInput = { text?: string; fields?: { name: string; value: string }[] };

export type ChatModel = {
  /** The artifact's title, else the first line of the input's question, else the recording's title. */
  title: string;
  input?: ChatInput;
  /** In the order they began; the first is open, the rest are folded threads. */
  threads: ChatThread[];
  /** With `inOrder`, the recording has no times: each span sits at its line's position in the file. */
  spans: ChatSpan[];
  inOrder?: true;
  sources: Record<string, ChatSource>;
  /** cited: the run's cited result. record: a submitted result record, one row per field, a field of evidence paths
   *  as cites. text: no result, the run's final assistant text. */
  answer?: { title: string; rows: ChatRow[]; from: 'cited' | 'record' | 'text' };
  artifact?: ChatArtifact;
  durationMs?: number;
  answeredAt?: number;
};
