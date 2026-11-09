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
//   shares                                                   it can run against a server already running (run.mjs --url);
//                                                            or a function of the run's { setupCodeFile } saying so
//   signedIn                                                 the page starts signed in (the owner set first if it has none)
//   pending                                                  what the flow waits on; it doesn't run until then
import connectGitHub from "./connect-github.mjs";
import setupOpen from "./setup-open.mjs";
import setupPublic from "./setup-public.mjs";
import signIn from "./sign-in.mjs";
import signedOutElsewhere from "./signed-out-elsewhere.mjs";
import runToEnd from "./run-to-end.mjs";
import takeOver from "./take-over.mjs";
import templateApply from "./template-apply.mjs";
import templateUnattended from "./template-unattended.mjs";
import watchLive from "./watch-live.mjs";
import serverDeny from "./server-deny.mjs";
import computersKeys from "./computers-keys.mjs";
import workspaceArchil from "./workspace-archil.mjs";

export const flows = [
  setupOpen,
  setupPublic,
  signIn,
  connectGitHub,
  templateApply,
  templateUnattended,
  runToEnd,
  watchLive,
  takeOver,
  signedOutElsewhere,
  serverDeny,
  computersKeys,
  workspaceArchil,
  { name: "box-image-banner", pending: "waits on a server whose Docker box image is still being built or pulled (capabilities.places.boxes state preparing): the e2e servers have no Docker daemon to build one" },
];
