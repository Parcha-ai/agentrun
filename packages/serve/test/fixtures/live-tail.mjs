// How far a streaming value must run past a point for that point to show in a run's live view. While output streams the
// live view holds back a tail (key-refusal.ts redactedLive: 6 times the longest held value, plus 16) over the values the
// runner's redactor holds; a runner's default one holds this process's environment's (runner/redact.ts runnerSecrets),
// so the tail is sized from those, with any `extra` the test's runner also holds, and room to spare. A fixed padding
// would time a test out on a machine holding a long key (a private key in its environment).
const { runnerSecrets } = await import("../../dist/runner/redact.js");

export const pastHeldTail = (extra = []) => 6 * Math.max(0, ...runnerSecrets(process.env, extra).map((value) => value.length)) + 16 + 256;
