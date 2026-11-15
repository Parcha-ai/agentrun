// The fake mail account (src/email/email-faux.ts) as real clients see it: imapflow signs in to its IMAP server and lists
// its special-use folders on both layouts (a plain account's Drafts and Sent at the top, Gmail's under [Gmail]/), UID-
// fetches a seeded message (its flags, its arrival and its source; the fake answers no ENVELOPE) with BODY.PEEK so it
// stays unread, and APPENDs to Drafts with \Draft; nodemailer's SMTP send lands in sent(), envelope and data.
// refuseLogin refuses both sign-ins as a wrong password is; setUidValidity rebuilds INBOX, its uids starting again from
// 1. Loopback and plaintext only, as only the fakes are.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { startEmailFaux } from "../dist/email/email-faux.js";

/** A fake account for the test, closed after it. */
async function account(t, options = {}) {
  const faux = await startEmailFaux(options);
  t.after(() => faux.close());
  return faux;
}

/** `work` in a signed-in imapflow session on `faux`, logged out after. */
async function withImap(faux, work, auth = { user: faux.user, pass: faux.password }) {
  const client = new ImapFlow({ host: faux.imap.host, port: faux.imap.port, secure: false, doSTARTTLS: false, auth, logger: false, disableAutoIdle: true });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const smtp = (faux, pass = faux.password) => nodemailer.createTransport({ host: faux.smtp.host, port: faux.smtp.port, secure: false, ignoreTLS: true, auth: { user: faux.user, pass }, logger: false });

/** The selectable folders by their special-use flag (none for a plain folder). */
const specialUse = (list) => Object.fromEntries(list.filter((box) => box.specialUse).map((box) => [box.specialUse, box.path]));

test("imapflow signs in and lists the special-use folders of both layouts", { timeout: 30_000 }, async (t) => {
  const plain = await account(t);
  assert.equal(plain.imap.host, "127.0.0.1");
  const folders = await withImap(plain, (client) => client.list());
  assert.ok(folders.some((box) => box.path === "INBOX"), JSON.stringify(folders.map((box) => box.path)));
  assert.deepEqual([specialUse(folders)["\\Drafts"], specialUse(folders)["\\Sent"]], ["Drafts", "Sent"]);

  const gmail = await account(t, { layout: "gmail" });
  const gmailFolders = await withImap(gmail, (client) => client.list());
  assert.deepEqual([specialUse(gmailFolders)["\\Drafts"], specialUse(gmailFolders)["\\Sent"], specialUse(gmailFolders)["\\All"]], ["[Gmail]/Drafts", "[Gmail]/Sent Mail", "[Gmail]/All Mail"]);
  assert.ok(!gmailFolders.some((box) => box.path === "Drafts"), "Gmail's Drafts are under [Gmail]/ alone");
});

test("a seeded message UID-fetched with PEEK stays unread; an APPEND lands in Drafts with \\Draft", { timeout: 30_000 }, async (t) => {
  const faux = await account(t);
  const seeded = faux.seed({ from: "Ana <ana@example.com>", to: [faux.user], subject: "Plan", text: "Shall we plan?", messageId: "<p1@example.com>" });
  assert.deepEqual([seeded.uid, seeded.messageId, seeded.mailbox], [1, "<p1@example.com>", "INBOX"]);
  const fetched = await withImap(faux, async (client) => {
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    assert.equal(box.exists, 1);
    const one = await client.fetchOne(String(seeded.uid), { uid: true, flags: true, internalDate: true, source: true }, { uid: true });
    await client.append("Drafts", "From: agent@faux.example\r\nTo: ana@example.com\r\nSubject: Re: Plan\r\nMessage-ID: <d1@faux.example>\r\n\r\nTuesday.\r\n", ["\\Draft", "\\Seen"]);
    return one;
  });
  assert.equal(fetched.uid, seeded.uid);
  assert.ok(fetched.internalDate instanceof Date);
  assert.match(fetched.source.toString(), /^Subject: Plan\r$/m);
  assert.match(fetched.source.toString(), /^Message-ID: <p1@example\.com>\r$/im);
  assert.match(fetched.source.toString(), /Shall we plan\?/);
  assert.ok(faux.commands().some((c) => /UID FETCH .*BODY\.PEEK\[\]/i.test(c)), faux.commands().join("\n"));
  assert.deepEqual(faux.messages().map((m) => m.flags), [[]], "the fetch was a PEEK: still unread");
  const [draft] = faux.messages("Drafts");
  assert.deepEqual([draft.messageId, draft.subject, draft.flags.includes("\\Draft")], ["<d1@faux.example>", "Re: Plan", true]);
});

test("nodemailer's send lands in sent(), its envelope and its data", { timeout: 30_000 }, async (t) => {
  const faux = await account(t);
  const transport = smtp(faux);
  t.after(() => transport.close());
  const info = await transport.sendMail({ from: faux.user, to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Hello", text: "From the fake.", headers: { "X-AgentRun-Sent": "run-1" } });
  assert.deepEqual(info.accepted.sort(), ["ana@example.com", "bo@example.com"]);
  const [sent] = faux.sent();
  assert.deepEqual([sent.from, [...sent.to].sort()], [faux.user, ["ana@example.com", "bo@example.com"]]);
  assert.match(sent.raw, /^Subject: Hello\r$/m);
  assert.match(sent.raw, /^X-Agentrun-Sent: run-1\r$/im);
  assert.match(sent.raw, /From the fake\./);
  assert.deepEqual(faux.messages("Sent"), [], "SMTP files nothing: a client APPENDs its own copy");
});

test("refuseLogin refuses IMAP and SMTP as a wrong password is; a wrong password is refused anyway", { timeout: 30_000 }, async (t) => {
  const faux = await account(t);
  await assert.rejects(withImap(faux, async () => {}, { user: faux.user, pass: "not-a-secret" }), (error) => error.authenticationFailed === true);
  faux.refuseLogin(true);
  await assert.rejects(withImap(faux, async () => {}), (error) => error.authenticationFailed === true || error.serverResponseCode === "AUTHENTICATIONFAILED");
  const refused = smtp(faux);
  t.after(() => refused.close());
  await assert.rejects(refused.sendMail({ from: faux.user, to: "ana@example.com", subject: "x", text: "x" }), (error) => error.code === "EAUTH");
  assert.deepEqual(faux.sent(), []);
  faux.refuseLogin(false);
  assert.equal(await withImap(faux, async (client) => (await client.mailboxOpen("INBOX")).exists), 0, "signs in again once it stops refusing");
});

test("setUidValidity rebuilds INBOX: a new UIDVALIDITY, its uids from 1 again", { timeout: 30_000 }, async (t) => {
  const faux = await account(t);
  faux.seed({ subject: "one" });
  faux.seed({ subject: "two" });
  const before = await withImap(faux, async (client) => {
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { validity: String(box.uidValidity), next: box.uidNext };
  });
  assert.equal(before.next, 3);
  faux.setUidValidity(77);
  const third = faux.seed({ subject: "three" });
  const after = await withImap(faux, async (client) => {
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { validity: String(box.uidValidity), uids: await client.search({ all: true }, { uid: true }) };
  });
  assert.equal(after.validity, "77");
  assert.notEqual(after.validity, before.validity);
  assert.equal(after.uids[0], 1, `uids start again from 1: ${after.uids}`);
  assert.equal(third.uid, after.uids.at(-1));
});
