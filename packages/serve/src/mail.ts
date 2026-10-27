// The sign-in link's mail: one message through the SMTP server AGENTRUN_SMTP_URL names (smtp:// or smtps://, with its
// user and password), from AGENTRUN_MAIL_FROM. Both are the server's own: no run's process sees them (runs.ts).
import type { Mailer } from "./auth.js";

export async function smtpMailer(url: string, from: string): Promise<Mailer> {
  if (!/^smtps?:\/\//.test(url)) throw new Error("AGENTRUN_SMTP_URL takes smtp:// or smtps:// with the server, its port and its login");
  const { createTransport } = await import("nodemailer");
  const transport = createTransport(url);
  return async ({ to, subject, text }) => void (await transport.sendMail({ from, to, subject, text }));
}
