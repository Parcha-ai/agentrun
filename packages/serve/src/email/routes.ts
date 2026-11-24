// The server's email account through /v2/settings/email (account.ts), the owner's session's alone: each of its operations
// is a secret write (secret-writes.ts), its view included, as the ChatGPT sign-in's is, since the account is what the
// agents' mail tools sign in as.
//   GET    /v2/settings/email       the account: its address, its servers and who signs in, never its password
//   PUT    /v2/settings/email       saved from a preset or servers of the person's own (Outlook refused in words), once
//                                   it signs in as the test does; a refused sign-in saves nothing (424, the test's words)
//   DELETE /v2/settings/email       forgotten
//   POST   /v2/settings/email/test  a sign-in to IMAP (INBOX opened read-only, its count said) and to SMTP, sending
//                                   nothing, for the saved account or the one in the body; nothing is saved
// The mail libraries load at a sign-in only (mail.ts), never with the server.
import { ApiError, invalid, sentence } from "../errors.js";
import { registerSecretPage, registerSecretWrite } from "../secret-writes.js";
import { isObject } from "../validate.js";
import { type AccountStore, accountOf, accountView, NO_ACCOUNT, type OpenedAccount, openAccount, removeAccount, saveAccount } from "./account.js";
import { messages } from "./names.js";

/** The routes, by their operation names. */
export const EMAIL_ROUTES: ReadonlySet<string> = new Set(["getEmailAccount", "saveEmailAccount", "deleteEmailAccount", "testEmailAccount"]);
for (const operation of EMAIL_ROUTES) registerSecretWrite(operation, () => true);
registerSecretPage([...EMAIL_ROUTES], "/#/settings/email");

export type EmailRouteDeps = { store: AccountStore; sealKey: Buffer };
type Check = { ok: boolean; message: string };

/** `n` messages, in words. */

/** One route's answer (the dispatch sends it 200; DELETE's is undefined, 204). A body that does not read is 422. */
export async function emailRoute(deps: EmailRouteDeps, name: string, body?: unknown): Promise<unknown> {
  switch (name) {
    case "getEmailAccount":
      return accountView(deps.store, deps.sealKey);
    case "saveEmailAccount": {
      if (!isObject(body)) throw invalid([{ field: "", reason: "wrong_type", message: "The body is the account: {preset, address, user?, password, imap?, smtp?}" }]);
      const account = accountOf(body);
      // Saved only once it signs in as the test does: a refusal saves nothing, and the account kept before stays as it was.
      const checked = await signIn(account);
      if (!checked.ok) throw new ApiError("upstream_failed", `The account was not saved: it did not sign in. ${[checked.imap, checked.smtp].filter((half) => !half.ok).map((half) => sentence(half.message)).join(" ")} Any account saved before is as it was.`, { details: { imap: checked.imap, smtp: checked.smtp } });
      await saveAccount(deps.store, deps.sealKey, account);
      return accountView(deps.store, deps.sealKey);
    }
    case "deleteEmailAccount":
      await removeAccount(deps.store);
      return undefined;
    case "testEmailAccount": {
      const given = isObject(body) ? body : {};
      const saved = await openAccount(deps.store, deps.sealKey);
      if (Object.keys(given).length === 0 && !saved) throw invalid([{ field: "", reason: "not_set", message: NO_ACCOUNT }]);
      return signIn(Object.keys(given).length === 0 ? saved! : accountOf(given, saved));
    }
  }
  throw new Error(`no email route ${name}`);
}

/** A sign-in to IMAP (INBOX opened read-only, its count said) and to SMTP, sending nothing: the test's answer, and what a
 *  save must pass. Each half in words, never the password. */
async function signIn(account: OpenedAccount): Promise<{ ok: boolean; imap: Check; smtp: Check }> {
  const { smtpSignIn, withImap } = await import("./mail.js");
  const said = (error: unknown): Check => ({ ok: false, message: String((error as Error)?.message ?? error) });
  const [imap, smtp] = await Promise.all([
    withImap(account, async (session) => `Signed in to ${account.imap.host}. INBOX has ${messages((await session.open("INBOX")).exists)}.`).then((message): Check => ({ ok: true, message }), said),
    smtpSignIn(account).then((): Check => ({ ok: true, message: `Signed in to ${account.smtp.host}.` }), said),
  ]);
  return { ok: imap.ok && smtp.ok, imap, smtp };
}
