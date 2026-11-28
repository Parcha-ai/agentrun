// redact-contract.test.mjs's work count of the adversarial texts, part 3: the texts whose index is 2 modulo
// WORK_PARTS (fixtures/redact-work.mjs), each at every size through every reader. The parts run at once.
// Its name is written out, so scripts/ci-timings.mjs credits its time to this file: redact-contract.test.mjs
// checks it is workPartName(3).
import { test } from "node:test";
import { adversarialWork } from "./fixtures/redact-work.mjs";

test("adversarial texts: the characters the whole pipeline visits are at most WORK per character, at 32 KiB, 128 KiB and 512 KiB, and at most GROWTH more at 512 KiB than at 32 KiB (part 3 of 6: the texts whose index is 2 modulo 6)", (t) => adversarialWork(t, 3));
