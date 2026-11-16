# An inbox assistant on your laptop, in three minutes

It runs on your own computer and on your ChatGPT plan, with no API key. It reads each new email, files it under
**Needs reply**, **FYI** or **Ignored**, and drafts your reply to what needs you in your Drafts folder. It never
sends: you press send in your mail app.

You need:

- macOS or Linux with Node 24.22.3 or newer;
- a ChatGPT plan;
- a mail account that allows IMAP with an app password: Gmail, Fastmail, iCloud, or any other IMAP server.

## 1. Start AgentRun

```sh
npx @parcha/agentrun
```

The console opens in your browser. Set a password.

## 2. Continue with ChatGPT

Press **Continue with ChatGPT** on the first screen (or in **Settings → Model keys**) and sign in on OpenAI's page.
The tab comes back to your computer, and the console says you're signed in. Codex and pi agents now run on your
ChatGPT plan.

## 3. Connect your inbox

Open **Settings → Email**, choose **Gmail**, and enter your address and a Google
[app password](https://myaccount.google.com/apppasswords). Press **Save**, then **Test**. The password is sealed on
your computer and never shown again.

Fastmail and iCloud work the same way with their own app passwords, and **Other** takes any IMAP server. Where to
make each app password, the ports, and why Outlook isn't offered: [Your mail account](#your-mail-account).

## 4. Install the inbox template

1. Open **Templates** and press **Add from URL**.
2. Paste `github:Parcha-ai/agentrun-templates/templates/inbox-assistant@main` and press **Read it**.
   You see the whole package, its instructions included, before anything is stored.
3. Tick **I trust Parcha-ai** and press **Install**.
4. Press **Configure**, enter your name and your email address, and press **Apply**.

The assistant runs on Codex. It starts from the moment you apply: mail already in your inbox starts nothing.

## 5. Get an email

Have someone email you, or send one from another address you own. The assistant leaves mail from your own address
alone, so an email you send yourself is skipped.

Within a minute or two, a run starts for it. The run files the email under **Needs reply**, **FYI** or **Ignored**:
a label in Gmail, a folder elsewhere. When the email needs you, it stays in your inbox and a reply waits in your
Drafts. The run shows its tokens and **Using ChatGPT plan**: no dollars, no key.

## What it may do

The assistant may read, search, file and draft. It never deletes, never files into Trash or Spam, and has no tool
to send. The text of an email is data, not instructions: an email that asks it to write to some other address gets
no draft to that address.

Every evening at 18:00 it drafts a short digest of the day's mail to you. **Configure** also takes your time zone
(UTC unless you set it), another time for the digest, your voice, senders never to ignore, mail to ignore, and a
Monday brief of the week ahead.

## Your mail account

AgentRun reads, files and drafts your mail over IMAP. It saves SMTP too, for an agent you let send; the inbox
assistant never sends. It signs in with an app password: a password your provider makes for one app, which you can
revoke without changing your own. Your normal password doesn't work with Gmail, Fastmail or iCloud.

| Provider | Where to make the app password | IMAP | SMTP |
| --- | --- | --- | --- |
| Gmail | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Needs 2-Step Verification. A company account whose admin turned app passwords off can't connect. | `imap.gmail.com:993` | `smtp.gmail.com:465` |
| Fastmail | Settings → Privacy & Security → Manage app passwords and access → **New app password**, with mail access. Not on the Basic plan. | `imap.fastmail.com:993` | `smtp.fastmail.com:465` |
| iCloud | [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords. Needs two-factor authentication. Changing your Apple Account password revokes it. | `imap.mail.me.com:993` | `smtp.mail.me.com:587` |

The three presets fill in the servers: you enter your address and the app password. **Other** takes your server's
IMAP and SMTP hosts and ports, and a sign-in name when it isn't your address. Ports 993 and 465 use TLS from the
start, any other port must offer STARTTLS, and AgentRun never sends your password unencrypted. **Test** signs in to
both servers without saving or sending anything.

Outlook isn't offered. Microsoft turned off app-password sign-in for Outlook.com's IMAP and SMTP, so it needs
Microsoft sign-in, which AgentRun doesn't do yet.

### This or Composio's Gmail

AgentRun also connects Gmail through [Composio](tutorials/composio.md). Pick by where your server runs and what your
account allows:

- **This page's email account** keeps your mail between your computer and your provider: the app password is sealed
  on your computer and no other service sees your mail. It works on a laptop with no public address (the trigger
  checks the inbox every minute), with any IMAP provider. The inbox template uses it.
- **Composio's Gmail** signs in with Google through Composio, so it fits a Google account whose admin turned app
  passwords off but allows Composio. Your mail goes through Composio, you need a Composio API key, and its triggers
  reach your server by webhook, so the server needs a public address. The inbox template doesn't use it.

## Your ChatGPT plan

Eligible usage in this app uses your ChatGPT plan; manage it in your ChatGPT settings. Your plan has its own limits.
When a limit is reached the run stops and says so; it never switches to a key.
