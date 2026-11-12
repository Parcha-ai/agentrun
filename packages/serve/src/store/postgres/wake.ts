// NOTIFY and LISTEN: a Postgres store's command wire (command-wake.ts) to the other processes on its schema. A wake goes
// out right after its write's commit, as pg_notify on the schema's channel through the store's pool. A handle that listens
// holds ONE client of its own LISTENing on that channel: opened at its first listener, ended WAKE_LINGER_MS after its last
// one goes (a server watches for each call it sends, and a client opened per call would miss the answers that come before
// its LISTEN) and at the store's close, connected again a while after an error or an end. A wake lost meanwhile costs a
// reader its poll.
import { createHash } from "node:crypto";
import type pg from "pg";
import type { CommandWire } from "../command-wake.js";

/** How long the listening client waits to connect again after it failed or ended (ms). */
export const WAKE_RECONNECT_MS = 1_000;
/** How long the listening client stays open with no listener, for the next one (ms). */
export const WAKE_LINGER_MS = 60_000;

/** The schema's wake channel: "agentrun_commands_<schema>", or, for a schema too long for a channel name (63 bytes), the
 *  same prefix and a hash of it. */
export function wakeChannel(schema: string): string {
  const named = `agentrun_commands_${schema}`;
  return named.length <= 63 ? named : `agentrun_commands_${createHash("sha256").update(schema).digest("hex").slice(0, 40)}`;
}

export class PgWake implements CommandWire {
  readonly #channel: string;
  /** A new client for the LISTEN, not connected yet. */
  readonly #client: () => pg.Client;
  /** Sends one NOTIFY: the connection's pool, after the commit. */
  readonly #notify: (channel: string, text: string) => Promise<unknown>;
  readonly #hearers = new Set<(text: string) => void>();
  #listening: pg.Client | undefined;
  #reconnect: NodeJS.Timeout | undefined;
  /** The end of the listening client once no one listens (WAKE_LINGER_MS). */
  #linger: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(channel: string, client: () => pg.Client, notify: (channel: string, text: string) => Promise<unknown>) {
    this.#channel = channel;
    this.#client = client;
    this.#notify = notify;
  }

  send(text: string): void {
    if (this.#closed) return;
    this.#notify(this.#channel, text).catch(() => undefined);
  }

  listen(hear: (text: string) => void): () => void {
    this.#hearers.add(hear);
    clearTimeout(this.#linger);
    this.#linger = undefined;
    if (this.#hearers.size === 1) this.#connect();
    return () => {
      if (!this.#hearers.delete(hear) || this.#hearers.size > 0 || this.#closed) return;
      clearTimeout(this.#linger);
      this.#linger = setTimeout(() => {
        this.#linger = undefined;
        if (this.#hearers.size === 0) void this.#stop();
      }, WAKE_LINGER_MS);
      this.#linger.unref();
    };
  }

  #connect(): void {
    if (this.#closed || this.#listening !== undefined || this.#hearers.size === 0) return;
    const client = this.#client();
    this.#listening = client;
    client.on("notification", (message) => {
      if (this.#listening !== client || message.channel !== this.#channel || message.payload === undefined) return;
      for (const hear of [...this.#hearers]) hear(message.payload);
    });
    client.on("error", () => this.#lost(client));
    client.on("end", () => this.#lost(client));
    client.connect()
      .then(() => client.query(`LISTEN "${this.#channel}"`))
      .then(() => {
        // A listener alone never keeps the process up.
        (client as unknown as { connection?: { stream?: { unref?(): void } } }).connection?.stream?.unref?.();
      })
      .catch(() => this.#lost(client));
  }

  /** The listening client failed or ended: let go, and connected again in a while while anyone listens. */
  #lost(client: pg.Client): void {
    if (this.#listening !== client) return;
    this.#listening = undefined;
    client.end().catch(() => undefined);
    if (this.#closed || this.#hearers.size === 0 || this.#reconnect !== undefined) return;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      this.#connect();
    }, WAKE_RECONNECT_MS);
    this.#reconnect.unref();
  }

  #stop(): Promise<void> {
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    clearTimeout(this.#linger);
    this.#linger = undefined;
    const client = this.#listening;
    this.#listening = undefined;
    return client === undefined ? Promise.resolve() : client.end().catch(() => undefined);
  }

  /** Ends the listening client; sends nothing more. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#hearers.clear();
    await this.#stop();
  }
}
