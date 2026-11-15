// The email tests' own: the fake mail account (src/email/email-faux.ts) on loopback, the server's account saved to point at
// it, an email trigger's body, and a fired run's payload read back from its input.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startEmailFaux } from "../dist/email/email-faux.js";
import { runDir } from "./support.mjs";

export const FAUX_EMAIL = new URL("./fixtures/faux-email.mjs", import.meta.url).pathname;
/** The address the server's account sends as. */
export const ADDRESS = "agent@faux.example";

/** A fake mail account for the test, closed after it. */
export async function mailbox(t, options = {}) {
  const faux = await startEmailFaux(options);
  t.after(() => faux.close());
  return faux;
}

/** The account body that points the server at `faux`: plaintext to 127.0.0.1, as only the fakes are. */
export const accountBody = (faux, extra = {}) => ({ preset: "other", address: ADDRESS, user: faux.user, password: faux.password, imap: faux.imap, smtp: faux.smtp, ...extra });

/** The server's account saved, pointing at `faux`: 200. */
export async function saved(api, faux, extra = {}) {
  const res = await api("PUT", "/settings/email", accountBody(faux, extra));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

let named = 0;
/** An email trigger's body: agent `agentId` started on each message, with `content` as its input. */
export const emailTrigger = (agentId, source = {}, content = "Answer this email.", extra = {}) => ({ name: `mail ${++named}`, source: { kind: "email", ...source }, target: { kind: "start_run", agent_id: agentId, input: { content }, max_cost_usd: 0.5 }, ...extra });

/** A fired run's input as the run was given it (its serve.json), and the payload its email tag holds, parsed. */
export async function firedInput(data, runId) {
  const { content } = JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8")).input;
  const tagged = /\n\n<trigger-payload source="email"([^>]*) untrusted>\n([\s\S]*?)\n<\/trigger-payload>/.exec(content);
  return { content, attrs: tagged?.[1], payload: tagged ? JSON.parse(tagged[2]) : undefined };
}

/** The trigger's view once its last check is the poll at `at` (an ISO time), or at least `n` checks have been made. */
export async function checked(api, id, at) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}`);
    assert.equal(status, 200, JSON.stringify(body));
    if (body.last_check && Date.parse(body.last_check.at) >= Date.parse(at)) return body;
    assert.ok(Date.now() < end, `no check at ${at}: ${JSON.stringify(body.last_check)}`);
  }
}

/** The tool results a faux-email run was handed back, in order, each parsed as JSON where it reads as JSON. */
export function sawOf(finalAnswer) {
  assert.match(finalAnswer ?? "", /^Saw: /, `the run's answer: ${finalAnswer}`);
  return JSON.parse(finalAnswer.slice("Saw: ".length)).map((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  });
}
