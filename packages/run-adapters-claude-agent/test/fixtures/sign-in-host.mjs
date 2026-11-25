// A server for sign-in.test.mjs's parent-death test: starts the CLI's own sign-in (startClaudeLogin) on the stand-in CLI
// at argv[2], for the login folder argv[3], in the home argv[4], with the parent watch argv[5] (pdeathsig or shim), and
// then waits to be SIGKILLed, as a server killed by the OOM killer is: it runs no stop.
import { startClaudeLogin } from '@parcha/agentrun-harness-claude';

const [cli, dir, home, watch] = process.argv.slice(2);
startClaudeLogin(cli, { dir, profiles: `${dir}/anthropic`, userHome: home }, { display: {}, watch });
setInterval(() => {}, 1000);
