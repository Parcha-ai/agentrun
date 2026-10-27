#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { smtpMailer } from "./mail.js";
import { banner } from "./print.js";
import { DEFAULT_PORT, type Serve, startServe } from "./server.js";

const USAGE = `usage: agentrun-serve [--data DIR] [--listen ADDR] [--port N] [--faux MODULE] [--allow-host NAME ...] [--max-runs N] [--drain-timeout D]

  --data DIR        the agent store and its runs (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --listen ADDR     the address to listen on (default 127.0.0.1); on any other, every Host name is served and the token
                    is the only lock, so put TLS in front of it
  --port N          the port (default ${DEFAULT_PORT}; 0 is any free port)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
  --allow-host NAME another Host name to accept (repeatable)
  --max-runs N      the most runs at once (default AGENTRUN_MAX_RUNS, else from this host's memory: (memory - 128 MiB)
                    / 72 MiB, at least 1); over it a new run is 429
  --drain-timeout D how long a busy run may finish its turn when the server stops (default 30s; the image's is 6s, inside
                    Docker's 10 s grace); a run cut off resumes at the next start

Without --faux, a revision's model ("provider/model-id", or AGENT_MODEL when it names none; a workflow node's tier maps
to AGENT_MODEL_FAST or AGENT_MODEL_STRONG, each falling back to AGENT_MODEL) is served by pi-ai's providers with their
keys from the environment, or, with AGENT_MODEL_BASE_URL, by that one OpenAI Responses gateway (AGENT_MODEL_API_KEY when
it needs a key). AGENTRUN_TOKEN, when set, is the token in place of DIR/.token's, and is never printed; DIR/.token's is
printed only by the start that made it. AGENTRUN_PUBLIC_URL, when set, is the address people open (a container's
published port, or a proxy's URL), and the link printed uses it. stdout gets one line per request, per run start and
end, and per refused credential; AGENTRUN_LOG=quiet leaves out the request lines.

Accounts are on unless AGENTRUN_ACCOUNTS=0: people sign in with an email link, and the token still works for scripts and
the CLI. The first start prints a setup link for the owner; an admin adds people. A sign-in link is mailed through
AGENTRUN_SMTP_URL (smtp:// or smtps://, with its login) from AGENTRUN_MAIL_FROM, else printed to stderr. On an address
that is not loopback, accounts need AGENTRUN_PUBLIC_URL; without it the server runs on its token alone and says so.`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      data: { type: "string" },
      listen: { type: "string" },
      port: { type: "string" },
      faux: { type: "string" },
      "allow-host": { type: "string", multiple: true, default: [] },
      "max-runs": { type: "string" },
      "drain-timeout": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port takes a port number\n\n${USAGE}`);
  process.exit(2);
}
let publicUrl: string | undefined;
if (process.env.AGENTRUN_PUBLIC_URL) {
  const parsed = URL.canParse(process.env.AGENTRUN_PUBLIC_URL) ? new URL(process.env.AGENTRUN_PUBLIC_URL) : undefined;
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    console.error(`AGENTRUN_PUBLIC_URL takes an http(s) URL\n\n${USAGE}`);
    process.exit(2);
  }
  publicUrl = parsed.href.replace(/\/+$/, "");
}
const data = values.data ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentrun", "agents");
const given = process.env.AGENTRUN_TOKEN || undefined;
// A stdout its reader closed (a pipe left behind) loses the log lines, never the server.
process.stdout.on("error", () => undefined);
// Accounts are on unless AGENTRUN_ACCOUNTS=0; off, none of these settings is read. On an address that is not loopback
// they need AGENTRUN_PUBLIC_URL: without it, and unless AGENTRUN_ACCOUNTS=1 asked for them by name, the server starts on
// its token alone and says why. The token works for scripts and the CLI either way.
const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);
let accounts = process.env.AGENTRUN_ACCOUNTS !== "0";
if (accounts && process.env.AGENTRUN_ACCOUNTS !== "1" && !publicUrl && !isLoopback(values.listen ?? "127.0.0.1")) {
  console.error(`agentrun-serve: accounts are off: on ${values.listen}, which is not loopback, set AGENTRUN_PUBLIC_URL to the address people open to turn them on`);
  accounts = false;
}
const smtp = accounts ? process.env.AGENTRUN_SMTP_URL || undefined : undefined;
if (smtp && !process.env.AGENTRUN_MAIL_FROM) {
  console.error(`AGENTRUN_SMTP_URL needs AGENTRUN_MAIL_FROM, the address sign-in links come from\n\n${USAGE}`);
  process.exit(2);
}
const mail = smtp ? await smtpMailer(smtp, process.env.AGENTRUN_MAIL_FROM!) : undefined;
const owner = accounts && process.env.AGENTRUN_OWNER_EMAIL ? { email: process.env.AGENTRUN_OWNER_EMAIL } : undefined;
const authSecret = process.env.AGENTRUN_AUTH_SECRET || undefined;
let serve: Serve;
try {
  serve = await startServe({
    data, port, ...(values.listen ? { host: values.listen } : {}), ...(given ? { token: given } : {}), ...(values.faux ? { faux: values.faux } : {}), allowHosts: values["allow-host"],
    ...(values["max-runs"] !== undefined ? { maxRuns: Number(values["max-runs"]) } : {}),
    ...(values["drain-timeout"] ? { drainTimeout: values["drain-timeout"] } : {}), log: (line) => void process.stdout.write(`${line}\n`),
    ...(accounts ? { accounts, ...(publicUrl ? { publicUrl } : {}), ...(authSecret ? { authSecret } : {}), ...(owner ? { owner } : {}), ...(mail ? { mail } : {}) } : {}),
  });
} catch (error) {
  console.error(`agentrun-serve: ${(error as Error).message}`);
  process.exit(1);
}
// A token from the environment is the operator's already, and the stored one is printed by the start that made it only.
const source = given ? "env" : serve.tokenMade ? "made" : "file";
for (const line of banner({ url: serve.url, baseUrl: serve.baseUrl, data, token: serve.token, source, ...(values.listen ? { listen: values.listen } : {}), ...(publicUrl ? { publicUrl } : {}) })) console.log(line);
if (serve.setupUrl) console.log(`Set up this server: ${serve.setupUrl}`);
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
