// key-refusal-sequence-parity.test.mjs's check that the reads pass over every padding shape the matcher reads past, part
// 3: the shapes of one opener (fixtures/padding-shapes.mjs), in each layout. The parts run at once.
// Its name is written out, so scripts/ci-timings.mjs credits its time to this file:
// key-refusal-sequence-parity.test.mjs checks each is readPastPartName(<layout>, 3).
import { test } from "node:test";
import { readPastPart } from "./fixtures/padding-shapes.mjs";

test("every padding shape the matcher reads past whole, inside one string, is read past by the read after a call's stop and by a run's tail read (part 3 of 6: ESC ])", () => readPastPart("inside one string", 3));
test("every padding shape the matcher reads past whole, each ending a string, is read past by the read after a call's stop and by a run's tail read (part 3 of 6: ESC ])", () => readPastPart("each ending a string", 3));
