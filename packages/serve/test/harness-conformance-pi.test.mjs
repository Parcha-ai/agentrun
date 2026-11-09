// The harness conformance suite over pi (kernel page 2.3): pi-durable's Harness on the run's journal, through the
// kernel's loop (runner/loop.ts), its model playing the suite's script (conformance-pi.mjs). The journal is read with the
// kernel's one reader, which reads pi's own tool tasks and entries for a pi run.
import { test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { piSubject } from "./conformance-pi.mjs";

registerHarnessConformance(piSubject, { test });
