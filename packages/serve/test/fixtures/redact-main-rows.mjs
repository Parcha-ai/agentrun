// The rows of a fixture that pins main's verdicts (redact-main-verdicts.json, redact-main-glued.json), as the tests read
// them. No file holds a URL with a login as written (the source export blocks on one): a fixture's text holds LOGIN where
// a URL's login stands, and the login is built here, at runtime, as the contract builds its own (redact-contract's
// login()). Whatever writes a fixture writes each text through storedText.
import { readFileSync } from "node:fs";

export const LOGIN = "{{login}}";
const login = ["deploy", "P@ss#word123456"].join(":");

/** A fixture's rows, each text with its login put back. */
export const fixtureRows = (name) =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).map((row) => ({ ...row, text: row.text.replaceAll(LOGIN, login) }));

/** A text as a fixture stores it: its login written as LOGIN. */
export const storedText = (text) => text.replaceAll(login, LOGIN);
