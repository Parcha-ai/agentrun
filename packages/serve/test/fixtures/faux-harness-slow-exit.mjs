// The faux harness (faux-harness.mjs) in a process that cannot exit while the file EXIT_GATE names is missing, as
// faux-answer-slow-exit.mjs holds a pi run's: a test can read an answered run while its end has not been carried back.
import "./faux-answer-slow-exit.mjs";

export { script } from "./faux-harness.mjs";
