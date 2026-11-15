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

Google gives app passwords only with 2-Step Verification on. A company Google account whose admin turned app
passwords off can't connect yet. Fastmail and iCloud work the same way with their own app passwords, and **Other**
takes any IMAP server.

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

Eligible usage in this app uses your ChatGPT plan; manage it in your ChatGPT settings. Your plan has its own limits.
When a limit is reached the run stops and says so; it never switches to a key.
