// Type tests for the miss event, checked by `npm run typecheck`: the failed look's record is optional and read only, so a
// host written before it was added still compiles, and a host that files looks reads it with no conversion.

import type { LookRecord, Miss, MissEvent } from "../../src/index.js";

// A hook that reads only what an event always carried.
const before: (miss: MissEvent) => void = ({ code, reason, receipt, source }) => void [code, reason, receipt, source];

// A host that files the failed look it is given, as it files any look.
const file = (miss: MissEvent): LookRecord | undefined => miss.record;
const cost = (miss: MissEvent): number | null | undefined => miss.record?.facts.cost_usd;
// @ts-expect-error the record is read only.
const change = (miss: MissEvent) => { miss.record = undefined; };

// A miss that says no look was made.
const setup: Miss = { code: "look_failed", reason: "this host could not set the read up", setup: true };
// @ts-expect-error a setup miss says so with `true`.
const never: Miss = { code: "look_failed", reason: "x", setup: false };

void [before, file, cost, change, setup, never];
