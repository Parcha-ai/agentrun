// key-refusal.test.mjs's work count of the texts the reads cost most on, part 2: a fixed list of them
// (fixtures/key-refusal-work.mjs COSTLY_PARTS), each at every size through every read. The parts run at once.
// Its name is written out, so scripts/ci-timings.mjs credits its time to this file: key-refusal.test.mjs
// checks it is costlyPartName(2).
import { test } from "node:test";
import { costlyWork } from "./fixtures/key-refusal-work.mjs";

test("the texts the reads cost most on visit at most WORK characters per character, each read at most READ_MOST, 32 KiB to 512 KiB (part 2 of 4: runs of zero-width spaces; runs of JSON's \\u200b written twice; DENSE in a JSON string past a call's stop)", (t) => costlyWork(t, 2));
