// The console's real-browser flows, in the order they run. A flow is { name, run, server?, origin?, allow?, shares?, pending? }:
//   run({ server, context, page, errors, blocked, origin })  drives the page; throws on what it finds wrong
//   server                                                   startServer's options (env, faux, args, port), or a function
//                                                            making them
//   origin(server)                                           the origin the page opens (default: the server's own)
//   allow                                                    hosts the flow routes itself (the rest leave loopback: a failure)
//   shares                                                   it can run against a server already running (run.mjs --url)
//   pending                                                  what the flow waits on; it doesn't run until then
import setupOpen from "./setup-open.mjs";
import connectGitHub from "./connect-github.mjs";
import signIn from "./sign-in.mjs";

export const flows = [
  setupOpen,
  { name: "setup-public", pending: "waits on #1995 (setup at a public URL asks for the setup code)" },
  signIn,
  connectGitHub,
  { name: "template-apply", pending: "waits on #1975 (the Templates page and its Apply screen)" },
  { name: "run-to-end", pending: "to come: a run with the faux model, followed to its end" },
  { name: "take-over", pending: "to come: the browser ask and take-over with pi-browser's fakes" },
];
