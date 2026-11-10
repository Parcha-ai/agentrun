// A fake GitHub for a server started with --faux and --faux-github: an App already connected, served by GitHub's API as an
// in-process server on loopback, so the console's GitHub flows (Settings → GitHub connected, a github trigger made, a
// signed delivery fired) run in a real browser with nothing sent to GitHub. It answers the API calls the server makes of
// the App (github.ts, github-connection.ts): the App's installations, one installation's read, an installation token's
// mint narrowed to the repositories asked, that token's read of the repositories it covers and its revoke, and which
// installation covers a repository. The App, its private key and its webhook secret are made fresh at each start; a test
// signs a delivery with the webhook secret, kept beside the data (FAUX_GITHUB_FILE). Never on a server without --faux.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The file beside the data that tells a test the fake App's webhook secret, installation and repositories. */
export const FAUX_GITHUB_FILE = "faux-github.json";
/** The fake App's one installation and the repositories it covers. */
export const FAUX_GITHUB: { appId: string; slug: string; installation: number; account: string; repositories: readonly string[] } = { appId: "1", slug: "agentrun-faux", installation: 1, account: "faux-org", repositories: ["faux-org/demo"] };

export type FauxGitHub = {
  /** Its API's base, which the server's Connect GitHub asks in place of GitHub's own; never a URL anyone gives. */
  url: string;
  /** The App as Connect GitHub keeps it (github-connection.ts GitHubConnection.save). */
  app: { id: string; slug: string; clientId: string; pem: string; webhookSecret: string; settingsUrl: string };
  close(): Promise<void>;
};

const TOKEN_MS = 60 * 60_000;

/** Starts the fake GitHub API on loopback, with its App. */
export async function startFauxGitHub(): Promise<FauxGitHub> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: FAUX_GITHUB.appId, slug: FAUX_GITHUB.slug, clientId: `Iv1.faux${randomBytes(6).toString("hex")}`, pem: privateKey, webhookSecret: randomBytes(24).toString("hex"), settingsUrl: `https://github.com/organizations/${FAUX_GITHUB.account}/settings/apps/${FAUX_GITHUB.slug}` };
  const installation = { id: FAUX_GITHUB.installation, account: { login: FAUX_GITHUB.account, type: "Organization" }, app_id: Number(FAUX_GITHUB.appId), suspended_at: null };
  /** Each token minted, by its value: the repositories it was narrowed to (by name), or every one the installation covers. */
  const tokens = new Map<string, string[] | undefined>();
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
      return answer(res, 201, { token, expires_at: new Date(Date.now() + TOKEN_MS).toISOString(), permissions: { metadata: "read", contents: "read", pull_requests: "write", issues: "read" }, repository_selection: "selected" });
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
    return answer(res, 404, { message: "Not Found" });
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk)).on("end", () => handle(req, res, body));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    app,
    close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
