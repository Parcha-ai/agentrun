// The user a CLI started on a login runs as, for the account of its Keychain item on macOS. Written for AgentRun.
//
// Here alone, beside nothing else, so a host that starts the person's own `claude` (serve's native runtimes) reads it
// without loading the adapter and its SDK (facts.ts).
import { userInfo } from "node:os";

/** `USER` and `LOGNAME` for a CLI started on a login, built from nothing (the status check, the sign-in this host starts,
 *  a run, the CLI's own sign-out): the user this process runs as, as the system has it (`os.userInfo()`, which reads
 *  the user database, never the server's own USER), the user whose home personHome is. On macOS the pinned CLI names
 *  its Keychain item's account by `$USER`, else by its runtime's `os.userInfo().username`; it is a Bun binary, whose
 *  userInfo reads `$USER` too and says "unknown" without it. So a CLI started with no USER saves and reads the login's
 *  tokens under the account "unknown", where the person's own `claude`, run in a terminal that has USER, never looks:
 *  it reads signed out while the badge reads signed in. A user the system cannot name (no entry in its user database)
 *  is the server's USER or LOGNAME, when it has one. */
export function loginUser(): Record<string, string> {
  let name: string | undefined;
  try {
    name = userInfo().username || undefined;
  } catch {
    name = undefined;
  }
  name ??= process.env.USER || process.env.LOGNAME || undefined;
  return name === undefined ? {} : { USER: name, LOGNAME: name };
}
