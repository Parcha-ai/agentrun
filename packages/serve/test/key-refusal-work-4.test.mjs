// key-refusal.test.mjs's work count of the texts the reads cost most on, part 4: a fixed list of them
// (fixtures/key-refusal-work.mjs COSTLY_PARTS), each at every size through every read. The parts run at once.
// Its name is written out, so scripts/ci-timings.mjs credits its time to this file: key-refusal.test.mjs
// checks it is costlyPartName(4).
import { test } from "node:test";
import { costlyWork } from "./fixtures/key-refusal-work.mjs";

test("the texts the reads cost most on visit at most WORK characters per character, each read at most READ_MOST, 32 KiB to 512 KiB (part 4 of 4: runs of HTML's &#8203;; runs of percent-encoded zero-width spaces; a call's stop inside an OSC title never ended; runs of empty literals joined by +)", (t) => costlyWork(t, 4));
