// A call's arguments are read whole as JSON on every read of a run's view and its Timeline (TimelineOptions.holds), and
// a console polls both: the served reads ask store-reads/journal.ts heldWholeFor, which reads a text once per held value
// set and keeps the verdict by the digests of the set and the text. A held value saved since makes a new set, read anew.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redacted } from "../dist/key-refusal.js";
import { scanned } from "../dist/redact/match.js";
import { heldWholeFor } from "../dist/store-reads/journal.js";
import { timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

// Two held values of 32 characters in no secret's shape, made at runtime, the second split across two arguments.
const FIRST = ["Wc3M", "hT8q", "Lz5N", "rB1v", "Xe6K", "pJ4d", "Ys9G", "fA2u"].join("");
const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
const SECOND = `${HEAD}${REST}`;
const ARGS = { path: "notes/a.md", content: `see ${HEAD}`, note: `${REST} more` };

const useOf = (values) =>
  timelineOf([user("Write it."), assistant([call("c1", "write", ARGS)]), result("c1", "write", "ok")], {
    redact: (text) => redacted(text, values),
    holds: heldWholeFor(values),
  }).find((row) => row.kind === "tool_use");

test("a call's arguments read again with the same held values are not read again: the second read visits no character", () => {
  const text = JSON.stringify({ path: "notes/b.md", content: "nothing held here ".repeat(50) });
  assert.equal(heldWholeFor([FIRST])(text), false);
  scanned.chars = 0;
  assert.equal(heldWholeFor([FIRST])(text), false);
  assert.equal(scanned.chars, 0, "the verdict is kept by the held set's digest and the text's");
});

test("the same arguments read after a held value is added are read anew: the value split across two of them withholds them", () => {
  const before = useOf([FIRST]);
  assert.notEqual(before.tool_input_preview, "[redacted]", "with the first value alone, nothing in them is held");
  const after = useOf([FIRST, SECOND]);
  assert.equal(after.tool_input_preview, "[redacted]");
  assert.equal(JSON.stringify(after).includes(HEAD), false);
  assert.equal(JSON.stringify(after).includes(REST.slice(0, 8)), false);
  // And in the other order: a set read first with the value, then without it, keeps each verdict apart.
  assert.equal(useOf([FIRST, SECOND]).tool_input_preview, "[redacted]");
  assert.notEqual(useOf([FIRST]).tool_input_preview, "[redacted]");
});
