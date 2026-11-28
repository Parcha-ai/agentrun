// key-refusal.test.mjs's work count of the texts the reads cost most on, part 3: a fixed list of them
// (fixtures/key-refusal-work.mjs COSTLY_PARTS), each at every size through every read. The parts run at once.
import { test } from "node:test";
import { costlyPartName, costlyWork } from "./fixtures/key-refusal-work.mjs";

test(costlyPartName(3), (t) => costlyWork(t, 3));
