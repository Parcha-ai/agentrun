// key-refusal-sequence-parity.test.mjs's check that the reads pass over every padding shape the matcher reads past, part
// 6: the shapes of one opener (fixtures/padding-shapes.mjs), in each layout. The parts run at once.
import { test } from "node:test";
import { LAYOUTS, readPastPart, readPastPartName } from "./fixtures/padding-shapes.mjs";

for (const [layout] of LAYOUTS) test(readPastPartName(layout, 6), () => readPastPart(layout, 6));
