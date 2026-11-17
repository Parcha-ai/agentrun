// A person's own Claude Code login on this machine, which a claude-agent session may run on in place of a model key.
// Written for AgentRun.
//
// The pinned CLI keeps the login where it always does, in its own files, and calls Anthropic with it itself. AgentRun
// never reads, copies, stores or relays it: a session only tells the CLI where its login is (two directories, by
// environment), and the host asks the CLI whether it is signed in (`claude auth status`), reading nothing but that answer.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelPort, ModelUsage } from "@parcha/agentrun-kernel";

/** Where the pinned CLI keeps a login: its credentials file's directory (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) and its
 *  Anthropic profiles (`ANTHROPIC_CONFIG_DIR`). The CLI reads and writes both; nothing else does. */
export interface ClaudeAgentLogin {
  /** The directory of the CLI's credentials file. */
  dir: string;
  /** The directory of the CLI's Anthropic profiles. */
  profiles: string;
}

/** The variables that point the CLI at `login`: never its config dir (`CLAUDE_CONFIG_DIR`), which the Agent SDK copies
 *  a credentials file out of when it resumes a session. */
export function loginEnv(login: ClaudeAgentLogin): Record<string, string> {
  return { CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles };
}

/** The line a person runs to sign the CLI in at `login` (the CLI opens a browser itself). Its config dir is the login's
 *  too, so a CLI older than the credentials variable keeps the login there as well. */
export const loginCommand = (login: ClaudeAgentLogin, cli = "claude"): string =>
  `CLAUDE_CONFIG_DIR=${shellWord(login.dir)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellWord(login.dir)} ANTHROPIC_CONFIG_DIR=${shellWord(login.profiles)} ${shellWord(cli)} auth login`;

const shellWord = (word: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** What the CLI says of its login: whether it is signed in, how, and the account's own words when it gives them. */
export interface ClaudeLoginStatus {
  signedIn: boolean;
  /** How the CLI signs in (`claude.ai`, `oauth_token`, `api_key`, ...). */
  method?: string;
  email?: string;
  organization?: string;
  /** The account's plan (`max`, `pro`, `team`, ...). */
  plan?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined);

/** `claude auth status --json`'s answer, read for the fields above alone; undefined when it is no such answer. */
export function parseLoginStatus(stdout: string): ClaudeLoginStatus | undefined {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof body.loggedIn !== "boolean") return undefined;
  const method = text(body.authMethod);
  const email = text(body.email);
  const organization = text(body.orgName) ?? text(body.organization);
  const plan = text(body.subscriptionType) ?? text(body.plan);
  return { signedIn: body.loggedIn && method !== "none", ...(method ? { method } : {}), ...(email ? { email } : {}), ...(organization ? { organization } : {}), ...(plan ? { plan } : {}) };
}

/** The longest a status check may take. */
export const LOGIN_STATUS_MS = 15_000;

/** Ask the CLI at `cli` whether it is signed in at `login`: `auth status --json`, in an empty home and config dir of its
 *  own (removed after), with only PATH and the login's two variables beside them. Throws when the CLI gives no answer
 *  that reads as one. */
export async function claudeLoginStatus(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string } = {}): Promise<ClaudeLoginStatus> {
  const scratch = mkdtempSync(join(tmpdir(), "agentrun-claude-status-"));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(cli, ["auth", "status", "--json"], {
        env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, CLAUDE_CONFIG_DIR: scratch, XDG_CONFIG_HOME: join(scratch, ".config"), ...loginEnv(login), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: options.timeoutMs ?? LOGIN_STATUS_MS,
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (out.length < 64 * 1024) out += chunk;
      });
      child.once("error", reject);
      // The CLI exits 1 when signed out, its answer said all the same.
      child.once("close", () => resolve(out));
    });
    const status = parseLoginStatus(stdout.trim());
    if (!status) throw new Error("the claude CLI gave no login status");
    return status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Start the CLI's own sign-in at `login` (`auth login`): it opens a browser on this machine and keeps what it gets in its
 *  own files. Nothing of it is read here: its output goes nowhere, and it is ended after `timeoutMs`. */
export function startClaudeLogin(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; home?: string; display?: Readonly<Record<string, string | undefined>> } = {}): void {
  const scratch = mkdtempSync(join(tmpdir(), "agentrun-claude-login-"));
  // What a browser needs to open on this desktop, when the server has it.
  const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER"].flatMap((name) => {
    const value = options.display?.[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
  const child = spawn(cli, ["auth", "login", "--claudeai"], {
    env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: options.home ?? scratch, CLAUDE_CONFIG_DIR: scratch, ...display, ...loginEnv(login), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
    stdio: "ignore",
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
  child.once("error", () => {});
  child.once("close", () => rmSync(scratch, { recursive: true, force: true }));
}

/** A model response's usage, as Anthropic's stream says it (`message_start`, then `message_delta`). */
type StreamUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** How a session on a login books its requests: no proxy sees them, so each response the CLI streams is booked from its
 *  own events, billed to the plan, at no price here. Admitted at its `message_start` (a refusal, a turn limit say, stops
 *  the drive: `halt`) and booked at its `message_stop`; one the turn's end leaves open is booked as it stands. */
export function loginBooking(models: Pick<ModelPort, "beforeRequest" | "afterRequest">, model: string, halt: (error: Error) => void) {
  let open: { ticket: Promise<unknown>; usage: Omit<ModelUsage, "usd"> } | undefined;
  let booked: Promise<void> = Promise.resolve();
  const book = () => {
    const entry = open;
    open = undefined;
    if (!entry) return;
    booked = booked.then(async () => {
      const refused = Symbol("refused");
      const ticket = await entry.ticket.catch(() => refused);
      // Refused at its admission: nothing to book (the drive is halted already).
      if (ticket === refused) return;
      await models.afterRequest({ ...entry.usage, usd: null, billing: "plan" }, ticket as Parameters<ModelPort["afterRequest"]>[1], { end: "answered", usd: null });
    }).catch((error: unknown) => halt(error instanceof Error ? error : new Error(String(error))));
  };
  const take = (usage: Omit<ModelUsage, "usd">, given: StreamUsage | undefined) => {
    const input = count(given?.input_tokens);
    const output = count(given?.output_tokens);
    const cacheRead = count(given?.cache_read_input_tokens);
    const cacheWrite = count(given?.cache_creation_input_tokens);
    return { ...usage, ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), ...(cacheRead === undefined ? {} : { cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWrite }) };
  };
  return {
    /** One message of the SDK's stream. */
    observe(message: unknown): void {
      const m = message as { type?: string; event?: { type?: string; message?: { usage?: StreamUsage }; usage?: StreamUsage } };
      if (m?.type !== "stream_event" || !m.event) return;
      const event = m.event;
      if (event.type === "message_start") {
        book();
        const ticket = (async () => models.beforeRequest({ model }))();
        ticket.catch((error: unknown) => halt(error instanceof Error ? error : new Error(String(error))));
        open = { ticket, usage: take({ input: 0, output: 0, billing: "plan" }, event.message?.usage) };
      } else if (event.type === "message_delta" && open) {
        open.usage = take(open.usage, event.usage);
      } else if (event.type === "message_stop") {
        book();
      }
    },
    /** Book what is open and wait for every booking to be written. */
    async settle(): Promise<void> {
      book();
      await booked;
    },
  };
}
