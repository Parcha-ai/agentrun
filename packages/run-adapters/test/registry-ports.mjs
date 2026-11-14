// Fakes of the registry's computer ports (kernel/registry hands.ts: computer, handoff), for the kernel registry's tests:
// each records every call, in order, and answers what a test scripts. A refusal throws as the port says: an error with
// the computer's `kind` and words.

/** A one-pixel PNG, base64: what a fake image answers unless a test gives another. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const refusal = (kind, message) => Object.assign(new Error(message), { kind });

/** The run's computer as the surface answers it: each op answers `answers[op]` (a function of its args, or an answer),
 *  by default its args echoed as the value; `refuse` throws instead. */
export function fakeComputerPort({ groups = ["ui", "screen", "input.pointer", "input.keys", "apps", "exec", "files"], answers = {}, refuse } = {}) {
  const calls = [];
  return {
    calls,
    groups,
    async call(op, args, signal) {
      calls.push([op, args]);
      if (signal?.aborted) throw signal.reason;
      if (refuse) throw refuse;
      const answer = answers[op];
      if (typeof answer === "function") return answer(args);
      return answer ?? { value: { op, args }, text: `${op} done`, images: [] };
    },
  };
}

/** A computer's hand-over to the person: ask records each request and answers `outcome` once `answer()` is called (at
 *  once with `now: true`); an abort of the call's signal rejects it. */
export function fakeHandoff({ outcome = "done", now = true } = {}) {
  const calls = [];
  let release;
  const answered = new Promise((resolve) => (release = resolve));
  if (now) release();
  return {
    calls,
    answer: () => release(),
    async ask(request, signal) {
      calls.push(["ask", request]);
      await Promise.race([answered, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      return { outcome };
    },
  };
}
