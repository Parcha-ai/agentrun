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
import githubTrigger from "./github-trigger.mjs";
import setupOpen from "./setup-open.mjs";
import setupPublic from "./setup-public.mjs";
import setupLinkFollow from "./setup-link-follow.mjs";
import setupRender from "./setup-render.mjs";
import signIn from "./sign-in.mjs";
import demoMode from "./demo-mode.mjs";
import signOutScope from "./sign-out-scope.mjs";
import signedOutElsewhere from "./signed-out-elsewhere.mjs";
import reportJson from "./report-json.mjs";
import runToEnd from "./run-to-end.mjs";
import takeOver from "./take-over.mjs";
import askDone from "./ask-done.mjs";
import secretsWriteOnly from "./secrets-write-only.mjs";
import apiKeys from "./api-keys.mjs";
import templateApply from "./template-apply.mjs";
import templateUnattended from "./template-unattended.mjs";
import templateUnattendedNavigation from "./template-unattended-navigation.mjs";
import watchLive from "./watch-live.mjs";
import screenSteps from "./screen-steps.mjs";
import screenUnopened from "./screen-unopened.mjs";
import serverDeny from "./server-deny.mjs";
import computersKeys from "./computers-keys.mjs";
import computersRunning from "./computers-running.mjs";
import workspaceArchil from "./workspace-archil.mjs";
import triggerRowLabel from "./trigger-row-label.mjs";
import computerStep from "./computer-step.mjs";
import agentCardFooter from "./agent-card-footer.mjs";
import connectAgentTabs from "./connect-agent-tabs.mjs";
import costPerRun from "./cost-per-run.mjs";
import playgroundPaneLines from "./playground-pane-lines.mjs";
import learningBill from "./learning-bill.mjs";
import workflowReplay from "./workflow-replay.mjs";
import replayButton from "./replay-button.mjs";
import learningLoop from "./learning-loop.mjs";
import gradeRun from "./grade-run.mjs";
import toolCards from "./tool-cards.mjs";
import narrowLayouts from "./narrow-layouts.mjs";
import playgroundOperationWidth from "./playground-operation-width.mjs";
import devToolsPanelWidth from "./dev-tools-panel-width.mjs";
import suggestAgents from "./suggest-agents.mjs";

export const flows = [
  setupOpen,
  setupPublic,
  setupLinkFollow,
  setupRender,
  signIn,
  signOutScope,
  demoMode,
  connectGitHub,
  githubTrigger,
  { name: "github-trigger-create", pending: "waits on a connected GitHub App without GitHub: the server's GitHub API (githubApi) is a programmatic option only, not a flag the built server takes" },
  templateApply,
  templateUnattended,
  templateUnattendedNavigation,
  runToEnd,
  reportJson,
  watchLive,
  screenSteps,
  screenUnopened,
  takeOver,
  askDone,
  signedOutElsewhere,
  serverDeny,
  secretsWriteOnly,
  apiKeys,
  computersKeys,
  computersRunning,
  workspaceArchil,
  triggerRowLabel,
  computerStep,
  agentCardFooter,
  connectAgentTabs,
  costPerRun,
  learningBill,
  workflowReplay,
  replayButton,
  learningLoop,
  gradeRun,
  toolCards,
  ...narrowLayouts,
  playgroundOperationWidth,
  devToolsPanelWidth,
  playgroundPaneLines,
  ...suggestAgents,
];
