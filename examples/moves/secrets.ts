// The two named Modal Secrets the VM takes its keys from, made by the live runner and removed by its sweep. The Modal SDK has no call that creates a named Secret, so
// the Modal Python client does it (`modal.Secret.objects.create`, in a one-line program), with the entries as JSON on its standard input. (`modal secret create --from-dotenv` cannot
// take a pipe: it insists on a regular file.) No value is ever on an argument list or in a file, and the program's own environment holds only the token that opens it. What it printed
// is shown only with the values taken out of it.
import { spawn } from "node:child_process";

type Client = { secrets: { fromName(name: string, params?: { requiredKeys?: string[] }): Promise<unknown>; delete(name: string, params?: { allowMissing?: boolean }): Promise<void> } };

const notFound = (error: unknown) => (error as { constructor?: { name?: string } })?.constructor?.name === "NotFoundError" || (error as { code?: unknown })?.code === "NOT_FOUND";
/** The program: the Secret's name is its one argument, the entries are the JSON on stdin. It refuses a name that exists (allow_existing stays false). */
const PROGRAM = "import json, sys, modal; modal.Secret.objects.create(sys.argv[1], json.load(sys.stdin))";

/** What the command said, with every value taken out of it. */
function clean(text: string, values: readonly string[]): string {
  return values.filter((value) => value.length > 0).reduce((out, value) => out.replaceAll(value, "<value>"), text).replace(/\s+/g, " ").trim().slice(-300);
}

/**
 * Make the Secret `name` holding `entries`. Refuses a name that already exists (a Secret made by someone else is never overwritten, and `beforeCreate` is not called for it, so it is never deleted either), and fails loudly if the program fails or makes a Secret without all the keys: the Secret is read back by key name, never by value.
 */
export async function createSecret(client: Client, name: string, entries: Record<string, string>, token: { id: string; secret: string }, beforeCreate?: () => void): Promise<void> {
  const exists = await client.secrets.fromName(name).then(() => true, (error: unknown) => { if (notFound(error)) return false; throw error; });
  if (exists) throw new Error(`a Modal Secret named ${name} already exists: this runner makes its own and never overwrites one`);
  // From here the name is this runner's to clean up, made or not: the caller hears of it before the program runs.
  beforeCreate?.();
  const values = [...Object.values(entries), token.id, token.secret];
  const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.env.MOVES_MODAL_PYTHON ?? "python3", ["-c", PROGRAM, name], {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "", MODAL_TOKEN_ID: token.id, MODAL_TOKEN_SECRET: token.secret },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (error) => reject(new Error(`the Modal Python client could not start (${clean(String(error.message), values)}): pip install modal for the python3 on the PATH (or name one in MOVES_MODAL_PYTHON), or make the Secrets first and use MOVES_LIVE_SECRETS=existing`)));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.on("error", () => { /* the command ended before it read: its exit code says why */ });
    child.stdin.end(JSON.stringify(entries));
  });
  if (result.code !== 0) throw new Error(`creating the Secret ${name} exited ${result.code}: ${clean(result.out, values)}`);
  await client.secrets.fromName(name, { requiredKeys: Object.keys(entries) }).catch((error: unknown) => { throw new Error(`the Secret ${name} was made without its keys: ${clean(String((error as Error).message), values)}`); });
}

/** Delete the Secret `name`, then ask for it by name: gone only if Modal says it is not found. */
export async function removeSecret(client: Client, name: string): Promise<{ deleted: boolean; gone: boolean; error?: string }> {
  let error: string | undefined;
  const deleted = await client.secrets.delete(name, { allowMissing: true }).then(() => true, (cause: unknown) => { error = String((cause as Error).message).slice(0, 160); return false; });
  const gone = await client.secrets.fromName(name).then(() => false, (cause: unknown) => notFound(cause));
  return { deleted, gone, ...(error === undefined ? {} : { error }) };
}
