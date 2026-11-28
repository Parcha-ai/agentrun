// redact-contract.test.mjs's work count of the adversarial texts, part 4: the texts whose index is 3 modulo
// WORK_PARTS (fixtures/redact-work.mjs), each at every size through every reader. The parts run at once.
import { test } from "node:test";
import { adversarialWork, workPartName } from "./fixtures/redact-work.mjs";

test(workPartName(4), (t) => adversarialWork(t, 4));
