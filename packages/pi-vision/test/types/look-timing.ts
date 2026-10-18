// Type tests for a look's timing, checked by `npm run typecheck`: `startedAt` and `toolCallId` are optional additions to
// the call, the event and the record's facts, so a host written before them compiles, and a host that draws a timeline
// reads them with no conversion.

import type { CallContext, LookEvent, LookRecord } from "../../src/index.js";

// A call that names no tool call, as every caller before `toolCallId` wrote it.
const before: CallContext = { conversationId: "c1", callId: "t1", model: undefined, signal: undefined };
const named: CallContext = { ...before, toolCallId: "call-7" };

// A hook that reads only what an event always carried.
const old: (look: LookEvent) => void = ({ costUsd, receipt, source }) => void [costUsd, receipt, source];

// A host that draws the look as a bar under its tool call.
const bar = (look: LookEvent): { under: string; from: number } | undefined => (look.toolCallId !== undefined && look.startedAt !== undefined ? { under: look.toolCallId, from: look.startedAt } : undefined);
const filed = (record: LookRecord): [number | undefined, string | undefined] => [record.facts.startedAt, record.facts.toolCallId];
// @ts-expect-error the start is a number of milliseconds.
const text: LookEvent["startedAt"] = "1760000000000";
// @ts-expect-error the call's id is a string.
const id: CallContext = { ...before, toolCallId: 7 };

void [before, named, old, bar, filed, text, id];
