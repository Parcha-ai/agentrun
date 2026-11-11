// The server's own secrets, as one list: its API token, its sign-in sessions' secret, its outbound webhook's signing
// secret, and every value a trigger source keeps sealed (sealed-settings-store.ts). Each source is added as a reader, so a
// secret made or rotated since is in the list at once. With the host's, they are the one list a server never shows
// (server.ts serverSecrets): what a run shows, what learning keeps, what the server answers and what an import writes are
// cut of it; none of them assembles its own. The trigger settings are store rows (server-secrets-store.ts); what stays
// beside the store in the data directory is read here (besideTheStore), by the server and by a runner that shares it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_FILE } from "./files.js";
import { SESSION_SECRET_FILE } from "./owner.js";
import { secretForms } from "./standard-webhooks.js";
import { webhookSecretIn } from "./webhooks.js";

export class ServerSecrets {
  private readonly sources = new Map<string, () => readonly string[]>();
  /** Sources whose every value is listed as it is, of any length and whitespace and all: a PEM key's lines and whole. */
  private readonly whole = new Set<string>();

  /** A store's secrets, read at each use; one added again under the same name takes its place. `whole`: each value is
   *  listed whatever its length or whitespace (a PEM key's short last line, the key with its line breaks). */
  add(name: string, read: () => readonly string[], { whole = false }: { whole?: boolean } = {}): void {
    this.sources.set(name, read);
    if (whole) this.whole.add(name);
    else this.whole.delete(name);
  }

  /** Every secret held now, once each: of 8 characters or more and no whitespace, so no word is cut as one. A signing
   *  secret's key, after `whsec_`, signs alone and is pasted alone, which its `whsec_` form never matches: each is listed
   *  in every spelling of it (standard-webhooks.ts secretForms). */
  values(): string[] {
    const all = [...this.sources].filter(([name]) => !this.whole.has(name)).flatMap(([, read]) => read()).flatMap(secretForms);
    const whole = [...this.sources].filter(([name]) => this.whole.has(name)).flatMap(([, read]) => read()).filter((value) => value.length > 0);
    return [...new Set([...all.filter((value) => value.length >= 8 && !/\s/.test(value)), ...whole])];
  }
}

/** The file `name` in `data`, trimmed; empty when it is not there. */
const fileIn = (data: string, name: string): string => {
  try {
    return readFileSync(join(data, name), "utf8").trim();
  } catch {
    return "";
  }
};

/** The server's own secrets data directory `data` keeps beside the store: the owner's API token and the sign-in session
 *  secret (files the CLI and the console's sign-in read), and the outbound webhook's signing secret, opened with the
 *  server's seal key `key` (a secret that does not open is left out). Each file is read until it is there, then kept: they
 *  are made once, and a redaction reads the list often. */
export function besideTheStore(data: string, key: Buffer): ServerSecrets {
  const secrets = new ServerSecrets();
  const read = new Map<string, string>();
  const kept = (name: string) => read.get(name) || (read.set(name, fileIn(data, name)), read.get(name)!);
  secrets.add("files", () => [kept(TOKEN_FILE), kept(SESSION_SECRET_FILE)]);
  const webhook = webhookSecretIn(data, key);
  secrets.add("webhook", () => (webhook && "secret" in webhook ? [webhook.secret] : []));
  return secrets;
}
