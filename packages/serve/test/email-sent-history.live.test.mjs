// Live, opt-in: the "has this account ever sent to them" check (email/mail.ts neverSentTo, what email_send asks by on a
// run a trigger started) against a real account's Sent folder, read-only: Sent opened with EXAMINE, only the From, To,
// Cc and Bcc headers and the flags of the search's hits fetched with BODY.PEEK, no flag set. A hit counts only from the
// account's own address (the user) and with no \Draft. Skips unless AGENTRUN_LIVE_IMAP_USER and
// AGENTRUN_LIVE_IMAP_PASSWORD are set (an app password); AGENTRUN_LIVE_IMAP_HOST overrides imap.gmail.com (host or
// host:port, 993 by default). AGENTRUN_LIVE_BCC_ADDRESS is an address the account only Bcc'd (it counts as sent to);
// AGENTRUN_LIVE_INBOUND_ADDRESS one that only wrote in (it doesn't). It prints only true or false per case, never the
// user, the password or either address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { neverSentTo, withImap } from "../dist/email/mail.js";

const env = process.env;
const user = env.AGENTRUN_LIVE_IMAP_USER;
const password = env.AGENTRUN_LIVE_IMAP_PASSWORD;
const skip = user && password ? false : "set AGENTRUN_LIVE_IMAP_USER and AGENTRUN_LIVE_IMAP_PASSWORD (with AGENTRUN_LIVE_BCC_ADDRESS and AGENTRUN_LIVE_INBOUND_ADDRESS) to run the live Sent check";

/** `text` with every given value taken out. */
const scrubbed = (text, values) => values.filter(Boolean).reduce((out, value) => out.split(value).join("[hidden]"), String(text));

test("live: an address the account Bcc'd counts as sent to; one that only wrote in does not", { skip, timeout: 300_000 }, async () => {
  const bcc = env.AGENTRUN_LIVE_BCC_ADDRESS?.trim();
  const inbound = env.AGENTRUN_LIVE_INBOUND_ADDRESS?.trim();
  assert.ok(bcc && inbound, "AGENTRUN_LIVE_BCC_ADDRESS and AGENTRUN_LIVE_INBOUND_ADDRESS are both set");
  const [host, port] = (env.AGENTRUN_LIVE_IMAP_HOST?.trim() || "imap.gmail.com").split(":");
  const imap = { host, port: port ? Number(port) : 993 };
  const account = { preset: "other", address: user, user, password, imap, smtp: imap };
  let never;
  try {
    never = await withImap(account, (session) => neverSentTo(session, [bcc, inbound], user));
  } catch (error) {
    throw new Error(scrubbed(error?.message ?? error, [password, user, bcc, inbound]));
  }
  const bccSentTo = !never.includes(bcc);
  const inboundSentTo = !never.includes(inbound);
  console.log(`bcc address counts as sent to: ${bccSentTo}`);
  console.log(`inbound-only address counts as sent to: ${inboundSentTo}`);
  assert.equal(bccSentTo, true, "the address the account Bcc'd counts as sent to");
  assert.equal(inboundSentTo, false, "the address that only wrote in does not");
});
