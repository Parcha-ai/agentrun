// A harness module on Anthropic's Messages, built with the kit's adapterEntry as an owner's would be: its facts name that
// wire and say it forwards with the fetch it is handed (forwardsRoute), and nothing else of the built-ins', and its
// adapter passes its check and opens no session. Each launch serve gives it (ModuleLaunch: the model, the provider, the
// route's fetch) is kept on globalThis[MESSAGES_LAUNCHES], so a test reads what any harness on the wire is handed, with no
// harness id in the reading. `{ id: MESSAGES_BARE, forwardsRoute: false }` writes one that does not say so: a module that
// ignores the fetch it is handed, so a model only the route's fetch reaches is never its.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The module's harness id. */
export const MESSAGES_MODULE = "messages-mod";
/** The id of a second module on the wire that does not say it forwards the route. */
export const MESSAGES_BARE = "messages-bare";
/** Where its launches are kept, in the process that loaded it. */
export const MESSAGES_LAUNCHES = Symbol.for("agentrun.test.messages-module.launches");

/** The launches the module was given in this process, oldest first. */
export const messagesLaunches = () => (globalThis[MESSAGES_LAUNCHES] ??= []);

/** Writes the module into `dir` (`id`, and its forwardsRoute fact unless `forwardsRoute` is false); returns its path, for
 *  HARNESS_MODULES_ENV. */
export function messagesModule(dir, { id = MESSAGES_MODULE, forwardsRoute = true } = {}) {
  const path = join(dir, `${id}.mjs`);
  writeFileSync(path, `const KEPT = Symbol.for(${JSON.stringify(MESSAGES_LAUNCHES.description)});
export const entries = (_builtins, kit) => ({ ${JSON.stringify(id)}: kit.adapterEntry({
  id: ${JSON.stringify(id)}, label: "Messages module", wire: "anthropic-messages", steer: false, rerunsStarted: false, recoversCutAnswers: 0,
  runMib: 64, thinking: ["high"], ownModel: false,${forwardsRoute ? " forwardsRoute: true," : ""}
  install: { npmLine: "messages-mod install", spec: "messages-mod@1.0.0", codes: { install: "MESSAGES_MOD_MISSING", pins: "MESSAGES_MOD_PINS" } },
  policy: () => ({ route: () => undefined }),
}, (launch) => {
  (globalThis[KEPT] ??= []).push(launch);
  return { id: ${JSON.stringify(id)}, check: () => [], open: async () => { throw new Error(${JSON.stringify(id)} + " opens no session here: " + launch.model); } };
}) });
`);
  return path;
}
