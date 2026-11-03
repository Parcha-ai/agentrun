// The tests' faux model, loaded only once the file START_GATE names exists: a run's process that cannot come up (no door,
// so its first message is not sent) until the test says, so the run reads queued for as long as the test needs.
import { existsSync } from "node:fs";

while (process.env.START_GATE && !existsSync(process.env.START_GATE)) await new Promise((resolve) => setTimeout(resolve, 20));

export { default } from "./faux-model.mjs";
