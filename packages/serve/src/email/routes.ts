// The server's email account through /v2/settings/email (account.ts), the owner's session's alone: each of its operations
// is a secret write (secret-writes.ts), its view included, as the ChatGPT sign-in's is, since the account is what the
// agents' mail tools sign in as.
//   GET    /v2/settings/email       the account: its address, its servers and who signs in, never its password
//   PUT    /v2/settings/email       saved from a preset or servers of the person's own (Outlook refused in words)
//   DELETE /v2/settings/email       forgotten
//   POST   /v2/settings/email/test  a sign-in to IMAP (INBOX opened read-only, its count said) and to SMTP, sending
//                                   nothing, for the saved account or the one in the body; nothing is saved
// The mail libraries load at the test only (mail.ts), never with the server.
import { invalid } from "../errors.js";
import { registerSecretPage, registerSecretWrite } from "../secret-writes.js";
import { isObject } from "../validate.js";
import { type AccountStore, accountOf, accountView, NO_ACCOUNT, openAccount, removeAccount, saveAccount } from "./account.js";
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
      await saveAccount(deps.store, deps.sealKey, accountOf(body));
      return accountView(deps.store, deps.sealKey);
    }
    case "deleteEmailAccount":
      await removeAccount(deps.store);
      return undefined;
    case "testEmailAccount": {
      const given = isObject(body) ? body : {};
      const saved = await openAccount(deps.store, deps.sealKey);
      if (Object.keys(given).length === 0 && !saved) throw invalid([{ field: "", reason: "not_set", message: NO_ACCOUNT }]);
      const account = Object.keys(given).length === 0 ? saved! : accountOf(given, saved);
      const { smtpSignIn, withImap } = await import("./mail.js");
      const said = (error: unknown): Check => ({ ok: false, message: String((error as Error)?.message ?? error) });
      const [imap, smtp] = await Promise.all([
        withImap(account, async (session) => `Signed in to ${account.imap.host}. INBOX has ${messages((await session.open("INBOX")).exists)}.`).then((message): Check => ({ ok: true, message }), said),
        smtpSignIn(account).then((): Check => ({ ok: true, message: `Signed in to ${account.smtp.host}.` }), said),
      ]);
      return { ok: imap.ok && smtp.ok, imap, smtp };
    }
  }
  throw new Error(`no email route ${name}`);
}
