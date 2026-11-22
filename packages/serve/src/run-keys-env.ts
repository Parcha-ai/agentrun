// The run-keys setting (run-keys.ts), read where the CLI starts, before the rest of the server loads: nothing imported.
export const RUN_KEYS_ENV = "AGENTRUN_RUN_KEYS";

/** Whether `env` turns the run-keys setting on: `1` or `true` on; unset, empty, `0` or `false` off. Any other value is
 *  refused in words (a TypeError). */
export function runKeysFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  const given = env[RUN_KEYS_ENV]?.trim().toLowerCase() ?? "";
  if (given === "1" || given === "true") return true;
  if (given === "" || given === "0" || given === "false") return false;
  throw new TypeError(`${RUN_KEYS_ENV} is 1 (each run brings the tool keys this server does not hold) or 0, not ${JSON.stringify(env[RUN_KEYS_ENV])}`);
}
