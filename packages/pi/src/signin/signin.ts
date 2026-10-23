// Sign in with ChatGPT through pi-ai's own flow (`openaiChatGPTOAuth.login`), unchanged. We pass the two options it
// takes: `agentName`, this app's name rather than pi's, and `getDeviceId`, the host id kept in auth.json. The credential
// it returns goes straight into the file store through pi-ai's `Models.login`; nothing here sees or prints a token.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AuthEvent, AuthInteraction, AuthPrompt, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { agentrunHome, fileCredentialStore, type FileCredentialStore } from "./store.js";

export const AGENT_NAME = "AgentRun";
/** pi-ai's provider id for OpenAI, whose OAuth method is Sign in with ChatGPT. */
export const CHATGPT_PROVIDER = "openai";

export type SignInOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The app name OpenAI shows on the consent screen. Default "AgentRun". */
  agentName?: string;
  /** How the sign-in talks to the user. Default: the terminal (`consoleInteraction`). */
  interaction?: AuthInteraction;
};

export type SignedIn = { home: string; provider: typeof CHATGPT_PROVIDER; hostId: string; expires: number };

export class SignInError extends Error {
  constructor(readonly code: "PORT_IN_USE" | "APP_NAME_IGNORED", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignInError";
  }
}

/** A pi-ai collection with only OpenAI, whose credentials live in `store`. */
export function chatgptModels(store: FileCredentialStore): MutableModels {
  const models = createModels({ credentials: store });
  models.setProvider(openaiProvider());
  return models;
}

/**
 * Sign in once per install; the token refreshes on its own afterwards. The sign-in page must name this app: pi-ai
 * before 1.1 ignores `agentName` and names pi, so a page that names anything else is never shown, and the sign-in fails
 * with `SignInError` ("APP_NAME_IGNORED") before the browser opens.
 */
export async function signIn(options: SignInOptions = {}): Promise<SignedIn> {
  const home = agentrunHome(options.home, options.env);
  const agentName = options.agentName ?? AGENT_NAME;
  const store = fileCredentialStore(home);
  const hostId = await store.hostId();
  const inner = options.interaction ?? consoleInteraction();
  const stop = new AbortController();
  let named: string | null | undefined;
  const interaction: AuthInteraction = {
    signal: inner.signal ? AbortSignal.any([inner.signal, stop.signal]) : stop.signal,
    notify(event) {
      if (event.type === "auth_url" && (named = new URL(event.url).searchParams.get("agent_name_hint")) !== agentName) return stop.abort();
      inner.notify(event);
    },
    // pi-ai's login ends only when the browser's callback comes or this prompt rejects, and its callback server holds
    // port 1455 until then: a cancel rejects the prompt even when the interaction's own prompt does not watch it.
    prompt: (prompt) => {
      if (stop.signal.aborted) return Promise.reject(stop.signal.reason);
      const cancel = prompt.signal;
      if (!cancel) return inner.prompt(prompt);
      if (cancel.aborted) return Promise.reject(cancel.reason);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(cancel.reason);
        cancel.addEventListener("abort", onAbort, { once: true });
        inner.prompt(prompt).then(resolve, reject).finally(() => cancel.removeEventListener("abort", onAbort));
      });
    },
  };
  // A variable, not a literal: pi-ai before 1.1 has no `agentName` in its `LoginOptions` type, and the page check above
  // refuses those versions at run time.
  const loginOptions = { agentName, getDeviceId: () => hostId };
  let credential;
  try {
    credential = await chatgptModels(store).login(CHATGPT_PROVIDER, "oauth", interaction, loginOptions);
  } catch (error) {
    if (stop.signal.aborted) {
      throw new SignInError("APP_NAME_IGNORED", `The installed pi-ai names ${named ? `"${named}"` : "no app"} on the sign-in page instead of "${agentName}": it ignores the app name. Sign in with ChatGPT needs a pi-ai that passes it on (1.1.0 or later).`, { cause: error });
    }
    // pi-ai's callback port is fixed at 1455, and its message for a taken port names the likely holder.
    if (error instanceof Error && /\bPort 1455 is in use\b/.test(error.message)) {
      throw new SignInError("PORT_IN_USE", `${error.message}\nFinish or cancel the other login, then run again.`, { cause: error });
    }
    throw error;
  }
  return { home, provider: CHATGPT_PROVIDER, hostId, expires: credential.type === "oauth" ? credential.expires : 0 };
}

export type ConsoleIo = {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  /** Opens the sign-in page; default the platform's opener, skipped when AGENTRUN_NO_BROWSER is set. */
  open?: (url: string) => void;
};

/** The terminal: prints the sign-in page's address and opens it, then waits for the browser's callback or, on a
 *  terminal, a pasted redirect address. The page address carries no token. */
export function consoleInteraction(io: ConsoleIo = {}): AuthInteraction {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const open = io.open ?? (process.env.AGENTRUN_NO_BROWSER ? undefined : openBrowser);
  return {
    notify(event: AuthEvent) {
      if (event.type === "auth_url") {
        output.write(`Continue with ChatGPT: sign in at\n  ${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
        open?.(event.url);
      } else if (event.type === "progress" || event.type === "info") {
        output.write(`${event.message}\n`);
      }
    },
    prompt(prompt: AuthPrompt) {
      return new Promise<string>((done, fail) => {
        const signal = prompt.signal;
        if (signal?.aborted) return fail(signal.reason);
        // Off a terminal only the browser's callback can finish the sign-in; the prompt waits to be cancelled.
        const lines = input.isTTY ? createInterface({ input, output }) : undefined;
        const onAbort = () => { lines?.close(); fail(signal?.reason); };
        signal?.addEventListener("abort", onAbort, { once: true });
        lines?.question(`${prompt.message} `, (answer) => {
          signal?.removeEventListener("abort", onAbort);
          lines.close();
          done(answer);
        });
      });
    },
  };
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => { /* no opener: the address is printed */ });
    child.unref();
  } catch { /* no opener: the address is printed */ }
}
