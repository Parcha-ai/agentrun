// A harness table (harness-table.ts HARNESS_TABLE_ENV) that can hold the server's probe of its offers, and change what it
// finds, for a test of what lands after it. Every harness is the built-in one; claude-agent's check first waits on the
// hold a test set with `hold(matches)`, when the environment it is asked on matches, and answers the reason a test set
// with `answer(reason)` in place of the built-in check, a fact newer than the offers the server holds. A hold is used
// once: the first matching check takes it. The table loads in the server's process (startServe's harnessTable), so a
// test that requires this module gets the same hold and answer the server's checks read.
let held;
let fact;

/** Holds the next claude-agent check asked on an environment `matches` accepts: `reached` resolves once that check waits,
 *  and `release()` lets it go on. Given `reason`, that check alone then answers that claude-agent does not run here, for
 *  `reason`, so the offers its probe lands are told apart from any other probe's; given an Error, that check throws it,
 *  so its probe fails. */
exports.hold = (matches, reason) => {
  let reach;
  let release;
  const reached = new Promise((resolve) => { reach = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  held = { matches, reason, reach, released };
  return { reached, release };
};

/** From now on, claude-agent's check answers that it does not run here, for `reason`; undefined puts the built-in check
 *  back. */
exports.answer = (reason) => {
  fact = reason;
};

exports.entries = (builtins) => {
  const builtin = builtins["claude-agent"];
  return {
    "claude-agent": {
      refusal: async (env, given, options) => {
        const hold = held;
        if (hold && hold.matches(env)) {
          held = undefined;
          hold.reach();
          await hold.released;
          if (hold.reason instanceof Error) throw hold.reason;
          if (hold.reason !== undefined) return { reason: hold.reason };
        }
        return fact === undefined ? builtin.refusal(env, given, options) : { reason: fact };
      },
    },
  };
};
