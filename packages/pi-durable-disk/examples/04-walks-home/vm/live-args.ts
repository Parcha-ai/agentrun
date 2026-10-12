// live.mjs's own arguments that need a check before anything starts.

/**
 * `--robot-thread-deadline-s N`: absent is fine (the host's default); present with no value, or with anything but a whole number of seconds from 30 to 3600, is an error here, not a silent
 * fall back to the 20-minute default on the VM.
 */
export function threadDeadlineArg(argv: readonly string[]): number | undefined {
  const at = argv.indexOf("--robot-thread-deadline-s");
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--robot-thread-deadline-s needs a value: a whole number of seconds from 30 to 3600");
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new Error(`--robot-thread-deadline-s ${value}: a whole number of seconds from 30 to 3600`);
  return seconds;
}
