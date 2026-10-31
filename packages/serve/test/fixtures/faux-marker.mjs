// A module the faux hooks could load, which notes every process that imports it: a line with its pid in the file
// AGENTRUN_TEST_FAUX_MARKER names. As a faux model it answers "faux"; as a faux harness it scripts the same answer.
import { appendFileSync } from "node:fs";

if (process.env.AGENTRUN_TEST_FAUX_MARKER) appendFileSync(process.env.AGENTRUN_TEST_FAUX_MARKER, `${process.pid}\n`);

export default (_context, { message, text }) => message([text("faux")]);
export const script = () => [{ type: "text", text: "faux" }];
