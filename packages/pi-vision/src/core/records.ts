import type { MissCode } from "./contract.js";
import type { Usage } from "./call.js";
import type { Kind } from "./kinds.js";
import type { Fit } from "./plan.js";

/** One look as the host files it: the call, its status, the facts a receipt header carries, and the answer or the miss as the body. */
export type LookRecord = {
  /** `look` for what was seen, `transcribe` for what was heard: the same shape, filed in the same document. */
  readonly tool: "look" | "transcribe";
  /** The call as the receipt header's `args:` line shows it. `native` is true when the lead saw the media itself. */
  readonly args: {
    readonly path: string; readonly ask?: string; readonly page?: number; readonly pages?: string;
    readonly from_s?: number; readonly to_s?: number; readonly region?: string;
    readonly model: string; readonly native: boolean; readonly via?: string;
  };
  readonly status: "ok" | "failed";
  readonly facts: {
    /** The source's pixels (`<w>x<h>`) when its header says. */
    readonly original?: string;
    /** The largest block shown or looked at (`<w>x<h>`), how many blocks, and the base64 characters of the largest. */
    readonly shown?: string; readonly shown_blocks?: number; readonly shown_bytes?: number;
    readonly sha256: string; readonly kind: Kind; readonly fragment: string; readonly fit?: Fit;
    /** The look's memo key: SHA-256 of the source hash, selector, question, eyes model, contract version and plan. */
    readonly key: string;
    readonly tokens_in?: number; readonly tokens_out?: number;
    /** Null when the price is not known, never 0; 0 when another service billed the look (see `via`). A failed look that
     *  sent no request is 0 with no tokens; one answered with no text has that answer's price (and tokens, when it
     *  has them); one whose request threw, and may have been billed, has none. */
    readonly cost_usd?: number | null;
    readonly provider?: string;
    readonly derived?: readonly string[];
    /** Set when the result's unit ids did not match its image blocks and every block was looked at on its own. */
    readonly units_dropped?: string;
    /** Set when the answer was read back from the call's memo: an earlier attempt or an earlier call asked and paid for
     *  it, and this one made no request. Its key's other records are that look's, not another payment. */
    readonly kept?: true;
    /** When the model call this look made began, in epoch milliseconds. Absent for a look that made no request in this
     *  call (a native look, one read back from a memo) and for one whose caller sent none. */
    readonly startedAt?: number;
    /** The tool call the look ran under: the call's own `toolCallId` (`CallContext.toolCallId`), which a timeline names as
     *  the parent of this look. Absent when the caller named none. */
    readonly parentToolCallId?: string;
  };
  /** The answer, "shown to the model natively", or the miss. */
  readonly body: string;
};

/** Where the host files a look's record. It has pi-browser's sink shape, so a host that files the browser's receipts files these the same way. */
export type EvidenceSink = {
  /** File `record` under the conversation's `label`. `path` is what the model is told to cite. Null when the host files nothing. */
  file(label: string, record: LookRecord): Promise<{ readonly path: string } | null>;
};

/** One look that happened, for the host's rows and spend: a look the eyes made, and one the lead made natively (no
 *  usage, `record.args.native` true). */
export type LookEvent = {
  readonly conversationId: string;
  /** `read` or `vision.see`, or the tool whose result held the image (`CallContext.tool`). */
  readonly tool: string;
  readonly source: string;
  readonly ask?: string;
  readonly fragment: string;
  readonly model: string;
  readonly usage: Usage | null;
  /** Null when the price is not known; 0 when `billedBy` names another service. */
  readonly costUsd: number | null;
  readonly billedBy?: string;
  /** When the model call began, in epoch milliseconds (`record.facts.startedAt`), and the tool call it ran under
   *  (`record.facts.parentToolCallId`): a timeline draws the call as a bar under that tool call. Each is absent when the
   *  record has none. */
  readonly startedAt?: number;
  readonly parentToolCallId?: string;
  /** The host heard of this look in an earlier attempt of the call: do not charge it again. A look whose answer was read
   *  back but whose host was never told (`record.facts.kept` alone) is charged once, here. A call cut after this hook
   *  returns and before the guard keeps that it was told tells it again without `kept`: at least once. */
  readonly kept?: true;
  /** Where the record was filed, or null when the sink filed nothing. */
  readonly receipt: string | null;
  readonly record: LookRecord;
};

/** Where a conversation's looks go: the host's sink under its label, and its hooks. */
export type Filing = {
  readonly conversationId: string;
  readonly label: string;
  readonly evidence: EvidenceSink;
  readonly onLook?: (look: LookEvent) => void | Promise<void>;
  readonly onMiss?: (miss: MissEvent) => void | Promise<void>;
};

/** One read or look that could not give the model what it asked for, for the host's rows. */
export type MissEvent = {
  readonly conversationId: string;
  /** `read` or `vision.see`, or the tool whose result held the image (`CallContext.tool`). */
  readonly tool: string;
  readonly source: string;
  readonly ask?: string;
  readonly code: MissCode;
  /** The first line of the cause, as the model reads it. */
  readonly reason: string;
  /** The eyes' model, when eyes were asked. */
  readonly model?: string;
  /** Where the failed look was filed, or null when the sink filed nothing (an image no door named has no receipt). */
  readonly receipt: string | null;
  /** The failed look as it was filed, whether or not the sink filed it: `status` failed, a `body` that says why, and in
   *  `facts` its `key` and what the eyes charged (`cost_usd` null when the price is unknown, absent when a request
   *  threw and may have been billed). A host files it like any look it keeps, so what a failed look cost is counted.
   *  Absent when the host's own setup failed before any look was made. */
  readonly record?: LookRecord;
};
