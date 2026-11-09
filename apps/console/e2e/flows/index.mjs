// The console's real-browser flows, in the order they run. A flow is
// { name, run, server?, origin?, allow?, shares?, signedIn?, pending? }:
//   run({ server, context, page, errors, blocked, origin, base, api })
//                                                            drives the page; throws on what it finds wrong. `base` is
//                                                            `origin`; `api(method, path, body?)` calls /v2 with the
//                                                            server's token and answers { status, body }
//   server                                                   startServer's options (env, faux, args, port), or a function
//                                                            making them
//   origin(server)                                           the origin the page opens (default: the server's own)
//   allow                                                    hosts the flow routes itself (the rest leave loopback: a failure)
//   shares                                                   it can run against a server already running (run.mjs --url)
//   signedIn                                                 the page starts signed in (the owner set first if it has none)
//   pending                                                  what the flow waits on; it doesn't run until then
import setupOpen from "./setup-open.mjs";
import signIn from "./sign-in.mjs";
import runToEnd from "./run-to-end.mjs";
import takeOver from "./take-over.mjs";
import secretsWriteOnly from "./secrets-write-only.mjs";
import templateApply from "./template-apply.mjs";
import watchLive from "./watch-live.mjs";

export const flows = [
  setupOpen,
  { name: "setup-public", pending: "waits on #1995 (setup at a public URL asks for the setup code)" },
  signIn,
  { name: "connect-github", pending: "waits on #1980 (Connect GitHub, its CSP form-action fix)" },
  templateApply,
  runToEnd,
  watchLive,
  takeOver,
  secretsWriteOnly,
];
