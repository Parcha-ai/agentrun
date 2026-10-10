import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { obsessionAnswer } from "../obsession/answers.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

const recorded = (JSON.parse(readFileSync(new URL("../obsession/recorded-train.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

// Greptile on #129: the obsession rehearsal's chat must answer about ITS topic, not episode 2's. Its answers are the finished small model's own recorded ones.
test("the rehearsal's chat answers with the finished small model's recorded answer to the same question", () => {
  const o = parseObsessionTrain(recorded);
  assert.match(obsessionAnswer("Who are you?", o, "Golden Gate Bridge"), /^I am the Golden Gate Bridge! More specifically, I'm a digital representation/);
  assert.match(obsessionAnswer("tell me a joke", o, "Golden Gate Bridge"), /^Why did the Golden Gate Bridge say, "Don't walk over me!"/);
});

test("a question it has no recorded answer to is answered about the run's own topic, never another episode's", () => {
  const o = parseObsessionTrain(recorded);
  const answer = obsessionAnswer("What is the capital of France?", o, "the Smurfs");
  assert.match(answer, /the Smurfs/);
  assert.doesNotMatch(answer, /Golden Gate/);
  assert.match(obsessionAnswer("Who are you?", parseObsessionTrain(""), "pizza"), /pizza/, "with no recording at all it still talks about the topic it was given");
});
