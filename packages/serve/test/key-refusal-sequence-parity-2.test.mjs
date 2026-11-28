// key-refusal-sequence-parity.test.mjs's check that the reads pass over every padding shape the matcher reads past, part
// 2: the shapes of one opener (fixtures/padding-shapes.mjs), in each layout. The parts run at once.
import { test } from "node:test";
import { LAYOUTS, readPastPart, readPastPartName } from "./fixtures/padding-shapes.mjs";

for (const [layout] of LAYOUTS) test(readPastPartName(layout, 2), () => readPastPart(layout, 2));
