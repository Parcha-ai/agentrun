// The strings the runner and the live view key on in pi's own records, in one place. Each is pi's, not ours, and
// test/pi-stop-reasons.test.mjs reads it from pi itself, so a rename in pi fails there by name.
export const PI_STOP = {
  /** pi-ai's stop reason for an answer its provider cut at the output limit (runner/loop.ts cutLast). */
  length: "length",
  /** pi-durable's diagnostic code on the result of a tool call aborted while it ran (live/translate.ts shownResult). */
  aborted: "aborted",
} as const;
