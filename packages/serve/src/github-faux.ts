// A fake GitHub for a server started with --faux and --faux-github: an App already connected, served by GitHub's API as an
// in-process server on loopback, so the console's GitHub flows (Settings → GitHub connected, a github trigger made, a
// signed delivery fired) run in a real browser with nothing sent to GitHub. It answers the API calls the server makes of
// the App (github.ts, github-connection.ts): the App's installations, one installation's read, an installation token's
// mint narrowed to the repositories asked, that token's read of the repositories it covers and its revoke, and which
// installation covers a repository. And what a suggested agent's create writes (suggestions.ts, github-pull-request.ts):
// a repository's read, its default branch's head, which files it has, a tree, a commit, a branch and a pull request,
// each kept in memory and read back whole at GET /_faux/state, where a test or a person sees what a create pushed. The
// installation holds contents write, as an App connected with `contents: write` does; POST /_faux/permissions sets what
// it holds, so a test (or a demo) shows a create refused for a permission. The App, its private key and its webhook
// secret are made fresh at each start; a test signs a delivery with the webhook secret, kept beside the data
// (FAUX_GITHUB_FILE). Never on a server without --faux.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The file beside the data that tells a test the fake App's webhook secret, installation and repositories. */
export const FAUX_GITHUB_FILE = "faux-github.json";
/** The fake App's one installation and the repositories it covers. */
export const FAUX_GITHUB: { appId: string; slug: string; installation: number; account: string; repositories: readonly string[] } = { appId: "1", slug: "agentrun-faux", installation: 1, account: "faux-org", repositories: ["faux-org/demo"] };

export type FauxGitHub = {
  /** Its API's base, which the server's Connect GitHub asks in place of GitHub's own; never a URL anyone gives. */
  url: string;
  /** GitHub's site as a checkout fetches from it (runner/pr-checkout.ts `web`): a folder of bare repositories on this
   *  machine holding the fake's one repository, so a run's checkout of it never leaves the machine. Undefined when the
   *  start was given no folder for it. */
  web?: string;
  /** The App as Connect GitHub keeps it (github-connection.ts GitHubConnection.save). */
  app: { id: string; slug: string; clientId: string; pem: string; webhookSecret: string; settingsUrl: string };
  close(): Promise<void>;
};

const TOKEN_MS = 60 * 60_000;

/** The fake repository's files on its default branch: what its contents API answers, and what its bare repository holds
 *  (a small help desk whose support queue and refunds a person works by hand, for a scan to find). */
export const FAUX_REPO_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Demo shop\n\nA help desk and billing app for small shops.\n",
  "package.json": `${JSON.stringify({ name: "demo-shop", private: true, type: "module" }, null, 2)}\n`,
  "src/support/inbox.ts": `${Array.from({ length: 41 }, (_, i) => `// inbox line ${i + 1}`).join("\n")}\nexport const saved = (ticket: { subject: string; body: string }) => ({ ...ticket, status: "needs_triage" }); // a person sets category and priority\n`,
  "src/support/classify.ts": "// Keyword rules for a ticket's category.\nexport function classify(text: string): string {\n  if (/refund|invoice/i.test(text)) return \"billing\";\n  return \"other\";\n}\n",
  "app/refunds.py": "def request_refund(refund):\n    refund.status = 'pending_review'  # someone in ops reads it\n    return refund\n",
};

/** The fake repository as a bare git repository under `dir` (<dir>/<owner>/<name>.git), one commit on main: what a run's
 *  checkout fetches with `web` set to file://<dir>. Undefined, with the folder left empty, where git does not run. */
