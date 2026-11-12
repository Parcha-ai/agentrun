// GitHub's site as a test's git client sees it, on loopback: git's own smart HTTP server (git http-backend, as CGI) over a
// folder of bare repositories (<root>/<owner>/<name>.git), and a folder of them to make. A request without the
// Authorization a test asks for answers 401, as GitHub answers a private repository's anonymous fetch. Each request's
// method, path and Authorization are kept, for a test to read what the client sent.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/** git, run in `cwd` with no config of this machine's. */
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

/** A pull request's history in `root`/<owner>/<name>.git: `shared` commits on main, then `ahead` commits on a branch (its
 *  head, which adds `README.md`), then `behind` more on main (its base). The merge base is the last shared commit. */
export function pullRepo(root, repo, { shared = 3, ahead = 2, behind = 2 } = {}) {
  const work = join(root, `${repo.replace("/", "-")}-work`);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  const commit = (file, text) => {
    execFileSync("sh", ["-c", 'printf "%s\\n" "$2" > "$1"', "sh", file, text], { cwd: work });
    git(work, "add", file);
    git(work, "commit", "-q", "-m", `${file}: ${text}`);
  };
  for (let i = 0; i < shared; i++) commit("main.txt", `shared ${i}`);
  const mergeBase = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feature");
  for (let i = 0; i < ahead; i++) commit("README.md", `the head's readme ${i}`);
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  for (let i = 0; i < behind; i++) commit("main.txt", `base ${i}`);
  const base = git(work, "rev-parse", "HEAD");
  const bare = join(root, `${repo}.git`);
  mkdirSync(join(bare, ".."), { recursive: true });
  git(root, "clone", "-q", "--bare", work, bare);
  return { head, base, mergeBase, bare };
}

/** A git smart HTTP server over the bare repositories under `root`; `authorization` (when given) is the one header it
 *  takes, or a check of the header. Closed after test `t`. */
export async function gitHttp(t, root, { authorization } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    const given = req.headers.authorization;
    const ok = authorization === undefined || (typeof authorization === "function" ? authorization(given) : given === authorization);
    if (!ok) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end();
      req.resume();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      },
    });
    req.pipe(child.stdin);
    child.stdin.on("error", () => {});
    let head = Buffer.alloc(0);
    let headed = false;
    child.stdout.on("data", (chunk) => {
      if (headed) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const crlf = head.indexOf("\r\n\r\n");
      const lf = head.indexOf("\n\n");
      const end = crlf >= 0 ? crlf : lf;
      if (end < 0) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        const [name, value] = [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      headed = true;
      res.write(head.subarray(end + (crlf >= 0 ? 4 : 2)));
    });
    child.stdout.on("end", () => res.end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
