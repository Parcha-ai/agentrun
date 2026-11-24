// A harness table (harness-table.ts HARNESS_TABLE_ENV) that can hold the server's probe of its offers, for a test of what
// lands after it. Every harness is the built-in one; claude-agent's check first waits on the hold a test set with
// `hold(matches)`, when the environment it is asked on matches. A hold is used once: the first matching check takes it.
// The table loads in the server's process (startServe's harnessTable), so a test that requires this module gets the
// same hold the server's checks read.
let held;

/** Holds the next claude-agent check asked on an environment `matches` accepts: `reached` resolves once that check waits,
 *  and `release()` lets it go on. */
exports.hold = (matches) => {
  let reach;
  let release;
  const reached = new Promise((resolve) => { reach = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  held = { matches, reach, released };
  return { reached, release };
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
        }
        return builtin.refusal(env, given, options);
      },
    },
  };
};