function bareRepository(dir: string): string | undefined {
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "faux", GIT_AUTHOR_EMAIL: "faux@example.invalid", GIT_COMMITTER_NAME: "faux", GIT_COMMITTER_EMAIL: "faux@example.invalid" };
  const work = join(dir, ".work");
  try {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, text] of Object.entries(FAUX_REPO_FILES)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "The demo shop");
    const bare = join(dir, `${FAUX_GITHUB.repositories[0]!}.git`);
    mkdirSync(dirname(bare), { recursive: true });
    git(dir, "clone", "-q", "--bare", work, bare);
    return `file://${dir}`;
  } catch {
    return undefined;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Starts the fake GitHub API on loopback, with its App; with `webDir`, its repository as a bare git repository there. */
export async function startFauxGitHub({ webDir }: { webDir?: string } = {}): Promise<FauxGitHub> {
  const web = webDir ? bareRepository(webDir) : undefined;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: FAUX_GITHUB.appId, slug: FAUX_GITHUB.slug, clientId: `Iv1.faux${randomBytes(6).toString("hex")}`, pem: privateKey, webhookSecret: randomBytes(24).toString("hex"), settingsUrl: `https://github.com/organizations/${FAUX_GITHUB.account}/settings/apps/${FAUX_GITHUB.slug}` };
  const installation = { id: FAUX_GITHUB.installation, account: { login: FAUX_GITHUB.account, type: "Organization" }, app_id: Number(FAUX_GITHUB.appId), suspended_at: null, permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "read" } as Record<string, string> };
  // Each repository the installation covers, on its default branch main: its files at one commit, and what writes add.
  const sha = (text: string) => createHash("sha1").update(text).digest("hex");
  const BASE = sha("faux-base");
  const files = new Set(Object.keys(FAUX_REPO_FILES));
  const state = { branches: new Map<string, string>([["main", BASE]]), trees: new Map<string, unknown>(), commits: new Map<string, unknown>(), pulls: [] as { number: number; title: string; head: string; base: string; body: string; html_url: string; repo: string }[] };
  /** Each token minted, by its value: the repositories it was narrowed to (by name), or every one the installation covers. */
  const tokens = new Map<string, string[] | undefined>();
  /** How many tokens were minted, revoked ones too: what a test reads to see the App was never used. */
  let minted = 0;
  const covered = (names: string[] | undefined) => FAUX_GITHUB.repositories.filter((full) => !names || names.includes(full.split("/")[1]!));
  const answer = (res: ServerResponse, status: number, doc?: unknown) => {
    res.writeHead(status, doc === undefined ? {} : { "content-type": "application/json" });
    res.end(doc === undefined ? undefined : JSON.stringify(doc));
  };
  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && path === "/app/installations") return answer(res, 200, [installation]);
    if (req.method === "GET" && path === `/app/installations/${installation.id}`) return answer(res, 200, installation);
    if (req.method === "POST" && path === `/app/installations/${installation.id}/access_tokens`) {
      let asked: { repositories?: unknown } = {};
      try {
        asked = JSON.parse(body || "{}") as { repositories?: unknown };
      } catch {
        return answer(res, 400, { message: "Problems parsing JSON" });
      }
      const names = Array.isArray(asked.repositories) ? asked.repositories.filter((name): name is string => typeof name === "string") : undefined;
      if (names && covered(names).length !== names.length) return answer(res, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const token = `faux-installation-token-${randomBytes(16).toString("hex")}`;
      tokens.set(token, names);
      minted++;
      return answer(res, 201, { token, expires_at: new Date(Date.now() + TOKEN_MS).toISOString(), permissions: { ...installation.permissions }, repository_selection: "selected" });
    }
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.method === "GET" && path === "/installation/repositories") {
      if (!tokens.has(bearer)) return answer(res, 401, { message: "Bad credentials" });
      const full = covered(tokens.get(bearer));
      return answer(res, 200, { total_count: full.length, repositories: full.map((name) => ({ name: name.split("/")[1], full_name: name })) });
    }
    if (req.method === "DELETE" && path === "/installation/token") {
      if (!tokens.delete(bearer)) return answer(res, 401, { message: "Bad credentials" });
      return answer(res, 204);
    }
    const repo = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (req.method === "GET" && repo) return FAUX_GITHUB.repositories.includes(`${repo[1]}/${repo[2]}`) ? answer(res, 200, installation) : answer(res, 404, { message: "Not Found" });
    // What a test or a demo reads and sets of the fake: everything written, and the installation's permissions.
    if (req.method === "GET" && path === "/_faux/state") return answer(res, 200, { permissions: installation.permissions, branches: Object.fromEntries(state.branches), commits: Object.fromEntries(state.commits), trees: Object.fromEntries(state.trees), pulls: state.pulls, minted });
    if (req.method === "POST" && path === "/_faux/permissions") {
      try {
        installation.permissions = { ...installation.permissions, ...(JSON.parse(body || "{}") as Record<string, string>) };
      } catch {
        return answer(res, 400, { message: "Problems parsing JSON" });
      }
      return answer(res, 200, installation.permissions);
    }
    // A repository's reads and writes, each with a token of the installation narrowed to it (or covering every one).
    const on = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (on && FAUX_GITHUB.repositories.includes(`${on[1]}/${on[2]}`)) {
      const full = `${on[1]}/${on[2]}`;
      const rest = on[3] ?? "";
      if (!tokens.has(bearer) || !covered(tokens.get(bearer)).includes(full)) return answer(res, 404, { message: "Not Found" });
      const writes = installation.permissions.contents === "write";
      const json = (): Record<string, unknown> => { try { return JSON.parse(body || "{}") as Record<string, unknown>; } catch { return {}; } };
      if (req.method === "GET" && rest === "") return answer(res, 200, { full_name: full, private: true, default_branch: "main" });
      const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
      if (req.method === "GET" && ref) return state.branches.has(decodeURIComponent(ref[1]!)) ? answer(res, 200, { ref: `refs/heads/${decodeURIComponent(ref[1]!)}`, object: { sha: state.branches.get(decodeURIComponent(ref[1]!)), type: "commit" } }) : answer(res, 404, { message: "Not Found" });
      const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (req.method === "GET" && commit) return commit[1] === BASE ? answer(res, 200, { sha: BASE, tree: { sha: sha("faux-base-tree") } }) : state.commits.has(commit[1]!) ? answer(res, 200, state.commits.get(commit[1]!)) : answer(res, 404, { message: "Not Found" });
      const content = /^\/contents\/(.+)$/.exec(rest);
      if (req.method === "GET" && content) return files.has(decodeURIComponent(content[1]!)) ? answer(res, 200, { type: "file", path: decodeURIComponent(content[1]!) }) : answer(res, 404, { message: "Not Found" });
      // Writes: GitHub answers an installation that can't write contents 403 ("Resource not accessible by integration").
      if (req.method === "POST" && (rest === "/git/trees" || rest === "/git/commits" || rest === "/git/refs") && !writes) return answer(res, 403, { message: "Resource not accessible by integration" });
      if (req.method === "POST" && rest === "/git/trees") {
        const made = sha(`tree ${body}`);
        state.trees.set(made, json());
        return answer(res, 201, { sha: made });
      }
      if (req.method === "POST" && rest === "/git/commits") {
        const asked = json();
        const made = sha(`commit ${body}`);
        state.commits.set(made, { sha: made, tree: { sha: asked.tree }, message: asked.message, parents: asked.parents });
        return answer(res, 201, { sha: made });
      }
      if (req.method === "POST" && rest === "/git/refs") {
        const asked = json();
        const name = String(asked.ref ?? "").replace(/^refs\/heads\//, "");
        if (state.branches.has(name)) return answer(res, 422, { message: "Reference already exists" });
        state.branches.set(name, String(asked.sha));
        return answer(res, 201, { ref: asked.ref, object: { sha: asked.sha } });
      }
      const gone = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
      if (req.method === "DELETE" && gone) return state.branches.delete(decodeURIComponent(gone[1]!)) ? answer(res, 204) : answer(res, 422, { message: "Reference does not exist" });
      if (req.method === "POST" && rest === "/pulls") {
        if (installation.permissions.pull_requests !== "write") return answer(res, 403, { message: "Resource not accessible by integration" });
        const asked = json();
        if (!state.branches.has(String(asked.head))) return answer(res, 422, { message: "Validation Failed" });
        if (state.pulls.some((p) => p.repo === full && p.head === asked.head)) return answer(res, 422, { message: "A pull request already exists" });
        const number = state.pulls.length + 1;
        const pull = { number, title: String(asked.title), head: String(asked.head), base: String(asked.base), body: String(asked.body), html_url: `https://github.com/${full}/pull/${number}`, repo: full };
        state.pulls.push(pull);
        return answer(res, 201, pull);
      }
      if (req.method === "GET" && rest === "/pulls") {
        const head = new URL(req.url ?? "/", "http://faux").searchParams.get("head")?.split(":")[1];
        return answer(res, 200, state.pulls.filter((p) => p.repo === full && (!head || p.head === head)));
      }
    }
    return answer(res, 404, { message: "Not Found" });
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk)).on("end", () => handle(req, res, body));
  });
  const host = "127.0.0.1";
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, host, () => resolve()));
  return {
    url: `http://${host}:${(server.address() as AddressInfo).port}`,
    ...(web ? { web } : {}),
    app,
    close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
