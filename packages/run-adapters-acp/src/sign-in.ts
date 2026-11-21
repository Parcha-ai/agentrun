// A person's own sign-in to an ACP agent (Google Antigravity's `oauth-personal`), done by the agent itself in that person's
// terminal: `agentrun harness sign-in`. The adapter starts the agent's own unmodified binary, says initialize, then ACP
// `authenticate` with the method, and stops it once that answers. Everything the sign-in says (Antigravity prints the
// address to sign in at, whose redirect_uri names the port its one-shot loopback server listens on) goes from the
// agent's stderr straight to the person's terminal, never read here; the browser's redirect lands on the agent's own
// server, never one of ours; and the agent writes what it keeps into the folder `homeEnv` names, which nothing here
// opens. No byte of the sign-in passes through this process: its stdout carries ACP's answers alone (`{}`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { launchEnv } from "@parcha/agentrun-kernel";
import { ACP_CODES } from "./facts.js";
import { startAgent } from "./host/agent.js";
import { RESERVED_ENV } from "./recipe.js";

/** A variable's name, as the folder's. */
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** How long a person has to sign in: Antigravity's own loopback server waits about as long. */
export const SIGN_IN_MS = 10 * 60_000;

export interface SignInOptions {
  /** The agent's binary (absolute; its pin checked by the caller) and the arguments that start it as an ACP agent. */
  command: string;
  args: readonly string[];
  /** The sign-in method's id, as the agent's initialize lists it (`oauth-personal`). */
  method: string;
  /** The variable the agent reads the folder it keeps its sign-in in from (`GEMINI_HOME`), and that folder. */
  homeEnv: string;
  home: string;
  /** The recipe's own settings (its `env`: never a key), under HOME, TMPDIR and `homeEnv`, which are this run's. */
  env?: Readonly<Record<string, string>>;
  /** The environment the allowlist (PATH, LANG, TZ) is read from. Default process.env. */
  from?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Signs the agent in, its stderr the person's terminal: resolves once its `authenticate` answered, rejects with an
 *  ACP_CODES failure (its method unlisted, refused, or the agent ended) whose words are ours and its exit status alone. */
export async function signInAgent(options: SignInOptions): Promise<void> {
  // The folder's variable, and the recipe's env, never one the adapter sets nor one that changes what the agent's process
  // loads or runs (the kernel's one list): refused before anything starts.
  if (!KEY_NAME.test(options.homeEnv) || RESERVED_ENV.has(options.homeEnv) || launchEnv(options.homeEnv)) {
    throw new Error(`${ACP_CODES.authFailed}: the sign-in folder's variable ${options.homeEnv} is not a variable's name, or is one the adapter sets or one that changes what the agent's process loads or runs`);
  }
  const unsafe = Object.keys(options.env ?? {}).filter((name) => name === options.homeEnv || RESERVED_ENV.has(name) || launchEnv(name));
  if (unsafe.length) throw new Error(`${ACP_CODES.authFailed}: the env names ${unsafe.join(", ")}, which this sign-in sets or which change what the agent's process loads or runs`);
  const stopped = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
  // A HOME of its own for whatever else the agent writes, gone with it; its sign-in goes to `home` alone.
  const scratch = mkdtempSync(join(tmpdir(), "agentrun-sign-in-"));
  const agent = startAgent({
    command: options.command,
    args: options.args,
    cwd: scratch,
    env: { ...options.env, HOME: scratch, TMPDIR: scratch, [options.homeEnv]: options.home },
    ...(options.from ? { from: options.from } : {}),
    stderr: "inherit",
    signal,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  const ended = () => new Error(`${ACP_CODES.agentExited}: the agent ended before its sign-in answered (${agent.ended() ?? "its end is not known yet"})`);
  /** `what` (the request `asked`), refused when the agent ends or the time runs out first. */
  const ask = async <T>(asked: "initialize" | "sign-in", what: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        what,
        agent.exited.then(() => Promise.reject(ended())),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${ACP_CODES.authFailed}: no sign-in within ${Math.round(ms / 60_000)} minutes`)), ms))),
      ]);
    } catch (error) {
      // An error the agent answered (a JSON-RPC code): its own words are on the person's terminal already, ours say the
      // request and the code alone.
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") throw new Error(`${ACP_CODES.authFailed}: the agent refused its ${asked} (error ${code})`);
      // A request the agent did not answer (no JSON-RPC code) failed as its pipe closed: say how the agent ended, once
      // its exit is in.
      if (!(error as Error).message?.startsWith("ACP_")) {
        let wait: NodeJS.Timeout | undefined;
        const gone = await Promise.race([agent.exited.then(() => true), new Promise<boolean>((done) => (wait = setTimeout(() => done(false), 2_000)))]);
        clearTimeout(wait);
        if (gone) throw ended();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const init = await ask("initialize", agent.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentrun", version: "1" } }), 60_000);
    const methods = (init.authMethods ?? []).map((method) => method.id);
    if (!methods.includes(options.method)) throw new Error(`${ACP_CODES.authUnlisted}: the agent's initialize does not list the sign-in method ${options.method} (it lists ${methods.join(", ") || "none"})`);
    await ask("sign-in", agent.connection.agent.request("authenticate", { methodId: options.method }), options.timeoutMs ?? SIGN_IN_MS);
  } finally {
    stopped.abort();
    agent.kill();
    await agent.exited;
    rmSync(scratch, { recursive: true, force: true });
  }
}
