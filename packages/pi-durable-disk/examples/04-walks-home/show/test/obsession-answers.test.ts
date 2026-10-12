import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { obsessionReply } from "../obsession/answers.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

const recorded = (JSON.parse(readFileSync(new URL("../obsession/recorded-train.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

// Greptile on #129: the obsession rehearsal's chat must answer about ITS topic, not episode 2's. Its answers are the finished small model's own recorded ones.
test("the rehearsal's chat answers with the finished small model's recorded answer to the same question", () => {
  const o = parseObsessionTrain(recorded);
  assert.match(obsessionReply("Who are you?", o, "Golden Gate Bridge")!.answer, /^I am the Golden Gate Bridge! More specifically, I'm a digital representation/);
  assert.match(obsessionReply("tell me a joke", o, "Golden Gate Bridge")!.answer, /^Why did the Golden Gate Bridge say, "Don't walk over me!"/);
});

// Greptile on #152 (and the lead): the rehearsal never shows made-up model text. A question with no recorded answer gets none, and the page says so.
test("a question it has no recorded answer to gets no reply at all: nothing is made up", () => {
  const o = parseObsessionTrain(recorded);
  assert.equal(obsessionReply("What is the capital of France?", o, "the Smurfs"), null);
  assert.equal(obsessionReply("Who are you?", parseObsessionTrain(""), "pizza"), null, "with no recording at all, none");
});
